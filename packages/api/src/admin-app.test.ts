import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminApp } from "./admin-app.js";
import { createApp } from "./app.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-northeast-1" }));
const ddbMock = mockClient(ddb);
const cognitoMock = mockClient(CognitoIdentityProviderClient);
const deps = {
  ddb,
  tableName: "table",
  auditTableName: "audit",
  cognito: new CognitoIdentityProviderClient({ region: "ap-northeast-1" }),
  userPoolId: "pool",
  now: () => new Date("2026-11-27T16:00:00Z"), // JST 2026-11-28
};
const adminApp = createAdminApp(deps);
const mainApp = createApp({ ddb, tableName: "table" });

/**
 * 管理者 API のすべてのルート。ルートを足したら、ここにも足す（認可のテストが漏れないよう、
 * 実際のルートの一覧と一致することを確かめる）
 */
const ADMIN_ROUTES = [
  { method: "GET", path: "/api/admin/users" },
  { method: "POST", path: "/api/admin/users" },
  { method: "PUT", path: "/api/admin/users/:sub/roles" },
  { method: "POST", path: "/api/admin/users/:sub/disable" },
  { method: "GET", path: "/api/admin/audit" },
] as const;

const concrete = (path: string) => path.replace(":sub", "sub-t");

const profile = (sub: string, roles: string[], extra: Record<string, unknown> = {}) => ({
  PK: `USER#${sub}`,
  SK: "PROFILE",
  type: "User",
  sub,
  email: `${sub}@example.com`,
  name: `氏名-${sub}`,
  roles,
  disabled: false,
  createdAt: "2026-11-01T00:00:00.000Z",
  ...extra,
});

let users: Map<string, ReturnType<typeof profile>>;

