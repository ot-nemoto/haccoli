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
