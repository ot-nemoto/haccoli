import type { Role } from "./roles.js";

/**
 * API のリクエスト・レスポンス型（docs/design.md §7）。api と web で共有する。
 * 採点者向けの型には候補者の email を含めないこと（§6.1）。
 */

/** GET /api/me */
export interface MeResponse {
  sub: string;
  name: string;
  role: Role;
}

export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION"
  | "INTERNAL";

/** エラー時のレスポンス本文 */
export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string };
}
