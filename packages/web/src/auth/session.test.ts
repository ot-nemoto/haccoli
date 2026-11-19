import { describe, expect, it } from "vitest";
import { createSession, decodeJwtPayload, isExpired } from "./session.js";

function fakeJwt(payload: object): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`;
}

describe("session", () => {
  const idToken = fakeJwt({
    sub: "sub-1",
    email: "cand@example.com",
    name: "山田 太郎",
    "cognito:groups": ["candidate"],
  });

  it("JWT ペイロード（マルチバイト含む）をデコードできる", () => {
    expect(decodeJwtPayload(idToken).name).toBe("山田 太郎");
  });

  it("ID トークンからユーザー情報とグループを取り出す", () => {
    const s = createSession({ idToken, accessToken: "a", expiresIn: 3600 }, 0);
    expect(s.user).toEqual({
      sub: "sub-1",
      email: "cand@example.com",
      name: "山田 太郎",
      groups: ["candidate"],
    });
    expect(s.expiresAt).toBe(3_600_000);
  });

  it("グループ未所属なら空配列", () => {
    const s = createSession({ idToken: fakeJwt({ sub: "x" }), accessToken: "a", expiresIn: 1 }, 0);
    expect(s.user.groups).toEqual([]);
  });

  it("期限の 1 分前から期限切れ扱い", () => {
    const s = createSession({ idToken, accessToken: "a", expiresIn: 3600 }, 0);
    expect(isExpired(s, 3_539_999)).toBe(false);
    expect(isExpired(s, 3_540_000)).toBe(true);
  });
});
