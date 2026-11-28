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
import type { FileStore } from "@haccoli/core";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { handle } from "hono/aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminLambdaOptions, createAdminApp } from "./admin-app.js";
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
  files: {
    createUploadUrl: vi.fn(),
    getObjectInfo: vi.fn(),
    deleteObject: vi.fn(),
    createDownloadUrl: vi.fn(async (key: string) => `https://s3.example/${key}`),
  } as unknown as FileStore,
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
  { method: "GET", path: "/api/admin/exams" },
  { method: "GET", path: "/api/admin/summary" },
  { method: "GET", path: "/api/admin/attempts" },
  { method: "POST", path: "/api/admin/attempts" },
  { method: "GET", path: "/api/admin/attempts/:attemptId" },
  { method: "POST", path: "/api/admin/attempts/:attemptId/extend" },
  { method: "POST", path: "/api/admin/attempts/:attemptId/cancel" },
  { method: "POST", path: "/api/admin/attempts/:attemptId/assign" },
  { method: "POST", path: "/api/admin/attempts/:attemptId/answers/:qid/download-url" },
  { method: "GET", path: "/api/admin/exams/:examId/results.csv" },
] as const;

const concrete = (path: string) =>
  path
    .replace(":sub", "sub-t")
    .replace(":attemptId", "att-1")
    .replace(":qid", "q1")
    .replace(":examId", "ex");

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

// ---- 受験（Step 8-2） ----

const ATT = {
  PK: "ATTEMPT#att-1",
  SK: "META",
  GSI2PK: "STATUS#IN_PROGRESS",
  GSI2SK: "2026-12-05T14:59:59.999Z",
  type: "Attempt",
  attemptId: "att-1",
  candidateSub: "sub-c",
  candidateName: "氏名-sub-c",
  examId: "ex",
  examVersion: 2,
  examTitle: "課題",
  status: "IN_PROGRESS",
  issuedAt: "2026-11-01T00:00:00.000Z",
  deadlineAt: "2026-12-05T14:59:59.999Z",
  startedAt: "2026-11-02T00:00:00.000Z",
};

/** 受験 att-1・課題 ex・利用者を返す DynamoDB */
function withAttempt(meta: Record<string, unknown> = ATT, extra: Record<string, unknown>[] = []) {
  ddbMock.on(GetCommand).callsFake((i) => {
    const pk = String(i.Key.PK);
    if (pk.startsWith("USER#")) return { Item: users.get(pk.replace("USER#", "")) };
    if (pk === "ATTEMPT#att-1") return { Item: meta };
    if (pk === "EXAM#ex" && i.Key.SK === "META") {
      return { Item: { examId: "ex", title: "課題", latestVersion: 2, updatedAt: "x" } };
    }
    if (pk === "EXAM#ex") {
      return {
        Item: {
          definition: {
            examId: "ex",
            title: "課題",
            intro: "説明",
            questions: [{ qid: "q1", type: "file", body: "b", rubric: "基準" }],
          },
        },
      };
    }
    return {};
  });
  ddbMock
    .on(QueryCommand, { TableName: "table", KeyConditionExpression: "PK = :pk" })
    .callsFake((i) => ({
      Items: i.ExpressionAttributeValues[":pk"] === "ATTEMPT#att-1" ? [meta, ...extra] : [],
    }));
  ddbMock.on(QueryCommand, { TableName: "table", IndexName: "GSI1" }).callsFake((i) => ({
    Items: [...users.values()].filter(
      (u) => `EMAIL#${u.email}` === i.ExpressionAttributeValues[":pk"],
    ),
  }));
}

/** 監査ログを同じトランザクションで書いた記録 */
const auditInTransaction = () =>
  ddbMock
    .commandCalls(TransactWriteCommand)
    .flatMap((c) => c.args[0].input.TransactItems ?? [])
    .map((t) => t.Put)
    .filter((p) => p?.TableName === "audit")
    .map((p) => p?.Item);

describe("GET /api/admin/exams", () => {
  it("課題の一覧を返す", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          PK: "EXAM#ex",
          SK: "META",
          examId: "ex",
          title: "課題",
          latestVersion: 2,
          updatedAt: "u",
        },
      ],
    });
    const res = await admin("GET", "/api/admin/exams");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { examId: "ex", title: "課題", latestVersion: 2, updatedAt: "u" },
    ]);
  });
});

