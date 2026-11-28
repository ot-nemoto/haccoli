import {
  type Actor,
  type AttemptStatus,
  AUDIT_ACTION_LABELS,
  type AuditDetail,
  type AuditTarget,
  ROLE_LABELS,
  type Role,
  type StaffRole,
} from "@haccoli/shared";
import { formatJst } from "./format.js";

/** 管理画面の表示・リクエストの組み立て（docs/design.md §14.7） */

/** 今月（JST）を YYYY-MM で返す。監査ログの既定の月 */
export function currentMonth(now: Date = new Date()): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 7);
}

/** クエリ文字列。値が空のものは付けない */
export function withQuery(path: string, params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export function rolesLabel(roles: readonly Role[]): string {
  return roles.map((r) => ROLE_LABELS[r]).join("・");
}

export function actorLabel(actor: Actor): string {
  return actor.type === "admin" ? `${actor.name}（管理者）` : `${actor.arn}（スーパー管理者）`;
}

const TARGET_LABELS: Record<AuditTarget["type"], string> = {
  user: "利用者",
  attempt: "受験",
  exam: "課題",
};

/** 対象は sub・受験 ID・課題 ID で記録している（メールアドレス・氏名は記録しない。§14.4） */
export function targetLabel(target: AuditTarget | undefined, names: Map<string, string>): string {
  if (!target) return "";
  const name = target.type === "user" ? names.get(target.id) : undefined;
  return `${TARGET_LABELS[target.type]} ${name ? `${name}（${target.id}）` : target.id}`;
}

/** 内容の項目の表示名。この順に並べる */
const DETAIL_LABELS: Record<string, string> = {
  added: "付与",
  removed: "削除",
  roles: "ロール",
  rolesBefore: "変更前",
  rolesAfter: "変更後",
  changed: "変更あり",
  candidateSub: "候補者",
  graderSub: "採点者",
  examId: "課題",
  examVersion: "版",
  version: "版",
  title: "題名",
  deadlineAt: "期限",
  deadlineBefore: "変更前の期限",
  deadlineAfter: "変更後の期限",
  statusBefore: "変更前の状態",
  statusAfter: "変更後の状態",
  attempts: "受験数",
  rows: "行数",
  attemptIds: "受験",
  migrated: "移行した件数",
  skipped: "移行しなかった件数",
};

const ROLE_KEYS = ["roles", "added", "removed", "rolesBefore", "rolesAfter"];
const USER_KEYS = ["candidateSub", "graderSub"];
const DATE_KEYS = ["deadlineAt", "deadlineBefore", "deadlineAfter"];
const STATUS_KEYS = ["statusBefore", "statusAfter"];

/**
 * 内容の表示。ロール・状態は表示名、期限は JST の日時、利用者の sub は氏名（引けたとき）にし、
 * DETAIL_LABELS の順（その他は後ろ）に並べる
 */
export function detailEntries(
  detail: AuditDetail | undefined,
  names: Map<string, string> = new Map(),
): [string, string][] {
  const order = Object.keys(DETAIL_LABELS);
  const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
  return Object.entries(detail ?? {})
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([k, v]) => {
      const label = DETAIL_LABELS[k] ?? k;
      const text = (x: string) => {
        if (ROLE_KEYS.includes(k)) return ROLE_LABELS[x as Role] ?? x;
        if (STATUS_KEYS.includes(k)) return ADMIN_STATUS_LABELS[x as AttemptStatus] ?? x;
        if (DATE_KEYS.includes(k)) return formatJst(x);
        if (USER_KEYS.includes(k)) return names.has(x) ? `${names.get(x)}（${x}）` : x;
        return x;
      };
      if (Array.isArray(v)) return [label, v.map(text).join("・")];
      if (typeof v === "boolean") return [label, v ? "はい" : "いいえ"];
      return [label, text(String(v))];
    });
}

// ---- 受験 ----

/**
 * 管理画面の状態の表示名。候補者の画面（ATTEMPT_STATUS_LABELS）と違い、提出後の採点の進み具合を
 * 区別する
 */
export const ADMIN_STATUS_LABELS: Record<AttemptStatus, string> = {
  NOT_STARTED: "未着手",
  IN_PROGRESS: "回答中",
  SUBMITTED: "提出済み",
  GRADING: "採点中",
  GRADED: "採点完了",
  EXPIRED: "期限切れ（未提出）",
  CANCELED: "取消",
};

/** 期限を変更できる状態（attempt:extend と同じ。期限切れからも戻せる） */
export const canExtend = (s: AttemptStatus) =>
  s === "NOT_STARTED" || s === "IN_PROGRESS" || s === "EXPIRED";
/** 取り消せる状態（未着手・回答中のみ） */
export const canCancel = (s: AttemptStatus) => s === "NOT_STARTED" || s === "IN_PROGRESS";
/** 採点者を割り当てられる状態（期限切れ・取消以外） */
export const canAssign = (s: AttemptStatus) => s !== "EXPIRED" && s !== "CANCELED";

/** JST の日付（YYYY-MM-DD）。今日から days 日後 */
export function jstDateAfter(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000 + days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

/** 期限（ISO）の JST の日付。期限は日付の 23:59:59.999 JST なので、その日になる */
export function deadlineDateOf(deadlineAt: string): string {
  return new Date(new Date(deadlineAt).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function actionLabel(action: keyof typeof AUDIT_ACTION_LABELS): string {
  return AUDIT_ACTION_LABELS[action];
}

/** ロールの変更で、外すロール（確認ダイアログを出す）と付与するロール */
export function rolesChange(
  before: readonly Role[],
  after: readonly StaffRole[],
): { adds: StaffRole[]; removes: Role[] } {
  return {
    adds: after.filter((r) => !before.includes(r)),
    removes: before.filter((r) => !(after as readonly Role[]).includes(r)),
  };
}
