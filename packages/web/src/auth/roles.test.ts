import { describe, expect, it } from "vitest";
import { safeReturnPath } from "./roles.js";

describe("safeReturnPath", () => {
  it.each([
    ["/exam/abc", "/exam/abc"],
    ["/exam", "/exam"],
    ["/examx", "/exam"],
    ["/grader", "/exam"],
    ["https://evil.example.com/exam", "/exam"],
    ["//evil.example.com/exam", "/exam"],
    ["/exam//evil.example.com", "/exam"],
    [undefined, "/exam"],
    [123, "/exam"],
  ])("候補者: %j → %s", (from, expected) => {
    expect(safeReturnPath("candidate", from)).toBe(expected);
  });
});

describe("safeReturnPath（管理者）", () => {
  it.each([
    ["/admin/users", "/admin/users"],
    ["/admin", "/admin"],
    ["/administrator", "/admin"],
    ["/grader", "/admin"],
    ["/exam/abc", "/admin"],
  ])("%j → %s", (from, expected) => {
    expect(safeReturnPath("admin", from)).toBe(expected);
  });
});
