import { NotFoundError, StateError, ValidationError, VersionConflictError } from "@haccoli/core";
import type { ApiErrorBody, MeResponse } from "@haccoli/shared";
import { Hono } from "hono";
import { type AppEnv, authenticate, requireRole } from "./auth.js";
import { candidateRoutes } from "./candidate.js";
import type { ApiDeps } from "./deps.js";
import { ApiError } from "./errors.js";
import { graderRoutes } from "./grader.js";

/**
 * API アプリケーション（docs/design.md §7）。CloudFront の /api/* から API Gateway 経由で呼ばれる。
 * ログには個人情報・回答本文を出さない（§10）。
 */
export function createApp(deps: ApiDeps) {
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

  app.get("/me", (c) => {
    const { sub, name, role } = c.get("user");
    return c.json<MeResponse>({ sub, name, role });
  });

  // ロール別のルート。各ルートのリソース単位の認可は ensureOwned で行う
  app.use("/candidate/*", requireRole("candidate"));
  app.use("/grader/*", requireRole("grader"));
  app.route("/candidate", candidateRoutes(deps));
  app.route("/grader", graderRoutes(deps));

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
  return undefined;
}
