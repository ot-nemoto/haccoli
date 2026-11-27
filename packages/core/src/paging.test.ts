import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "./errors.js";
import { type PageFetch, readPage } from "./paging.js";

const item = (n: number) => ({ PK: `USER#${n}`, SK: "PROFILE", n });
const isValidKey = (key: { PK: string; SK: string }) => key.PK.startsWith("USER#");

/** DynamoDB の応答を順に返す（フィルタで空になった応答を含む） */
function responses(...pages: { items: number[]; more: boolean }[]): PageFetch {
  const fetch = vi.fn<PageFetch>();
  pages.forEach((p, i) => {
    fetch.mockResolvedValueOnce({
      Items: p.items.map(item),
      ...(p.more ? { LastEvaluatedKey: { PK: `END#${i}`, SK: "x" } } : {}),
    });
  });
  return fetch;
}

describe("readPage", () => {
  it("フィルタで空になった応答は読み飛ばし、指定件数に達するまで読み進める", async () => {
    const fetch = responses(
      { items: [], more: true },
      { items: [1], more: true },
      { items: [], more: true },
      { items: [2, 3], more: false },
    );
    const page = await readPage(fetch, { limit: 2, isValidKey });
    expect(page.items.map((i) => i.n)).toEqual([1, 2]);
    expect(fetch).toHaveBeenCalledTimes(4);
    // 次のページは、このページの最後のアイテムの次から
    const next = await readPage(responses({ items: [3], more: false }), {
      limit: 2,
      cursor: page.cursor,
      isValidKey,
    });
    expect(next).toEqual({ items: [item(3)] });
  });

  it("カーソルはこのページの最後のアイテムのキー", async () => {
    const fetch = responses({ items: [1, 2, 3], more: false }, { items: [4], more: false });
    const first = await readPage(fetch, { limit: 2, isValidKey });
    await readPage(fetch, { limit: 2, cursor: first.cursor, isValidKey });
    expect(vi.mocked(fetch).mock.calls[1]?.[0]).toEqual({ PK: "USER#2", SK: "PROFILE" });
  });

  it("最後まで読んで指定件数以下なら、次のページはない（空の次ページを返さない）", async () => {
    const page = await readPage(
      responses({ items: [1, 2], more: true }, { items: [], more: false }),
      {
        limit: 2,
        isValidKey,
      },
    );
    expect(page).toEqual({ items: [item(1), item(2)] });
  });

  it("不正なカーソル・件数は拒否する", async () => {
    const fetch = responses({ items: [], more: false });
    const bad = (cursor: string) => readPage(fetch, { cursor, isValidKey });
    await expect(bad("not-json")).rejects.toBeInstanceOf(ValidationError);
    const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    // 別の種類のアイテムから読み始めさせない
    await expect(bad(encode({ PK: "ATTEMPT#x", SK: "META" }))).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(bad(encode({ PK: "USER#x", SK: "PROFILE", extra: 1 }))).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(readPage(fetch, { limit: 0, isValidKey })).rejects.toBeInstanceOf(ValidationError);
    await expect(readPage(fetch, { limit: 101, isValidKey })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
