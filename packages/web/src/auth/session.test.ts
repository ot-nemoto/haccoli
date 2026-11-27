import { describe, expect, it } from "vitest";
import { createSession, isExpired } from "./session.js";

describe("session", () => {
  const me = { sub: "sub-1", name: "山田 太郎", roles: ["grader" as const, "admin" as const] };
  const tokens = { idToken: "i", accessToken: "a", expiresIn: 3600 };

  it("/me の結果とログインした画面のロールを保持し、期限を計算する", () => {
    const s = createSession(tokens, me, "grader", 0);
    expect(s.user).toEqual(me);
    expect(s.role).toBe("grader");
    expect(s.expiresAt).toBe(3_600_000);
  });

  it("/me の余分な項目は保持しない", () => {
    const s = createSession(tokens, { ...me, email: "x@example.com" } as typeof me, "grader", 0);
    expect(s.user).toEqual(me);
  });

  it("期限の 1 分前から期限切れ扱い", () => {
    const s = createSession(tokens, me, "grader", 0);
    expect(isExpired(s, 3_539_999)).toBe(false);
    expect(isExpired(s, 3_540_000)).toBe(true);
  });
});
