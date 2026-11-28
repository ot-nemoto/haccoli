/**
 * 画面利用者のロール（Cognito グループ名と一致させる）。
 * AWS の IAM で CLI を実行するスーパー管理者は Cognito ユーザーではない（docs/design.md §14）。
 */
export const ROLES = ["candidate", "grader", "admin"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * ロールの組み合わせの検証（§14.2）。1 つ以上必要で、candidate は他のロールと兼ねない。
 * 問題があれば理由を返す。
 */
export function rolesProblem(roles: readonly Role[]): string | undefined {
  if (roles.length === 0) return "ロールが 1 つもありません";
  if (new Set(roles).size !== roles.length) return "ロールが重複しています";
  if (roles.includes("candidate") && roles.length > 1) {
    return "候補者は採点者・管理者を兼ねられません";
  }
  return undefined;
}

/** 表示・保存の順序をそろえる */
export function sortRoles(roles: readonly Role[]): Role[] {
  return ROLES.filter((r) => roles.includes(r));
}

/** 画面に表示するロールの名前 */
export const ROLE_LABELS: Record<Role, string> = {
  candidate: "候補者",
  grader: "採点者",
  admin: "管理者",
};
