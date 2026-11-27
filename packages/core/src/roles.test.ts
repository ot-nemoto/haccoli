import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { StateError, ValidationError } from "./errors.js";
import { rolesProblem } from "./roles.js";
import { addRole, listUsers, migrateRoles, registerUser, removeRole, rolesOf } from "./users.js";

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-northeast-1" }));
const ddbMock = mockClient(ddb);
const deps = {
  cognito: new CognitoIdentityProviderClient({ region: "ap-northeast-1" }),
  ddb,
  userPoolId: "pool",
  tableName: "t",
  auditTableName: "audit",
  actor: { type: "iam" as const, arn: "arn:aws:iam::123456789012:user/test" },
};

const item = (sub: string, roles: string[] | undefined, extra: Record<string, unknown> = {}) => ({
  PK: `USER#${sub}`,
  SK: "PROFILE",
  type: "User",
  sub,
  email: `${sub}@example.com`,
  name: sub,
  ...(roles ? { roles } : {}),
  disabled: false,
  createdAt: "2026-11-01T00:00:00.000Z",
  ...extra,
});

/** 操作の順序（Cognito と DynamoDB のどちらを先に呼んだか） */
let calls: string[];

beforeEach(() => {
  cognitoMock.reset();
  ddbMock.reset();
  calls = [];
  cognitoMock.on(AdminAddUserToGroupCommand).callsFake((i) => {
    calls.push(`cognito:add:${i.GroupName}`);
    return {};
  });
  cognitoMock.on(AdminRemoveUserFromGroupCommand).callsFake((i) => {
    calls.push(`cognito:remove:${i.GroupName}`);
    return {};
  });
  // 監査ログ（auditTableName）の書き込みは数えない
  ddbMock.on(UpdateCommand, { TableName: "t" }).callsFake(() => {
    calls.push("ddb:update");
    return {};
  });
});

/** 業務テーブルへの UpdateCommand（監査ログを除く） */
const tableUpdates = () =>
  ddbMock
    .commandCalls(UpdateCommand)
    .map((c) => c.args[0].input)
    .filter((i) => i.TableName === "t");

/** 管理者（画面）としての操作 */
const asAdmin = (sub: string) => ({
  ...deps,
  actor: { type: "admin" as const, sub, name: "管理者" },
});

const withUser = (u: Record<string, unknown>) => {
  ddbMock.on(QueryCommand).resolves({ Items: [u] });
  ddbMock.on(GetCommand).resolves({ Item: u });
};

describe("rolesProblem / rolesOf", () => {
  it("ロールは 1 つ以上・重複なし・候補者は単独", () => {
    expect(rolesProblem(["grader", "admin"])).toBeUndefined();
    expect(rolesProblem(["candidate"])).toBeUndefined();
    expect(rolesProblem([])).toBeDefined();
    expect(rolesProblem(["grader", "grader"])).toBeDefined();
    expect(rolesProblem(["candidate", "admin"])).toBeDefined();
  });

  it("移行前のアイテム（role のみ）は [role] として読み、順序をそろえる", () => {
    expect(rolesOf({ role: "grader" })).toEqual(["grader"]);
    expect(rolesOf({ roles: ["admin", "grader"] })).toEqual(["grader", "admin"]);
    expect(rolesOf({ roles: ["admin", "unknown"] })).toEqual(["admin"]);
  });
});

