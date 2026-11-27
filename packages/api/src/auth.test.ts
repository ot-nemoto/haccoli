import { describe, expect, it } from "vitest";
import { ensureOwned, parseGroups } from "./auth.js";
import { ApiError } from "./errors.js";

describe("parseGroups", () => {
  it.each([
    [["candidate"], ["candidate"]],
    ["[candidate]", ["candidate"]],
    ["[candidate grader]", ["candidate", "grader"]],
    ["candidate,grader", ["candidate", "grader"]],
    ["[]", []],
    [undefined, []],
    [123, []],
  ])("%j → %j", (raw, expected) => {
    expect(parseGroups(raw)).toEqual(expected);
  });
});

describe("ensureOwned", () => {
  const user = { sub: "me", name: "x", roles: ["candidate" as const] };

  it("所有者なら通す", () => {
    expect(() => ensureOwned("me", user)).not.toThrow();
    expect(() => ensureOwned(["other", "me"], user)).not.toThrow();
  });

  it("他人のリソースは存在を隠して 404", () => {
    try {
      ensureOwned(["other"], user);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(404);
    }
  });
});
