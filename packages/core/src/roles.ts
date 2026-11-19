/** 画面利用者のロール（Cognito グループ名と一致させる）。管理者は Cognito ユーザーではない。 */
export const ROLES = ["candidate", "grader"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
