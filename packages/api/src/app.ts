import type { MeResponse } from "@haccoli/shared";
import { requireRole } from "./auth.js";
import { createBaseApp } from "./base.js";
import { candidateRoutes } from "./candidate.js";
import type { ApiDeps } from "./deps.js";
import { graderRoutes } from "./grader.js";

/**
 * 候補者・採点者の API（docs/design.md §7）。CloudFront の /api/* から API Gateway 経由で呼ばれる。
 * 管理者 API（/api/admin/*）は別の Lambda（admin-app.ts）で動き、ここには置かない（§14.3）。
 * この Lambda には Scan・Cognito・監査ログのテーブルの権限を与えない。
 */
export function createApp(deps: ApiDeps) {
  const app = createBaseApp(deps);

  app.get("/me", (c) => {
    const { sub, name, roles } = c.get("user");
    return c.json<MeResponse>({ sub, name, roles });
  });

  // ロール別のルート。各ルートのリソース単位の認可は ensureOwned で行う
  app.use("/candidate/*", requireRole("candidate"));
  app.use("/grader/*", requireRole("grader"));
  app.route("/candidate", candidateRoutes(deps));
  app.route("/grader", graderRoutes(deps));

  return app;
}
