import type { ApiErrorBody, ApiErrorCode, MeResponse } from "@haccoli/shared";

/** API 呼び出しのエラー。status / code で分岐する */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | "NETWORK",
    message: string,
  ) {
    super(message);
  }
}

/**
 * 同一オリジンの /api/* を呼ぶ（CloudFront が API Gateway へ転送する）。
 * アクセストークンを Bearer で付与する。
 */
export async function apiFetch<T>(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch {
    throw new ApiError(0, "NETWORK", "通信に失敗しました");
  }
  const body = (await res.json().catch(() => undefined)) as unknown;
  if (!res.ok) {
    const err = (body as Partial<ApiErrorBody> | undefined)?.error;
    // API Gateway のオーソライザーが拒否した場合は {"message":"Unauthorized"} 形式になる
    const code = err?.code ?? (res.status === 401 ? "UNAUTHORIZED" : "INTERNAL");
    throw new ApiError(res.status, code, err?.message ?? res.statusText);
  }
  return body as T;
}

export const getMe = (accessToken: string) => apiFetch<MeResponse>(accessToken, "/me");

/** 利用者に見せるエラーメッセージ。サーバー内部のエラーは汎用メッセージにする */
export function messageOf(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "NETWORK") return "通信に失敗しました。接続を確認して再度お試しください。";
    if (e.code === "UNAUTHORIZED")
      return "ログインの有効期限が切れました。再度ログインしてください。";
    if (e.status >= 500) return "エラーが発生しました。時間をおいて再度お試しください。";
    return e.message;
  }
  return "エラーが発生しました。時間をおいて再度お試しください。";
}
