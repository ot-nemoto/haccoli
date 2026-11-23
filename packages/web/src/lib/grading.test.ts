import { describe, expect, it } from "vitest";
import { scoreError } from "./grading.js";

describe("scoreError", () => {
  it("未入力・範囲内は undefined", () => {
    expect(scoreError(undefined, 10)).toBeUndefined();
    expect(scoreError(0, 10)).toBeUndefined();
    expect(scoreError(10, 10)).toBeUndefined();
    expect(scoreError(2.5, 10)).toBeUndefined();
    expect(scoreError(100, undefined)).toBeUndefined();
  });

  it("負の数・非有限値はエラー", () => {
    expect(scoreError(-1, 10)).toBe("0 以上の数値を入力してください");
    expect(scoreError(Number.NaN, 10)).toBe("0 以上の数値を入力してください");
  });

  it("配点を超えるとエラー", () => {
    expect(scoreError(11, 10)).toBe("10 点以下で入力してください");
    expect(scoreError(1, 0)).toBe("0 点以下で入力してください");
  });
});
