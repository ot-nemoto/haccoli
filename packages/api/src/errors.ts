import type { ApiErrorCode } from "@haccoli/shared";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** ハンドラから投げると onError で ApiErrorBody 形式の JSON に変換される */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ApiErrorCode,
    message: string,
    /** ログにだけ出す補足（不正な項目のパスなど）。レスポンスには含めない */
    readonly detail?: string,
  ) {
    super(message);
  }
}

export const unauthorized = () => new ApiError(401, "UNAUTHORIZED", "認証が必要です");
export const forbidden = () => new ApiError(403, "FORBIDDEN", "この操作は許可されていません");
export const notFound = () => new ApiError(404, "NOT_FOUND", "見つかりません");

/**
 * リクエスト本文の検証エラー（400）。原因を追えるよう、不正な項目のパス（例: items.q2.score）を
 * ログ用の detail に入れる。値そのものは入れない（回答本文・個人情報をログに出さないため）
 */
export function invalidRequest(error?: { issues: { path: PropertyKey[] }[] }): ApiError {
  const paths = error?.issues.map((i) => i.path.map(String).join(".") || "(body)") ?? ["(body)"];
  return new ApiError(
    400,
    "VALIDATION",
    "リクエストの形式が不正です",
    [...new Set(paths)].slice(0, 10).join(",").slice(0, 300),
  );
}