describe("GET /api/admin/attempts", () => {
  it("状態で絞り込むときは GSI2 を Query し、表示上の状態で返す", async () => {
    ddbMock.on(QueryCommand, { TableName: "table", IndexName: "GSI2" }).resolves({ Items: [ATT] });
    const res = await admin("GET", "/api/admin/attempts?status=IN_PROGRESS&examId=ex&limit=10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { attemptId: string; status: string }[] };
    expect(body.items.map((a) => [a.attemptId, a.status])).toEqual([["att-1", "IN_PROGRESS"]]);
    const q = ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(q?.IndexName).toBe("GSI2");
    expect(q?.ExpressionAttributeValues).toMatchObject({
      ":pk": "STATUS#IN_PROGRESS",
      ":examId": "ex",
    });
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
  });

  it("不正な状態・課題・件数・カーソルは 400", async () => {
    expect((await admin("GET", "/api/admin/attempts?status=DONE")).status).toBe(400);
    expect((await admin("GET", "/api/admin/attempts?examId=")).status).toBe(400);
    expect((await admin("GET", "/api/admin/attempts?limit=0")).status).toBe(400);
    expect((await admin("GET", "/api/admin/attempts?cursor=xxx")).status).toBe(400);
  });
});

describe("GET /api/admin/summary", () => {
  it("状態ごとの件数と、期限が近い受験・採点者が未割り当ての提出を返す", async () => {
    ddbMock
      .on(QueryCommand, { TableName: "table", IndexName: "GSI2" })
      .callsFake((i) =>
        i.Select === "COUNT"
          ? { Count: i.ExpressionAttributeValues[":pk"] === "STATUS#GRADED" ? 4 : 0 }
          : { Items: i.ExpressionAttributeValues[":pk"] === "STATUS#IN_PROGRESS" ? [ATT] : [] },
      );
    const res = await admin("GET", "/api/admin/summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.counts).toMatchObject({ GRADED: 4, IN_PROGRESS: 0 });
    expect(body).toMatchObject({ dueSoonDays: 3, dueSoonTotal: 1, unassignedTotal: 0 });
  });
});

describe("POST /api/admin/attempts", () => {
  it("発行し、実行者を管理者として同じトランザクションで記録する", async () => {
    withAttempt();
    const res = await admin("POST", "/api/admin/attempts", {
      email: "sub-c@example.com",
      examId: "ex",
      deadline: "2026-12-10",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      candidateSub: "sub-c",
      examVersion: 2,
      status: "NOT_STARTED",
      deadlineAt: "2026-12-10T14:59:59.999Z",
    });
    expect(auditInTransaction()).toEqual([
      expect.objectContaining({
        action: "attempt.issue",
        actor: { type: "admin", sub: "sub-a", name: "氏名-sub-a" },
      }),
    ]);
  });

  it("当日・過去の期限、候補者でない人、不正な本文は 400（書き込まない）", async () => {
    withAttempt();
    const post = (body: unknown) => admin("POST", "/api/admin/attempts", body);
    const today = await post({ email: "sub-c@example.com", examId: "ex", deadline: "2026-11-28" });
    expect(today.status).toBe(400);
    expect(((await today.json()) as { error: { message: string } }).error.message).toContain(
      "翌日以降",
    );
    expect(
      (await post({ email: "sub-g@example.com", examId: "ex", deadline: "2026-12-10" })).status,
    ).toBe(400);
    expect(
      (await post({ email: "sub-c@example.com", examId: "ex", deadline: "12/10" })).status,
    ).toBe(400);
    expect(
      (
        await post({
          email: "sub-c@example.com",
          examId: "ex",
          deadline: "2026-12-10",
          force: true,
        })
      ).status,
    ).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe("GET /api/admin/attempts/:attemptId", () => {
  it("候補者のメールアドレス・採点基準・回答・割り当て・すべての採点者の採点を返す", async () => {
    withAttempt({ ...ATT, status: "GRADING", submittedAt: "2026-11-03T00:00:00.000Z" }, [
      {
        PK: "ATTEMPT#att-1",
        SK: "ANS#q1",
        qid: "q1",
        content: { fileKey: "attempts/att-1/q1/a.zip", fileName: "a.zip" },
        version: 1,
        updatedAt: "u1",
      },
      {
        PK: "ATTEMPT#att-1",
        SK: "ASSIGN#sub-g",
        graderSub: "sub-g",
        graderName: "氏名-sub-g",
        assignedAt: "a1",
        status: "DONE",
        finalizedAt: "f1",
      },
      {
        PK: "ATTEMPT#att-1",
        SK: "ASSIGN#sub-t",
        graderSub: "sub-t",
        graderName: "氏名-sub-t",
        assignedAt: "a2",
        status: "DRAFT",
      },
      {
        PK: "ATTEMPT#att-1",
        SK: "GRADE#sub-g",
        graderSub: "sub-g",
        items: { q1: { score: 3, comment: "c" } },
        overallComment: "総評",
        version: 2,
        updatedAt: "g1",
        finalizedAt: "f1",
      },
      {
        PK: "ATTEMPT#att-1",
        SK: "GRADE#sub-t",
        graderSub: "sub-t",
        items: {},
        overallComment: "",
        version: 1,
        updatedAt: "g2",
      },
    ]);
    const res = await admin("GET", "/api/admin/attempts/att-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      attempt: { attemptId: "att-1", status: "GRADING" },
      candidateEmail: "sub-c@example.com",
      intro: "説明",
      questions: [{ qid: "q1", rubric: "基準" }],
      answers: { q1: { updatedAt: "u1" } },
    });
    expect((body.assignments as unknown[]).length).toBe(2);
    expect(body.grades).toEqual([
      {
        graderSub: "sub-g",
        items: { q1: { score: 3, comment: "c" } },
        overallComment: "総評",
        updatedAt: "g1",
        finalizedAt: "f1",
      },
      { graderSub: "sub-t", items: {}, overallComment: "", updatedAt: "g2" },
    ]);
  });

  it("存在しない受験は 404", async () => {
    withAttempt();
    expect((await admin("GET", "/api/admin/attempts/nope")).status).toBe(404);
  });
});

describe("POST /api/admin/attempts/:attemptId/extend・cancel", () => {
  it("期限を変更し、管理者の操作として記録する", async () => {
    withAttempt({ ...ATT, status: "EXPIRED", GSI2PK: "STATUS#EXPIRED" });
    const res = await admin("POST", "/api/admin/attempts/att-1/extend", { deadline: "2026-12-20" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "IN_PROGRESS",
      deadlineAt: "2026-12-20T14:59:59.999Z",
    });
    expect(auditInTransaction()[0]).toMatchObject({
      action: "attempt.extend",
      actor: { type: "admin", sub: "sub-a" },
    });
    expect(
      (await admin("POST", "/api/admin/attempts/att-1/extend", { deadline: "2026-11-28" })).status,
    ).toBe(400);
  });

  it("取り消し、管理者の操作として記録する。提出済みは 409", async () => {
    withAttempt();
    const res = await admin("POST", "/api/admin/attempts/att-1/cancel");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "CANCELED" });
    expect(auditInTransaction()[0]).toMatchObject({
      action: "attempt.cancel",
      actor: { type: "admin", sub: "sub-a" },
    });

    withAttempt({ ...ATT, status: "SUBMITTED" });
    expect((await admin("POST", "/api/admin/attempts/att-1/cancel")).status).toBe(409);
  });
});

describe("POST /api/admin/attempts/:attemptId/assign", () => {
  it("採点者を割り当て、管理者の操作として記録する。割り当て済みは skipped", async () => {
    withAttempt({ ...ATT, status: "SUBMITTED" }, [
      {
        PK: "ATTEMPT#att-1",
        SK: "ASSIGN#sub-t",
        graderSub: "sub-t",
        graderName: "氏名-sub-t",
        assignedAt: "a",
        status: "ASSIGNED",
      },
    ]);
    const res = await admin("POST", "/api/admin/attempts/att-1/assign", {
      graderEmails: ["sub-g@example.com", "sub-t@example.com"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      assigned: [{ sub: "sub-g", name: "氏名-sub-g" }],
      skipped: [{ sub: "sub-t", name: "氏名-sub-t" }],
    });
    expect(auditInTransaction()).toEqual([
      expect.objectContaining({
        action: "attempt.assign",
        actor: expect.objectContaining({ type: "admin" }),
      }),
    ]);
  });

  it("採点者でない人・空の指定は 400、期限切れの受験は 409", async () => {
    withAttempt({ ...ATT, status: "SUBMITTED" });
    const assign = (body: unknown) => admin("POST", "/api/admin/attempts/att-1/assign", body);
    expect((await assign({ graderEmails: ["sub-c@example.com"] })).status).toBe(400);
    expect((await assign({ graderEmails: [] })).status).toBe(400);
    withAttempt({ ...ATT, status: "EXPIRED" });
    expect((await assign({ graderEmails: ["sub-g@example.com"] })).status).toBe(409);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe("POST /api/admin/attempts/:attemptId/answers/:qid/download-url", () => {
  it("提出ファイルの署名付き URL を返す（割り当てがなくても管理者は読める）", async () => {
    withAttempt({ ...ATT, status: "SUBMITTED" }, [
      {
        PK: "ATTEMPT#att-1",
        SK: "ANS#q1",
        qid: "q1",
        content: { fileKey: "attempts/att-1/q1/a.zip", fileName: "a.zip" },
        version: 1,
        updatedAt: "u",
      },
    ]);
    const res = await admin("POST", "/api/admin/attempts/att-1/answers/q1/download-url");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://s3.example/attempts/att-1/q1/a.zip" });
    expect((await admin("POST", "/api/admin/attempts/att-1/answers/q9/download-url")).status).toBe(
      404,
    );
  });
});

describe("GET /api/admin/exams/:examId/results.csv", () => {
  it("CSV を返し、管理者の操作として出力を記録する", async () => {
    withAttempt({ ...ATT, status: "SUBMITTED", submittedAt: "2026-11-03T00:00:00.000Z" });
    ddbMock.on(ScanCommand).resolves({ Items: [ATT] });
    const res = await admin("GET", "/api/admin/exams/ex/results.csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="results-ex.csv"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // text() は BOM を取り除くため、バイト列で確かめる（Excel で文字化けしないよう BOM を付ける）
    const bytes = Buffer.from(await res.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = bytes.toString("utf8");
    expect(csv.startsWith("\uFEFFattemptId,examVersion,candidateName,candidateEmail,")).toBe(true);
    expect(csv).toContain("att-1,2,氏名-sub-c,sub-c@example.com,SUBMITTED（提出済み）");
    const audit = auditPuts()[0]?.Item;
    expect(audit).toMatchObject({
      action: "result.export",
      target: { type: "exam", id: "ex" },
      actor: { type: "admin", sub: "sub-a" },
    });
    // 監査ログには個人情報を入れない
    expect(JSON.stringify(audit)).not.toMatch(/example\.com|氏名-sub-c/);
  });

  it("大きすぎる課題は 413（CLI を案内し、出力を記録しない）", async () => {
    withAttempt({ ...ATT, status: "SUBMITTED" });
    ddbMock.on(ScanCommand).resolves({
      Items: Array.from({ length: 1001 }, (_, i) => ({ ...ATT, attemptId: `a${i}` })),
    });
    const res = await admin("GET", "/api/admin/exams/ex/results.csv");
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      error: { code: "TOO_LARGE", message: expect.stringContaining("CLI の result:export") },
    });
    expect(auditPuts()).toHaveLength(0);
  });

  it("存在しない課題は 404（出力を記録しない）", async () => {
    withAttempt();
    expect((await admin("GET", "/api/admin/exams/nope/results.csv")).status).toBe(404);
    expect(auditPuts()).toHaveLength(0);
  });
});

describe("管理者 API の Lambda（hono/aws-lambda を通す）", () => {
  /** API Gateway（HTTP API）から Lambda に届くイベント */
  const lambdaEvent = (path: string) =>
    ({
      version: "2.0",
      routeKey: "ANY /api/admin/{proxy+}",
      rawPath: path,
      rawQueryString: "",
      headers: { host: "example.execute-api.ap-northeast-1.amazonaws.com" },
      isBase64Encoded: false,
      requestContext: {
        domainName: "example.execute-api.ap-northeast-1.amazonaws.com",
        http: { method: "GET", path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "t" },
        authorizer: { jwt: { claims: ADMIN, scopes: [] } },
        requestId: "r",
        routeKey: "ANY /api/admin/{proxy+}",
        stage: "$default",
        time: "",
        timeEpoch: 0,
      },
    }) as unknown as Parameters<ReturnType<typeof handle>>[0];

  it("採点結果の CSV は base64 で返し、先頭の BOM を残す（テキストで返すとアダプターが BOM を取り除く）", async () => {
    withAttempt({ ...ATT, status: "SUBMITTED" });
    ddbMock.on(ScanCommand).resolves({ Items: [ATT] });
    const handler = handle(createAdminApp(deps), adminLambdaOptions);
    const res = (await handler(lambdaEvent("/api/admin/exams/ex/results.csv"))) as {
      statusCode: number;
      body: string;
      isBase64Encoded: boolean;
      headers: Record<string, string>;
    };
    expect(res.statusCode).toBe(200);
    expect(res.isBase64Encoded).toBe(true);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    const bytes = Buffer.from(res.body, "base64");
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8")).toContain("attemptId,examVersion,candidateName");
  });

  it("JSON の応答は、これまでどおりテキストで返す", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });
    const handler = handle(createAdminApp(deps), adminLambdaOptions);
    const res = (await handler(lambdaEvent("/api/admin/exams"))) as {
      statusCode: number;
      body: string;
      isBase64Encoded: boolean;
    };
    expect(res.statusCode).toBe(200);
    expect(res.isBase64Encoded).toBe(false);
    expect(JSON.parse(res.body)).toEqual([]);
  });
});
