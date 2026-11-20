import { describe, expect, it } from "vitest";
import { deadlineAtFromDate, jstDate, validateDeadlineDate } from "./deadline.js";

describe("deadline", () => {
  it("期限日の 23:59:59.999 JST を UTC で返す", () => {
    expect(deadlineAtFromDate("2026-12-01")).toBe("2026-12-01T14:59:59.999Z");
  });

  it.each(["2026-02-30", "2026-13-01", "2026/12/01", "20261201"])("不正な日付 %s はエラー", (d) => {
    expect(() => deadlineAtFromDate(d)).toThrow();
  });

  it("JST の日付を返す（UTC 15:00 以降は翌日）", () => {
    expect(jstDate(new Date("2026-11-20T14:59:59Z"))).toBe("2026-11-20");
    expect(jstDate(new Date("2026-11-20T15:00:00Z"))).toBe("2026-11-21");
  });

  it("過去日はエラー、当日は force のときのみ許可", () => {
    const now = new Date("2026-11-20T03:00:00Z"); // JST 12:00
    expect(() => validateDeadlineDate("2026-11-19", now)).toThrow("過去");
    expect(() => validateDeadlineDate("2026-11-20", now)).toThrow("--force");
    expect(validateDeadlineDate("2026-11-20", now, true)).toBe("2026-11-20T14:59:59.999Z");
    expect(validateDeadlineDate("2026-11-21", now)).toBe("2026-11-21T14:59:59.999Z");
  });
});
