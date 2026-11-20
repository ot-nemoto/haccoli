import type { ApiErrorCode } from "@haccoli/shared";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** ハンドラから投げると onError で ApiErrorBody 形式の JSON に変換される */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const unauthorized = () => new ApiError(401, "UNAUTHORIZED", "認証が必要です");
export const forbidden = () => new ApiError(403, "FORBIDDEN", "この操作は許可されていません");
export const notFound = () => new ApiError(404, "NOT_FOUND", "見つかりません");
