import { describe, expect, it } from "vitest";
import { actorLabel, parseMonth } from "./audit.js";

describe("audit:list", () => {
  it("月は YYYY-MM と YYYYMM を受け付ける", () => {
    expect(parseMonth("2026-11")).toBe("202611");
    expect(parseMonth("202612")).toBe("202612");
    expect(() => parseMonth("2026-13")).toThrow("YYYY-MM");
    expect(() => parseMonth("2026/11")).toThrow("YYYY-MM");
  });

  it("実行者は管理者なら氏名と sub、スーパー管理者なら ARN を表示する", () => {
    expect(actorLabel({ type: "admin", sub: "s1", name: "管理 一郎" })).toBe(
      "管理 一郎（管理者 s1）",
    );
    expect(actorLabel({ type: "iam", arn: "arn:aws:iam::1:user/x" })).toBe("arn:aws:iam::1:user/x");
  });
});
