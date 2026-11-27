import { getUserBySub } from "@haccoli/core";
import type { Role } from "@haccoli/shared";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import type { Context, MiddlewareHandler } from "hono";
import type { ApiDeps } from "./deps.js";
import { forbidden, notFound, unauthorized } from "./errors.js";

/** 認可済みの利用者。プロフィールは DynamoDB を正とする（docs/design.md §4.3） */
export interface AuthUser {
  sub: string;
  name: string;
  /** トークンのグループと DynamoDB の roles の両方にあるロール（§14.3） */
  roles: Role[];
}

export interface AppEnv {
  Bindings: { event: APIGatewayProxyEventV2WithJWTAuthorizer };
  Variables: { user: AuthUser };
}

/**
 * HTTP API の JWT オーソライザーはクレームの配列を "[a b]" 形式の文字列に変換して渡すため、
 * 配列・文字列の両方を受け付ける。
 */
export function parseGroups(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string") return [];
  return raw
    .replace(/^\[|\]$/g, "")
    .split(/[\s,]+/)
    .filter(Boolean);
}

function claimsOf(c: Context<AppEnv>): Record<string, unknown> | undefined {
  return c.env?.event?.requestContext?.authorizer?.jwt?.claims;
}

/**
 * 全 API 共通の認証。署名・有効期限・client_id は API Gateway の JWT オーソライザーで検証済み。
 * ここでは以下を確認する。
 * - アクセストークンであること（ID トークンでの呼び出しは受け付けない）
 * - DynamoDB に登録済みで無効化されていないこと（無効化後も最長 60 分残るトークンを拒否する）
 * - Cognito グループと DynamoDB の roles の両方にあるロールを 1 つ以上持つこと（§14.3）。
 *   付与は次にトークンが発行されたときから、削除は DynamoDB を変えた時点で有効になる
 */
export function authenticate(deps: ApiDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const claims = claimsOf(c);
    const sub = claims?.sub;
    if (typeof sub !== "string" || !sub || claims?.token_use !== "access") throw unauthorized();

    const profile = await getUserBySub(deps, sub);
    if (!profile || profile.disabled) throw forbidden();
    const groups = parseGroups(claims["cognito:groups"]);
    const roles = profile.roles.filter((r) => groups.includes(r));
    if (roles.length === 0) throw forbidden();

    c.set("user", { sub: profile.sub, name: profile.name, roles });
    await next();
  };
}

/** ルート単位のロール認可 */
export function requireRole(role: Role): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.get("user").roles.includes(role)) throw forbidden();
    await next();
  };
}

/**
 * リソース単位の認可（IDOR 対策）。他人のリソースは存在自体を知られないよう 404 を返す。
 * 候補者は自分の受験、採点者は自分に割り当てられた受験のみアクセス可能（Step 3 以降で使用）。
 */
export function ensureOwned(ownerSubs: string | readonly string[], user: AuthUser): void {
  const owners = typeof ownerSubs === "string" ? [ownerSubs] : ownerSubs;
  if (!owners.includes(user.sub)) throw notFound();
}
