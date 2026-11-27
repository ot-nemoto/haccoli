import type { AuditRecord } from "./audit.js";
import type { Role } from "./roles.js";

/**
 * 管理者 API（/api/admin/*、docs/design.md §14.6）のリクエスト・レスポンス型。
 * 管理者は候補者のメールアドレスを閲覧できる（§14.1。受験の発行・連絡に必要）。
 */

/** 一覧のページ。cursor があれば、次のページを ?cursor= で読む */
export interface AdminPage<T> {
  items: T[];
  cursor?: string;
}

export interface AdminUser {
  sub: string;
  email: string;
  name: string;
  roles: Role[];
  disabled: boolean;
  createdAt: string;
}

/** POST /api/admin/users */
export interface AdminCreateUserRequest {
  email: string;
  name: string;
  /** 候補者は ["candidate"]、それ以外は grader・admin の組み合わせ */
  roles: Role[];
}

/** 画面から付与・削除できるロール（候補者のロールは変えない） */
export type StaffRole = Exclude<Role, "candidate">;

/** PUT /api/admin/users/{sub}/roles。変更後のロール（1 つ以上） */
export interface AdminSetRolesRequest {
  roles: StaffRole[];
}

/** GET /api/admin/users */
export type AdminUserPage = AdminPage<AdminUser>;

/** GET /api/admin/audit */
export type AdminAuditPage = AdminPage<AuditRecord>;
