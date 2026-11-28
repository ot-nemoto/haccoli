import { defaultIsContentTypeBinary } from "hono/aws-lambda";
import { adminRoutes } from "./admin.js";
import { requireRole } from "./auth.js";
import { createBaseApp } from "./base.js";
import type { AdminApiDeps } from "./deps.js";

/**
 * 管理者 API のアプリケーション（docs/design.md §14.3・§14.6）。候補者・採点者の API とは
 * 別の Lambda で動く（HTTP API の /api/admin/{proxy+} だけがここに来る）。
 * Cognito のユーザー管理・Scan・監査ログのテーブルの権限は、この Lambda だけが持つ。
 *
 * すべてのルートで、トークンのグループと DynamoDB の roles の両方に admin があることを求める。
 * 候補者・採点者のルートは置かない。
 */
export function createAdminApp(deps: AdminApiDeps) {
  const app = createBaseApp(deps);
  app.use("/admin/*", requireRole("admin"));
  app.route("/admin", adminRoutes(deps));
  return app;
}

/**
 * 管理者 API の Lambda のアダプターの設定。hono/aws-lambda はテキストの応答を res.text() で読み直して
 * 返すため、先頭の BOM が取り除かれる。採点結果の CSV（Excel で文字化けしないよう BOM を付ける）は
 * バイナリ（base64）として返し、バイト列のまま届ける
 */
export const adminLambdaOptions = {
  isContentTypeBinary: (contentType: string) =>
    /^text\/csv\b/i.test(contentType) || defaultIsContentTypeBinary(contentType),
};