function eventWith(claims?: Record<string, unknown>) {
  return {
    requestContext: { authorizer: claims ? { jwt: { claims, scopes: [] } } : undefined },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

const claimsOf = (sub: string, groups: string) => ({
  sub,
  token_use: "access",
  "cognito:groups": groups,
});
const ADMIN = claimsOf("sub-a", "[admin]");

function call(
  app: typeof adminApp | typeof mainApp,
  method: string,
  path: string,
  claims?: Record<string, unknown>,
  body?: unknown,
) {
  return app.request(
    path,
    {
      method,
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
        : {}),
    },
    { event: eventWith(claims) },
  );
}
const admin = (method: string, path: string, body?: unknown) =>
  call(adminApp, method, path, ADMIN, body);

/** 監査ログのテーブルへの書き込み（実行前の STARTED・同じトランザクションの記録） */
const auditPuts = () =>
  ddbMock
    .commandCalls(PutCommand)
    .map((c) => c.args[0].input)
    .filter((i) => i.TableName === "audit");

beforeEach(() => {
  ddbMock.reset();
  cognitoMock.reset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  users = new Map(
    [
      profile("sub-a", ["admin"]),
      profile("sub-b", ["grader", "admin"]),
      profile("sub-g", ["grader"]),
      profile("sub-c", ["candidate"]),
      profile("sub-t", ["grader"]),
    ].map((u) => [u.sub, u]),
  );
  ddbMock.on(GetCommand).callsFake((i) => ({
    Item: users.get(String(i.Key.PK).replace("USER#", "")),
  }));
  ddbMock.on(QueryCommand, { TableName: "table" }).resolves({ Items: [] });
  ddbMock.on(ScanCommand).callsFake(() => ({
    Items: [...users.values()].filter((u) => u.roles.includes("admin")),
  }));
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
  ddbMock.on(TransactWriteCommand).resolves({});
  cognitoMock.on(AdminCreateUserCommand).resolves({
    User: { Attributes: [{ Name: "sub", Value: "sub-new" }] },
  });
  cognitoMock.on(AdminSetUserPasswordCommand).resolves({});
  cognitoMock.on(AdminAddUserToGroupCommand).resolves({});
  cognitoMock.on(AdminRemoveUserFromGroupCommand).resolves({});
  cognitoMock.on(AdminDisableUserCommand).resolves({});
});

describe("管理者 API の認可（ルートごと）", () => {
  it("テストのルートの一覧は、管理者 API の実際のルートと一致する", () => {
    const actual = adminApp.routes
      .filter((r) => r.path.startsWith("/api/admin/") && r.method !== "ALL")
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(actual).toEqual(ADMIN_ROUTES.map((r) => `${r.method} ${r.path}`).sort());
  });

  it("管理者 API には、候補者・採点者のルートと /me を置かない", async () => {
    expect(adminApp.routes.filter((r) => /\/api\/(candidate|grader|me)/.test(r.path))).toEqual([]);
    const claims = claimsOf("sub-b", "[grader admin]");
    expect((await call(adminApp, "GET", "/api/me", claims)).status).toBe(404);
    expect((await call(adminApp, "GET", "/api/grader/assignments", claims)).status).toBe(404);
  });

  describe.each(ADMIN_ROUTES)("$method $path", ({ method, path }) => {
    const run = (claims?: Record<string, unknown>) =>
      call(adminApp, method, concrete(path), claims, method === "GET" ? undefined : {});

    it("候補者・採点者は 403", async () => {
      expect((await run(claimsOf("sub-c", "[candidate]"))).status).toBe(403);
      expect((await run(claimsOf("sub-g", "[grader]"))).status).toBe(403);
    });

    it("トークンのグループと DynamoDB の roles の片方にしか admin がなければ 403", async () => {
      // 付与の途中（トークンにまだグループがない）
      expect((await run(claimsOf("sub-b", "[grader]"))).status).toBe(403);
      // admin を外した後（発行済みのトークンにグループが残っている）
      expect((await run(claimsOf("sub-g", "[grader admin]"))).status).toBe(403);
    });

    it("無効化された管理者は 403、トークンがなければ 401", async () => {
      users.set("sub-a", profile("sub-a", ["admin"], { disabled: true }));
      expect((await run(ADMIN)).status).toBe(403);
      expect((await run()).status).toBe(401);
    });

    it("拒否したときは、業務データ・Cognito・監査ログに何も書かない", async () => {
      await run(claimsOf("sub-g", "[grader]"));
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
      expect(cognitoMock.calls()).toHaveLength(0);
    });

    it("候補者・採点者の API（別の Lambda）には、このルートがない（管理者でも 404）", async () => {
      const res = await call(
        mainApp,
        method,
        concrete(path),
        claimsOf("sub-b", "[grader admin]"),
        method === "GET" ? undefined : {},
      );
      expect(res.status).toBe(404);
      expect(cognitoMock.calls()).toHaveLength(0);
    });
  });

  it("候補者・採点者の API には /api/admin のルートが 1 つもない", () => {
    expect(mainApp.routes.filter((r) => r.path.startsWith("/api/admin"))).toEqual([]);
  });
});

describe("GET /api/admin/users", () => {
  it("ロールで絞り込み、ページで返す（管理者には email を返す）", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [profile("sub-g", ["grader"])] });
    const res = await admin("GET", "/api/admin/users?role=grader&limit=10");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [
        {
          sub: "sub-g",
          email: "sub-g@example.com",
          name: "氏名-sub-g",
          roles: ["grader"],
          disabled: false,
          createdAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    });
    expect(ddbMock.commandCalls(ScanCommand)[0]?.args[0].input.ExpressionAttributeValues).toEqual({
      ":t": "User",
      ":r": "grader",
    });
  });

  it("不正なロール・件数・カーソルは 400", async () => {
    expect((await admin("GET", "/api/admin/users?role=root")).status).toBe(400);
    expect((await admin("GET", "/api/admin/users?limit=abc")).status).toBe(400);
    expect((await admin("GET", "/api/admin/users?limit=500")).status).toBe(400);
    expect((await admin("GET", "/api/admin/users?cursor=xxx")).status).toBe(400);
  });
});

