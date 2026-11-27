import {
  type AuditedUserDeps,
  auditMonth,
  disableUser,
  isAuditAction,
  isRole,
  listAuditLogPage,
  listUserPage,
  registerUser,
  setStaffRoles,
  type UserProfile,
} from "@haccoli/core";
import type { AdminAuditPage, AdminUser, AdminUserPage } from "@haccoli/shared";
import { adminCreateUserRequestSchema, adminSetRolesRequestSchema } from "@haccoli/shared/schemas";
import { type Context, Hono } from "hono";
import type { AppEnv } from "./auth.js";
import type { AdminApiDeps } from "./deps.js";
import { invalidRequest } from "./errors.js";

/**
 * 管理者 API（docs/design.md §14.6）。/api/admin/* に requireRole("admin") 済みでマウントする。
 * 業務ルール（最後の管理者の保護・ロールの組み合わせなど）と監査ログの記録は core で行う。
 * 実行者は認可済みの管理者（sub・氏名）として core に渡す。
 *
 * Step 7-3 では利用者と監査ログのみ。受験・採点結果・課題の API は Step 8・9 で追加する。
 */
export function adminRoutes(deps: AdminApiDeps) {
  const app = new Hono<AppEnv>();

  /** 監査ログに記録する実行者（§14.4） */
  const as = (c: Context<AppEnv>): AuditedUserDeps => {
    const { sub, name } = c.get("user");
    return { ...deps, actor: { type: "admin", sub, name } };
  };

  app.get("/users", async (c) => {
    const role = c.req.query("role");
    if (role !== undefined && !isRole(role)) throw invalidRequest();
    const page = await listUserPage(deps, {
      role,
      limit: limitOf(c.req.query("limit")),
      cursor: c.req.query("cursor"),
    });
    return c.json<AdminUserPage>({ ...page, items: page.items.map(toAdminUser) });
  });

  app.post("/users", async (c) => {
    const body = adminCreateUserRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) throw invalidRequest(body.error);
    const user = await registerUser(as(c), body.data);
    return c.json<AdminUser>(toAdminUser(user), 201);
  });

  /**
   * 採点者・管理者のロールを、指定した組み合わせにする。付与を先に、削除を後に行い、
   * それぞれ監査ログに記録する。admin を外すときの保護は、付与の前に確かめる（core の setStaffRoles）
   */
  app.put("/users/:sub/roles", async (c) => {
    const body = adminSetRolesRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) throw invalidRequest(body.error);
    const user = await setStaffRoles(as(c), { sub: c.req.param("sub"), roles: body.data.roles });
    return c.json<AdminUser>(toAdminUser(user));
  });

  app.post("/users/:sub/disable", async (c) => {
    const user = await disableUser(as(c), { sub: c.req.param("sub") });
    return c.json<AdminUser>(toAdminUser(user));
  });

  /** 監査ログ。month は YYYY-MM（省略時は今月、JST） */
  app.get("/audit", async (c) => {
    const month = c.req.query("month");
    if (month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw invalidRequest();
    const action = c.req.query("action");
    if (action !== undefined && !isAuditAction(action)) throw invalidRequest();
    const page = await listAuditLogPage(deps, {
      month: month ? month.replace("-", "") : auditMonth(deps.now?.() ?? new Date()),
      action,
      limit: limitOf(c.req.query("limit")),
      cursor: c.req.query("cursor"),
    });
    return c.json<AdminAuditPage>(page);
  });

  return app;
}

function limitOf(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d{1,3}$/.test(raw)) throw invalidRequest();
  return Number(raw);
}

function toAdminUser(u: UserProfile): AdminUser {
  return {
    sub: u.sub,
    email: u.email,
    name: u.name,
    roles: u.roles,
    disabled: u.disabled,
    createdAt: u.createdAt,
  };
}
