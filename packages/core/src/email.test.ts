import { describe, expect, it } from "vitest";
import { normalizeEmail } from "./email.js";

describe("normalizeEmail", () => {
  it("前後空白を除去して小文字化する", () => {
    expect(normalizeEmail("  Taro.Yamada@Example.CO.JP ")).toBe("taro.yamada@example.co.jp");
  });

  it.each(["", "foo", "foo@bar", "a b@example.com"])("不正な形式 %j はエラー", (v) => {
    expect(() => normalizeEmail(v)).toThrow();
  });
});
