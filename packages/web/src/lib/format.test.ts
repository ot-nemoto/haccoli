import { describe, expect, it } from "vitest";
import { formatJst, remainingLabel } from "./format.js";

describe("format", () => {
  it("JST で表示する", () => {
    expect(formatJst("2026-11-30T14:59:59.999Z")).toBe("2026/11/30 23:59");
  });

  it.each([
    ["2026-11-20T00:00:00Z", "残り 10 日"],
    ["2026-11-30T09:59:59Z", "残り 5 時間"],
    ["2026-11-30T14:30:00Z", "残り 29 分"],
    ["2026-11-30T14:59:59.500Z", "残り 1 分"],
    ["2026-11-30T15:00:00Z", "期限切れ"],
  ])("%s 時点 → %s", (now, label) => {
    expect(remainingLabel("2026-11-30T14:59:59.999Z", new Date(now))).toBe(label);
  });
});
