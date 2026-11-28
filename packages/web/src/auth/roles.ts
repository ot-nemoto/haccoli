export type { Role } from "@haccoli/shared";

import type { Role } from "@haccoli/shared";

/** 画面のあるロール。採点者と管理者を兼ねる人は、画面ごとにログインする（docs/design.md §14.2） */
export type ScreenRole = Role;

export const ROLE_ROUTES: Record<ScreenRole, { login: string; home: string; label: string }> = {
  candidate: { login: "/login", home: "/exam", label: "採用課題" },
  grader: { login: "/grader/login", home: "/grader", label: "採点" },
  admin: { login: "/admin/login", home: "/admin", label: "管理" },
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