describe("POST /api/admin/users", () => {
  it("登録し、実行者を管理者として監査ログに記録する（メールアドレス・氏名は記録しない）", async () => {
    const res = await admin("POST", "/api/admin/users", {
      email: "New@Example.com",
      name: "新規 太郎",
      roles: ["grader"],
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      sub: "sub-new",
      email: "new@example.com",
      roles: ["grader"],
    });
    const started = auditPuts()[0];
    expect(started?.Item).toMatchObject({
      action: "user.add",
      status: "STARTED",
      actor: { type: "admin", sub: "sub-a", name: "氏名-sub-a" },
    });
    expect(JSON.stringify(started?.Item)).not.toMatch(/example\.com|新規/);
  });

  it("候補者と他のロールの兼任・不正な本文は 400、登録済みは 409", async () => {
    const post = (body: unknown) => admin("POST", "/api/admin/users", body);
    expect(
      (await post({ email: "x@example.com", name: "x", roles: ["candidate", "admin"] })).status,
    ).toBe(400);
    expect((await post({ email: "x@example.com", name: "x", roles: [] })).status).toBe(400);
    expect((await post({ email: "bad", name: "x", roles: ["grader"] })).status).toBe(400);
    expect((await post({ email: "x@example.com", name: "x", roles: ["root"] })).status).toBe(400);
    expect(cognitoMock.commandCalls(AdminCreateUserCommand)).toHaveLength(0);

    ddbMock
      .on(QueryCommand, { TableName: "table" })
      .resolves({ Items: [profile("sub-x", ["grader"])] });
    const dup = await post({ email: "sub-x@example.com", name: "x", roles: ["grader"] });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe("CONFLICT");
  });
});

