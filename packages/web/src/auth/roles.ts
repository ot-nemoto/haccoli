export type { Role } from "@haccoli/shared";

import type { Role } from "@haccoli/shared";

export const ROLE_ROUTES: Record<Role, { login: string; home: string; label: string }> = {
  candidate: { login: "/login", home: "/exam", label: "採用課題" },
  grader: { login: "/grader/login", home: "/grader", label: "採点" },
};
