import type { Role } from "./roles.js";

/**
 * API のリクエスト・レスポンス型（docs/design.md §7）。api と web で共有する。
 * 採点者向けの型には候補者の email を含めないこと（§6.1）。
 */

/** GET /api/me */
export interface MeResponse {
  sub: string;
  name: string;
  /** トークンのグループと登録情報の両方にあるロール（§14.3） */
  roles: Role[];
}

export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  /** 楽観ロックの競合（別の画面・端末で更新された）。再読み込みが必要 */
  | "VERSION_CONFLICT"
  /** 受験の状態（提出済み・期限切れ・未開始など）により操作できない */
  | "INVALID_STATE"
  | "VALIDATION"
  | "INTERNAL";

/** エラー時のレスポンス本文 */
export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string };
}
