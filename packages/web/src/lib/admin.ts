import {
  type Actor,
  AUDIT_ACTION_LABELS,
  type AuditDetail,
  type AuditTarget,
  ROLE_LABELS,
  type Role,
  type StaffRole,
} from "@haccoli/shared";

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
};

/** 内容の表示。ロールは表示名にし、DETAIL_LABELS の順（その他は後ろ）に並べる */
export function detailEntries(detail: AuditDetail | undefined): [string, string][] {
  const order = Object.keys(DETAIL_LABELS);
  const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
  return Object.entries(detail ?? {})
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([k, v]) => {
      const label = DETAIL_LABELS[k] ?? k;
      const roleLike = ["roles", "added", "removed", "rolesBefore", "rolesAfter"].includes(k);
      const text = (x: string) => (roleLike ? (ROLE_LABELS[x as Role] ?? x) : x);
      if (Array.isArray(v)) return [label, v.map(text).join("・")];
      if (typeof v === "boolean") return [label, v ? "はい" : "いいえ"];
      return [label, text(String(v))];
    });
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