describe("PUT /api/admin/users/:sub/roles", () => {
  it("付与を先に、削除を後に行う（grader → admin）", async () => {
    const order: string[] = [];
    cognitoMock.on(AdminAddUserToGroupCommand).callsFake((i) => {
      order.push(`add:${i.GroupName}`);
      return {};
    });
    cognitoMock.on(AdminRemoveUserFromGroupCommand).callsFake((i) => {
      order.push(`remove:${i.GroupName}`);
      return {};
    });
    ddbMock.on(UpdateCommand, { TableName: "table" }).callsFake((i) => {
      const u = users.get(String(i.Key.PK).replace("USER#", ""));
      if (u) u.roles = i.ExpressionAttributeValues[":next"];
      return {};
    });
    const res = await admin("PUT", "/api/admin/users/sub-t/roles", { roles: ["admin"] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { roles: string[] }).roles).toEqual(["admin"]);
    expect(order).toEqual(["add:admin", "remove:grader"]);
    // 付与・削除をそれぞれ管理者の操作として記録する
    expect(auditPuts().map((p) => [p.Item?.action, p.Item?.actor?.type])).toEqual([
      ["user.roles", "admin"],
      ["user.roles", "admin"],
    ]);
  });

  it("管理者の admin を外すときは、ほかの有効な管理者の確認と同じトランザクションにする", async () => {
    const res = await admin("PUT", "/api/admin/users/sub-b/roles", { roles: ["grader"] });
    expect(res.status).toBe(200);
    const items = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems;
    expect(items?.[0]?.Update?.Key).toEqual({ PK: "USER#sub-b", SK: "PROFILE" });
    expect(items?.[1]?.ConditionCheck?.Key).toEqual({ PK: "USER#sub-a", SK: "PROFILE" });
  });

  it("自分自身の admin は外せない・最後の管理者は外せない・候補者は変えられない", async () => {
    // 自分（admin のみ）を grader にする指定：拒否し、grader の付与も残さない
    const mine = await admin("PUT", "/api/admin/users/sub-a/roles", { roles: ["grader"] });
    expect(mine.status).toBe(400);
    expect(cognitoMock.commandCalls(AdminAddUserToGroupCommand)).toHaveLength(0);
    expect(auditPuts()).toHaveLength(0);

    // sub-a（実行者）が一覧に出ない状況：sub-b が最後の有効な管理者
    ddbMock.on(ScanCommand).resolves({ Items: [profile("sub-b", ["grader", "admin"])] });
    const last = await admin("PUT", "/api/admin/users/sub-b/roles", { roles: ["grader"] });
    expect(last.status).toBe(409);
    // grader → admin に変える指定でも、最後の管理者の admin を外すなら付与の前に拒否する
    users.set("sub-b", profile("sub-b", ["admin"]));
    const swap = await admin("PUT", "/api/admin/users/sub-b/roles", { roles: ["grader"] });
    expect(swap.status).toBe(409);
    expect(cognitoMock.commandCalls(AdminAddUserToGroupCommand)).toHaveLength(0);

    const cand = await admin("PUT", "/api/admin/users/sub-c/roles", { roles: ["grader"] });
    expect(cand.status).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("不正な本文は 400、存在しない利用者は 404", async () => {
    const put = (sub: string, body: unknown) => admin("PUT", `/api/admin/users/${sub}/roles`, body);
    expect((await put("sub-t", { roles: [] })).status).toBe(400);
    expect((await put("sub-t", { roles: ["candidate"] })).status).toBe(400);
    expect((await put("sub-t", { roles: ["admin", "admin"] })).status).toBe(400);
    expect((await put("sub-t", { roles: ["admin"], extra: 1 })).status).toBe(400);
    expect((await put("nobody", { roles: ["admin"] })).status).toBe(404);
  });
});

describe("POST /api/admin/users/:sub/disable", () => {
  it("DynamoDB → Cognito の順に無効化し、管理者の操作として記録する", async () => {
    const order: string[] = [];
    ddbMock.on(UpdateCommand, { TableName: "table" }).callsFake(() => {
      order.push("ddb");
      return {};
    });
    cognitoMock.on(AdminDisableUserCommand).callsFake(() => {
      order.push("cognito");
      return {};
    });
    const res = await admin("POST", "/api/admin/users/sub-g/disable");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { disabled: boolean }).disabled).toBe(true);
    expect(order).toEqual(["ddb", "cognito"]);
    expect(auditPuts()[0]?.Item).toMatchObject({
      action: "user.disable",
      target: { type: "user", id: "sub-g" },
      actor: { type: "admin", sub: "sub-a" },
    });
  });

  it("自分自身は 400、存在しない利用者は 404", async () => {
    expect((await admin("POST", "/api/admin/users/sub-a/disable")).status).toBe(400);
    expect((await admin("POST", "/api/admin/users/nobody/disable")).status).toBe(404);
    expect(cognitoMock.commandCalls(AdminDisableUserCommand)).toHaveLength(0);
  });
});

describe("GET /api/admin/audit", () => {
  it("月の指定がなければ今月（JST）を、新しい順で読む", async () => {
    ddbMock.on(QueryCommand, { TableName: "audit" }).resolves({ Items: [] });
    const res = await admin("GET", "/api/admin/audit");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
    const q = ddbMock.commandCalls(QueryCommand).find((c) => c.args[0].input.TableName === "audit");
    expect(q?.args[0].input.ExpressionAttributeValues).toEqual({ ":pk": "AUDIT#202611" });
    expect(q?.args[0].input.ScanIndexForward).toBe(false);
  });

  it("月（YYYY-MM）と操作の種類で絞り込む。不正な値は 400", async () => {
    ddbMock.on(QueryCommand, { TableName: "audit" }).resolves({ Items: [] });
    expect((await admin("GET", "/api/admin/audit?month=2026-10&action=user.roles")).status).toBe(
      200,
    );
    const q = ddbMock.commandCalls(QueryCommand).find((c) => c.args[0].input.TableName === "audit");
    expect(q?.args[0].input.ExpressionAttributeValues).toEqual({
      ":pk": "AUDIT#202610",
      ":action": "user.roles",
    });
    expect((await admin("GET", "/api/admin/audit?month=202610")).status).toBe(400);
    expect((await admin("GET", "/api/admin/audit?month=2026-13")).status).toBe(400);
    expect((await admin("GET", "/api/admin/audit?action=user.delete")).status).toBe(400);
  });
});
