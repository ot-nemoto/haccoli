import {
  ExamAlreadyExistsError,
  NotFoundError,
  ResultsTooLargeError,
  StateError,
  UserAlreadyExistsError,
  ValidationError,
  VersionConflictError,
} from "@haccoli/core";
import type { ApiErrorBody } from "@haccoli/shared";
import { Hono } from "hono";
import { type AppEnv, authenticate } from "./auth.js";
import type { ApiDeps } from "./deps.js";
import { ApiError } from "./errors.js";

/**
 * API の共通部分（ログ・エラーの変換・認証）。候補者・採点者の API（app.ts）と
 * 管理者 API（admin-app.ts）は別の Lambda で動くが、どちらもこの上に作る。
 * ログには個人情報・回答本文を出さない（§10）。
 */
export function createBaseApp(deps: Pick<ApiDeps, "ddb" | "tableName">) {
  const app = new Hono<AppEnv>().basePath("/api");

  app.use(async (c, next) => {
    const started = Date.now();
    await next();
    // 認証付きレスポンスを中間キャッシュ・ブラウザに残さない
    c.res.headers.set("Cache-Control", "no-store");
    console.log(
      JSON.stringify({
        msg: "request",
        method: c.req.method,
        // 実パス（ID を含むが email 等の個人情報は含まない）と、一致したルートのパターン
        path: c.req.path,
        route: c.req.routePath,
        status: c.res.status,
        sub: c.get("user")?.sub,
        ms: Date.now() - started,
      }),
    );
  });

  app.onError((err, c) => {
    const known = toApiError(err);
    if (known) {
      // 4xx の原因を追えるよう、コードと補足をログに出す（メッセージ・本文は出さない）
      console.log(
        JSON.stringify({
          msg: "client_error",
          status: known.status,
          code: known.code,
          ...(known.detail ? { detail: known.detail } : {}),
          route: c.req.routePath,
        }),
      );
      return c.json<ApiErrorBody>(
        { error: { code: known.code, message: known.message } },
        known.status,
      );
    }
    console.error(JSON.stringify({ msg: "unhandled", name: err.name, message: err.message }));
    return c.json<ApiErrorBody>(
      { error: { code: "INTERNAL", message: "サーバーでエラーが発生しました" } },
      500,
    );
  });

  app.notFound((c) =>
    c.json<ApiErrorBody>({ error: { code: "NOT_FOUND", message: "見つかりません" } }, 404),
  );

  app.use(authenticate(deps));

  return app;
}

/** ドメインエラーを API のエラーに変換する。想定外のエラーは undefined（500 にする） */
function toApiError(err: Error): ApiError | undefined {
  if (err instanceof ApiError) return err;
  if (err instanceof NotFoundError) return new ApiError(404, "NOT_FOUND", err.message);
  if (err instanceof ValidationError) return new ApiError(400, "VALIDATION", err.message);
  if (err instanceof VersionConflictError) {
    return new ApiError(409, "VERSION_CONFLICT", err.message);
  }
  if (err instanceof StateError) return new ApiError(409, "INVALID_STATE", err.message);
  if (err instanceof UserAlreadyExistsError) return new ApiError(409, "CONFLICT", err.message);
  if (err instanceof ExamAlreadyExistsError) return new ApiError(409, "CONFLICT", err.message);
  if (err instanceof ResultsTooLargeError) return new ApiError(413, "TOO_LARGE", err.message);
  return undefined;
}
