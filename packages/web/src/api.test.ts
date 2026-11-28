import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "./api.js";

function mockFetch(impl: () => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

const json = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );

describe("apiFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("/api 配下を Bearer トークン付きで呼び、JSON を返す", async () => {
    const fetch = mockFetch(() => json(200, { sub: "s", name: "n", role: "candidate" }));
    await expect(apiFetch("tok", "/me")).resolves.toEqual({
      sub: "s",
      name: "n",
      role: "candidate",
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/me");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("API のエラー本文の code / message を使う", async () => {
    mockFetch(() => json(403, { error: { code: "FORBIDDEN", message: "だめ" } }));
    await expect(apiFetch("tok", "/me")).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "だめ",
    });
  });

  it("オーソライザーの拒否（{message: Unauthorized}）は 401 / UNAUTHORIZED", async () => {
    mockFetch(() => json(401, { message: "Unauthorized" }));
    await expect(apiFetch("tok", "/me")).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });
  });

  it("blob で読むときは、本文をそのまま返す（BOM を残す）。エラーは JSON と同じく扱う", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
    mockFetch(() => Promise.resolve(new Response(bytes, { status: 200 })));
    const blob = await apiFetch<Blob>("tok", "/admin/exams/ex/results.csv", {}, "blob");
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([0xef, 0xbb, 0xbf, 0x61]);

    mockFetch(() => json(404, { error: { code: "NOT_FOUND", message: "課題が見つかりません" } }));
    await expect(apiFetch("tok", "/admin/exams/x/results.csv", {}, "blob")).rejects.toMatchObject({
      status: 404,
      message: "課題が見つかりません",
    });
  });

  it("JSON 以外のエラー本文は INTERNAL", async () => {
    mockFetch(() => Promise.resolve(new Response("<html>", { status: 502 })));
    await expect(apiFetch("tok", "/me")).rejects.toMatchObject({ status: 502, code: "INTERNAL" });
  });

  it("通信失敗は NETWORK", async () => {
    mockFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const err = await apiFetch("tok", "/me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: "NETWORK" });
  });
});
