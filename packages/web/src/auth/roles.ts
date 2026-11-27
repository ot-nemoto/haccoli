export type { Role } from "@haccoli/shared";

import type { Role } from "@haccoli/shared";

/** 画面のあるロール。管理画面（admin）は Step 8 で追加する（docs/design.md §14.7） */
export type ScreenRole = Extract<Role, "candidate" | "grader">;

export const ROLE_ROUTES: Record<ScreenRole, { login: string; home: string; label: string }> = {
  candidate: { login: "/login", home: "/exam", label: "採用課題" },
  grader: { login: "/grader/login", home: "/grader", label: "採点" },
};

/**
 * ログイン後の戻り先。そのロールの画面配下の相対パスのみ許可する（オープンリダイレクト防止）。
 */
export function safeReturnPath(role: ScreenRole, from: unknown): string {
  const home = ROLE_ROUTES[role].home;
  if (typeof from !== "string") return home;
  if (from !== home && !from.startsWith(`${home}/`)) return home;
  if (from.includes("//") || from.includes("\\")) return home;
  return from;
}