describe("registerUser（複数ロール）", () => {
  beforeEach(() => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    cognitoMock
      .on(AdminCreateUserCommand)
      .resolves({ User: { Attributes: [{ Name: "sub", Value: "s1" }] } });
  });

  it("ロールごとにグループを付与し、roles を保存する", async () => {
    const u = await registerUser(deps, {
      email: "a@example.com",
      name: "a",
      roles: ["admin", "grader"],
    });
    expect(u.roles).toEqual(["grader", "admin"]);
    expect(calls).toEqual(["cognito:add:grader", "cognito:add:admin"]);
    const profile = ddbMock.commandCalls(PutCommand).find((c) => c.args[0].input.TableName === "t");
    expect(profile?.args[0].input.Item?.roles).toEqual(["grader", "admin"]);
  });

  it("候補者は他のロールと兼ねられない", async () => {
    await expect(
      registerUser(deps, { email: "a@example.com", name: "a", roles: ["candidate", "admin"] }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(cognitoMock.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });
});

describe("addRole", () => {
  it("Cognito → DynamoDB の順に付与し、移行前の role は削除する", async () => {
    withUser(item("g", undefined, { role: "grader" }));
    const u = await addRole(deps, { email: "g@example.com", role: "admin" });
    expect(u.roles).toEqual(["grader", "admin"]);
    expect(calls).toEqual(["cognito:add:admin", "ddb:update"]);
    const update = tableUpdates()[0];
    expect(update?.UpdateExpression).toBe("SET #rs = :next REMOVE #r");
    expect(update?.ExpressionAttributeValues?.[":next"]).toEqual(["grader", "admin"]);
    // 読み込んだ後に他の操作で変わっていたら失敗させる（移行前のアイテムにも対応）
    // 読み込んだ後に他の操作で変わっていたら失敗させる（移行前のアイテムは role を条件にする）
    expect(update?.ConditionExpression).toBe("attribute_not_exists(#rs) AND #r = :prev");
    expect(update?.ExpressionAttributeValues?.[":prev"]).toBe("grader");
  });

  it("条件には保存されているままの roles（順序・未知の値を含む）を使う", async () => {
    withUser(item("g", ["admin", "x-unknown", "grader"]));
    await removeRole(deps, { email: "g@example.com", role: "admin" });
    const update = tableUpdates()[0];
    expect(update?.ConditionExpression).toBe("#rs = :prev");
    expect(update?.ExpressionAttributeValues?.[":prev"]).toEqual(["admin", "x-unknown", "grader"]);
    expect(update?.ExpressionAttributeValues?.[":next"]).toEqual(["grader"]);
  });

  it("同時に付与されて DynamoDB に入っていれば、グループを外さずに成功とする", async () => {
    withUser(item("g", ["grader"]));
    ddbMock
      .on(UpdateCommand)
      .rejects(Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" }));
    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: item("g", ["grader"]) })
      .resolves({ Item: item("g", ["grader", "admin"]) });
    const u = await addRole(deps, { email: "g@example.com", role: "admin" });
    expect(u.roles).toEqual(["grader", "admin"]);
    expect(calls).toEqual(["cognito:add:admin"]);
  });

  it("DynamoDB で失敗したら Cognito のグループを外して戻す", async () => {
    withUser(item("g", ["grader"]));
    ddbMock
      .on(UpdateCommand)
      .rejects(Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" }));
    await expect(addRole(deps, { email: "g@example.com", role: "admin" })).rejects.toBeInstanceOf(
      StateError,
    );
    expect(calls).toEqual(["cognito:add:admin", "cognito:remove:admin"]);
  });

  it("付与済みでもグループはそろえる（途中で失敗した後の再実行）。無効化された人・候補者には付与できない", async () => {
    withUser(item("g", ["grader", "admin"]));
    await addRole(deps, { email: "g@example.com", role: "admin" });
    expect(calls).toEqual(["cognito:add:admin"]);
    calls = [];
    withUser(item("d", ["grader"], { disabled: true }));
    await expect(addRole(deps, { email: "d@example.com", role: "admin" })).rejects.toThrow(
      "無効化",
    );
    withUser(item("c", ["candidate"]));
    await expect(addRole(deps, { email: "c@example.com", role: "admin" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(calls).toEqual([]);
  });
});

describe("removeRole", () => {
  it("DynamoDB → Cognito の順に外す（DynamoDB を変えた時点で無効になる）", async () => {
    withUser(item("g", ["grader", "admin"]));
    const u = await removeRole(deps, { email: "g@example.com", role: "admin" });
    expect(u.roles).toEqual(["grader"]);
    expect(calls).toEqual(["ddb:update", "cognito:remove:admin"]);
    // 実行前に STARTED、成功後に変更後のロールを記録する
    const started = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(started?.TableName).toBe("audit");
    expect(started?.Item).toMatchObject({
      action: "user.roles",
      status: "STARTED",
      target: { type: "user", id: "g" },
      detail: { removed: "admin", rolesBefore: ["grader", "admin"] },
    });
    const finished = ddbMock
      .commandCalls(UpdateCommand)
      .map((c) => c.args[0].input)
      .find((i) => i.TableName === "audit");
    expect(finished?.ExpressionAttributeValues).toMatchObject({
      ":status": "SUCCEEDED",
      ":detail": {
        removed: "admin",
        rolesBefore: ["grader", "admin"],
        rolesAfter: ["grader"],
        changed: true,
      },
    });
  });

  it("DynamoDB から外れていてもグループは外す（途中で失敗した後の再実行）", async () => {
    withUser(item("g", ["grader"]));
    await removeRole(deps, { email: "g@example.com", role: "admin" });
    expect(calls).toEqual(["cognito:remove:admin"]);
    // グループをそろえた記録は残すが、ロールは変わっていないことがわかるようにする
    const finished = ddbMock
      .commandCalls(UpdateCommand)
      .map((c) => c.args[0].input)
      .find((i) => i.TableName === "audit");
    expect(finished?.ExpressionAttributeValues?.[":detail"]).toMatchObject({ changed: false });
  });

  it("最後のロールは外せない", async () => {
    withUser(item("a", ["admin"]));
    await expect(removeRole(deps, { email: "a@example.com", role: "admin" })).rejects.toThrow(
      "最後のロール",
    );
    expect(calls).toEqual([]);
  });

  describe("管理者（画面）による admin の削除", () => {
    it("自分自身の admin は外せない", async () => {
      withUser(item("me", ["grader", "admin"]));
      await expect(
        removeRole(asAdmin("me"), { email: "me@example.com", role: "admin" }),
      ).rejects.toThrow("自分自身");
      expect(calls).toEqual([]);
      // 拒否した操作は記録しない
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    // 最後の管理者の保護（トランザクション）は admin-guard.test.ts
  });

  it("スーパー管理者（CLI）は最後の管理者でも外せる", async () => {
    withUser(item("b", ["grader", "admin"]));
    await removeRole(deps, { email: "b@example.com", role: "admin" });
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
    expect(calls).toEqual(["ddb:update", "cognito:remove:admin"]);
  });
});

describe("listUsers", () => {
  it("roles に含まれるか、移行前の role が一致する利用者を絞り込む", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [item("a", ["grader", "admin"])] });
    const users = await listUsers(deps, "admin");
    expect(users.map((u) => u.roles)).toEqual([["grader", "admin"]]);
    expect(ddbMock.commandCalls(ScanCommand)[0]?.args[0].input.FilterExpression).toBe(
      "#t = :t AND (contains(#rs, :r) OR #r = :r)",
    );
  });
});

describe("migrateRoles", () => {
  it("role のみのアイテムを roles に書き換え、並行して変わったものは飛ばす", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        item("a", undefined, { role: "candidate" }),
        item("b", undefined, { role: "grader" }),
        item("x", undefined, { role: "unknown" }),
      ],
    });
    ddbMock
      .on(UpdateCommand)
      .resolvesOnce({})
      .rejectsOnce(Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" }));
    expect(await migrateRoles(deps)).toEqual({ migrated: 1, skipped: 2 });
    const first = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(first?.ExpressionAttributeValues).toEqual({
      ":roles": ["candidate"],
      ":role": "candidate",
    });
    expect(first?.ConditionExpression).toBe("attribute_not_exists(#rs) AND #r = :role");
  });
});
