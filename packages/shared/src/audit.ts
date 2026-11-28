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
  "exam.save",
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

/** 画面に表示する操作の種類の名前 */
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  "user.add": "利用者の登録",
  "user.roles": "ロールの変更",
  "user.disable": "利用者の無効化",
  "user.purge": "個人データの削除",
  "user.migrate-roles": "ロールの移行",
  "exam.save": "課題の下書きの保存",
  "exam.publish": "課題の公開",
  "attempt.issue": "受験の発行",
  "attempt.extend": "期限の変更",
  "attempt.cancel": "受験の取消",
  "attempt.assign": "採点者の割り当て",
  "result.export": "採点結果の出力",
};

export const AUDIT_STATUS_LABELS: Record<AuditStatus, string> = {
  SUCCEEDED: "成功",
  FAILED: "失敗",
  // 結果を記録する前に止まった。対象の状態を確かめる（docs/design.md §14.4）
  STARTED: "結果不明",
};
