import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-northeast-1" }));
const ddbMock = mockClient(ddb);
const app = createApp({ ddb, tableName: "table" });

const candidate = {
  PK: "USER#sub-c",
  SK: "PROFILE",
  type: "User",
  sub: "sub-c",
  email: "cand@example.com",
  name: "山田 太郎",
  role: "candidate",
  disabled: false,
  createdAt: "2026-11-19T00:00:00.000Z",
};

/** API Gateway の JWT オーソライザーが付与するクレームを模したイベント */
function eventWith(claims?: Record<string, unknown>) {
  return {
    requestContext: { authorizer: claims ? { jwt: { claims, scopes: [] } } : undefined },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

const accessClaims = (overrides: Record<string, unknown> = {}) => ({
  sub: "sub-c",
  token_use: "access",
  "cognito:groups": "[candidate]",
  ...overrides,
});

const call = (path: string, claims?: Record<string, unknown>) =>
  app.request(path, {}, { event: eventWith(claims) });

describe("GET /api/me", () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(GetCommand).resolves({ Item: candidate });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("DynamoDB のプロフィールからロールと氏名を返す（email は返さない）", async () => {
    const res = await call("/api/me", accessClaims());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: "sub-c", name: "山田 太郎", role: "candidate" });
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input.Key).toEqual({
      PK: "USER#sub-c",
      SK: "PROFILE",
    });
  });

  it("レスポンスは常に Cache-Control: no-store（エラー時も）", async () => {
    expect((await call("/api/me", accessClaims())).headers.get("Cache-Control")).toBe("no-store");
    expect((await call("/api/me")).headers.get("Cache-Control")).toBe("no-store");
  });

  it("ログには実パスとルートを出し、email・氏名は出さない", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await call("/api/grader/attempts/a-1", accessClaims());
    const line = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(line).toMatchObject({
      path: "/api/grader/attempts/a-1",
      route: "/api/grader/*",
      status: 403,
      sub: "sub-c",
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/cand@example\.com|山田/);
  });

  it("クレームがなければ 401", async () => {
    const res = await call("/api/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "認証が必要です" },
    });
  });

  it("ID トークンでの呼び出しは 401", async () => {
    const res = await call("/api/me", accessClaims({ token_use: "id" }));
    expect(res.status).toBe(401);
  });

  it("未登録ユーザーは 403", async () => {
    ddbMock.on(GetCommand).resolves({});
    expect((await call("/api/me", accessClaims())).status).toBe(403);
  });

  it("無効化されたユーザーは 403（トークンが有効期限内でも拒否）", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...candidate, disabled: true } });
    expect((await call("/api/me", accessClaims())).status).toBe(403);
  });

  it("Cognito グループと DynamoDB のロールが一致しなければ 403", async () => {
    const res = await call("/api/me", accessClaims({ "cognito:groups": "[grader]" }));
    expect(res.status).toBe(403);
  });

  it("想定外のエラーは詳細を隠して 500", async () => {
    ddbMock.on(GetCommand).rejects(new Error("secret detail"));
    const res = await call("/api/me", accessClaims());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret detail");
  });
});

describe("ロール別ルート", () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("候補者は /candidate/* を通過し（未実装ルートは 404）、/grader/* は 403", async () => {
    ddbMock.on(GetCommand).resolves({ Item: candidate });
    expect((await call("/api/candidate/attempts", accessClaims())).status).toBe(404);
    expect((await call("/api/grader/assignments", accessClaims())).status).toBe(403);
  });

  it("採点者は /grader/* を通過し、/candidate/* は 403", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...candidate, sub: "sub-g", role: "grader" },
    });
    const claims = accessClaims({ sub: "sub-g", "cognito:groups": "[grader]" });
    expect((await call("/api/grader/assignments", claims)).status).toBe(404);
    expect((await call("/api/candidate/attempts", claims)).status).toBe(403);
  });
});
