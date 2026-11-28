import { ATTEMPT_STATUSES } from "@haccoli/shared";
import { describe, expect, it } from "vitest";
import {
  actorLabel,
  canAssign,
  canCancel,
  canExtend,
  currentMonth,
  deadlineDateOf,
  detailEntries,
  jstDateAfter,
  rolesChange,
  targetLabel,
  withQuery,
} from "./admin.js";

describe("管理画面の表示", () => {
  it("今月は JST で数える", () => {
    expect(currentMonth(new Date("2026-11-30T14:59:59Z"))).toBe("2026-11");
    expect(currentMonth(new Date("2026-11-30T15:00:00Z"))).toBe("2026-12");
  });

  it("クエリは空の値を付けない", () => {
    expect(withQuery("/admin/users", { role: undefined, cursor: "" })).toBe("/admin/users");
    expect(withQuery("/admin/audit", { month: "2026-11", action: "user.roles" })).toBe(
      "/admin/audit?month=2026-11&action=user.roles",
    );
  });

  it("実行者は、管理者なら氏名、スーパー管理者なら IAM の ARN", () => {
    expect(actorLabel({ type: "admin", sub: "s", name: "管理 花子" })).toBe("管理 花子（管理者）");
    expect(actorLabel({ type: "iam", arn: "arn:aws:iam::1:user/x" })).toBe(
      "arn:aws:iam::1:user/x（スーパー管理者）",
    );
  });

  it("対象の利用者は、わかれば氏名を添える", () => {
    const names = new Map([["sub-1", "採点 太郎"]]);
    expect(targetLabel({ type: "user", id: "sub-1" }, names)).toBe("利用者 採点 太郎（sub-1）");
    expect(targetLabel({ type: "user", id: "sub-2" }, names)).toBe("利用者 sub-2");
    expect(targetLabel({ type: "attempt", id: "a-1" }, names)).toBe("受験 a-1");
    expect(targetLabel(undefined, names)).toBe("");
  });

  it("内容のロールは表示名にする", () => {
    // 保存された順（DynamoDB の Map は順序を保たない）によらず、決まった順に並べる
    expect(
      detailEntries({
        changed: true,
        examId: "x",
        rolesAfter: ["grader"],
        rolesBefore: ["grader", "admin"],
        removed: "admin",
      }),
    ).toEqual([
      ["削除", "管理者"],
      ["変更前", "採点者・管理者"],
      ["変更後", "採点者"],
      ["変更あり", "はい"],
      ["課題", "x"],
    ]);
  });

  it("受験の操作の内容は、期限を JST・状態を管理画面の表示名・利用者を氏名で表示する", () => {
    const names = new Map([["sub-g", "採点 太郎"]]);
    expect(
      detailEntries(
        {
          statusAfter: "IN_PROGRESS",
          deadlineAfter: "2026-12-20T14:59:59.999Z",
          deadlineBefore: "2026-11-30T14:59:59.999Z",
          statusBefore: "EXPIRED",
        },
        names,
      ),
    ).toEqual([
      ["変更前の期限", "2026/11/30 23:59"],
      ["変更後の期限", "2026/12/20 23:59"],
      ["変更前の状態", "期限切れ（未提出）"],
      ["変更後の状態", "回答中"],
    ]);
    expect(detailEntries({ graderSub: "sub-g", statusAfter: "GRADING" }, names)).toEqual([
      ["採点者", "採点 太郎（sub-g）"],
      ["変更後の状態", "採点中"],
    ]);
    expect(detailEntries({ candidateSub: "sub-x" }, names)).toEqual([["候補者", "sub-x"]]);
  });

  it("受験の状態ごとに、できる操作を決める（core と同じ）", () => {
    expect(ATTEMPT_STATUSES.filter(canExtend)).toEqual(["NOT_STARTED", "IN_PROGRESS", "EXPIRED"]);
    expect(ATTEMPT_STATUSES.filter(canCancel)).toEqual(["NOT_STARTED", "IN_PROGRESS"]);
    expect(ATTEMPT_STATUSES.filter(canAssign)).toEqual([
      "NOT_STARTED",
      "IN_PROGRESS",
      "SUBMITTED",
      "GRADING",
      "GRADED",
    ]);
  });

  it("期限日は JST の日付で数える", () => {
    // JST 2026-11-30 23:59（UTC 14:59）の翌日は 12-01
    expect(jstDateAfter(1, new Date("2026-11-30T14:59:00Z"))).toBe("2026-12-01");
    expect(jstDateAfter(1, new Date("2026-11-30T15:00:00Z"))).toBe("2026-12-02");
    expect(deadlineDateOf("2026-12-20T14:59:59.999Z")).toBe("2026-12-20");
  });

  it("ロールの変更で、付与するロールと外すロールを分ける", () => {
    expect(rolesChange(["grader"], ["admin"])).toEqual({ adds: ["admin"], removes: ["grader"] });
    expect(rolesChange(["grader", "admin"], ["grader", "admin"])).toEqual({
      adds: [],
      removes: [],
    });
  });
});
