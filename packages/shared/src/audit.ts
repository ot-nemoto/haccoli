/**
 * 監査ログの型（docs/design.md §14.4）。core が記録し、管理者 API（/api/admin/audit）が返す。
 * 回答・採点の本文や、対象者のメールアドレス・氏名は含めない。
 */

/** 操作した人 */
export type Actor =
  /** 管理者（Cognito の admin グループ。管理画面から操作） */
  | { type: "admin"; sub: string; name: string }
  /** スーパー管理者（IAM。CLI から操作）。sts:GetCallerIdentity の ARN */
  | { type: "iam"; arn: string };

export const AUDIT_ACTIONS = [
  "user.add",
  "user.roles",
  "user.disable",
  "user.purge",
  "user.migrate-roles",
  "exam.publish",
  "attempt.issue",
  "attempt.extend",
  "attempt.cancel",
  "attempt.assign",
  "result.export",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === "string" && (AUDIT_ACTIONS as readonly string[]).includes(value);
}

export interface AuditTarget {
  type: "user" | "attempt" | "exam";
  /** 利用者は sub、受験は attemptId、課題は examId（メールアドレスは使わない） */
  id: string;
}

/** STARTED のまま残ったものは、結果が記録されていない（結果不明）。対象の状態を確かめる */
export type AuditStatus = "STARTED" | "SUCCEEDED" | "FAILED";

/** 変更の要点。個人を特定できる値（メールアドレス・氏名）や回答・採点の本文は入れない */
export type AuditDetail = Record<string, string | number | boolean | string[] | undefined>;

export interface AuditEntry {
  action: AuditAction;
  target?: AuditTarget;
  detail?: AuditDetail;
}

export interface AuditRecord extends AuditEntry {
  /** SK（`<timestamp>#<uuid>`） */
  id: string;
  /** JST の年月（yyyymm） */
  month: string;
  at: string;
  actor: Actor;
  status: AuditStatus;
  finishedAt?: string;
  /** FAILED の理由（メールアドレスは伏せる） */
  error?: string;
}
