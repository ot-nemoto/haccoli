import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateError, ValidationError } from "./errors.js";
import { executePurge, type FileVersionStore, planPurge } from "./purge.js";
import { UserNotFoundError } from "./users.js";

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-northeast-1" }));
const ddbMock = mockClient(ddb);
const NOW = "2026-11-27T03:00:00.000Z";

const versions = new Map<string, { key: string; versionId: string }[]>();
const fileVersions = {
  listVersions: vi.fn(async (prefix: string) => versions.get(prefix) ?? []),
  deleteVersions: vi.fn(async () => undefined),
} satisfies FileVersionStore;
const deps = {
  cognito: new CognitoIdentityProviderClient({ region: "ap-northeast-1" }),
  ddb,
  userPoolId: "pool",
  tableName: "t",
  now: () => new Date(NOW),
  fileVersions,
};

const user = {
  PK: "USER#cand",
  SK: "PROFILE",
  sub: "cand",
  email: "cand@example.com",
  name: "山田",
  role: "candidate",
  disabled: false,
  createdAt: "2026-11-01T00:00:00.000Z",
};
const attemptMeta = (id: string, status: string) => ({
  PK: `ATTEMPT#${id}`,
  SK: "META",
  attemptId: id,
  candidateSub: "cand",
  candidateName: "山田",
  examId: "ex",
  examVersion: 1,
  examTitle: "課題",
  status,
  issuedAt: "2026-11-01T00:00:00.000Z",
  deadlineAt: "2026-11-30T14:59:59.999Z",
});
const children = (id: string) => [
  { PK: `ATTEMPT#${id}`, SK: "ANS#q1" },
  { PK: `ATTEMPT#${id}`, SK: "ASSIGN#g1" },
  { PK: `ATTEMPT#${id}`, SK: "GRADE#g1" },
];

/** 削除が後続の読み込みに反映される、最小限のテーブルの代用 */
const table = new Map<string, Record<string, unknown>>();
const tkey = (pk: unknown, sk: unknown) => `${String(pk)}|${String(sk)}`;

function withData(u: Record<string, unknown> | undefined, attempts: Record<string, unknown>[]) {
  table.clear();
  if (u) table.set(tkey(u.PK, u.SK), u);
  for (const a of attempts) {
    table.set(tkey(a.PK, a.SK), a);
    for (const c of children(String(a.attemptId))) table.set(tkey(c.PK, c.SK), c);
  }
  const rows = () => [...table.values()];
  ddbMock.on(QueryCommand).callsFake((input) => {
    const pk = input.ExpressionAttributeValues[":pk"] as string;
    if (pk.startsWith("EMAIL#")) {
      return { Items: rows().filter((r) => r.SK === "PROFILE" && `EMAIL#${r.email}` === pk) };
    }
    if (pk.startsWith("CAND#")) {
      return {
        Items: rows().filter((r) => r.SK === "META" && `CAND#${r.candidateSub}` === pk),
      };
    }
    return { Items: rows().filter((r) => r.PK === pk) };
  });
  ddbMock
    .on(GetCommand)
    .callsFake((input) => ({ Item: table.get(tkey(input.Key.PK, input.Key.SK)) }));
  ddbMock.on(DeleteCommand).callsFake((input) => {
    const k = tkey(input.Key.PK, input.Key.SK);
    const cur = table.get(k);
    const expected = input.ExpressionAttributeValues?.[":status"];
    if (expected !== undefined && cur?.status !== expected) {
      throw Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" });
    }
    table.delete(k);
    return {};
  });
}

beforeEach(() => {
  ddbMock.reset();
  cognitoMock.reset();
  versions.clear();
  vi.clearAllMocks();
  ddbMock.on(BatchWriteCommand).callsFake((input) => {
    for (const r of input.RequestItems.t) {
      table.delete(tkey(r.DeleteRequest.Key.PK, r.DeleteRequest.Key.SK));
    }
    return {};
  });
  cognitoMock.on(AdminDeleteUserCommand).resolves({});
});

describe("planPurge", () => {
  it("受験ごとのアイテム数とファイルのバージョン数を数える（削除はしない）", async () => {
    withData(user, [attemptMeta("a1", "GRADED"), attemptMeta("a2", "CANCELED")]);
    versions.set("attempts/a1/", [
      { key: "attempts/a1/q3/u/x.zip", versionId: "v1" },
      { key: "attempts/a1/q3/u/x.zip", versionId: "dm1" },
    ]);
    const plan = await planPurge(deps, "Cand@Example.com");
    expect(plan.user.sub).toBe("cand");
    expect(
      plan.attempts.map((t) => [t.attempt.attemptId, t.itemCount, t.fileVersionCount]),
    ).toEqual([
      ["a1", 4, 2],
      ["a2", 4, 0],
    ]);
    expect(table.size).toBe(9);
    expect(fileVersions.deleteVersions).not.toHaveBeenCalled();
  });

  it.each(["NOT_STARTED", "IN_PROGRESS", "SUBMITTED", "GRADING"])(
    "採点が終わっていない受験（%s）があれば拒否する",
    async (status) => {
      withData(user, [attemptMeta("a1", "GRADED"), attemptMeta("a2", status)]);
      await expect(planPurge(deps, "cand@example.com")).rejects.toBeInstanceOf(StateError);
    },
  );

  it("期限切れ（バッチ処理前を含む）は削除できる", async () => {
    withData(user, [
      { ...attemptMeta("a1", "IN_PROGRESS"), deadlineAt: "2026-11-20T14:59:59.999Z" },
    ]);
    const plan = await planPurge(deps, "cand@example.com");
    expect(plan.attempts[0]?.status).toBe("EXPIRED");
  });

  it("採点者・未登録は対象外", async () => {
    withData({ ...user, role: "grader" }, []);
    await expect(planPurge(deps, "cand@example.com")).rejects.toBeInstanceOf(ValidationError);
    withData(undefined, []);
    await expect(planPurge(deps, "cand@example.com")).rejects.toBeInstanceOf(UserNotFoundError);
  });
});

describe("executePurge", () => {
  it("受験ごとに S3 → 子アイテム → META、最後に Cognito → User の順に削除する", async () => {
    withData(user, [attemptMeta("a1", "GRADED")]);
    versions.set("attempts/a1/", [{ key: "attempts/a1/q3/u/x.zip", versionId: "v1" }]);
    const plan = await planPurge(deps, "cand@example.com");
    await executePurge(deps, plan);

    expect(fileVersions.deleteVersions).toHaveBeenCalledWith([
      { key: "attempts/a1/q3/u/x.zip", versionId: "v1" },
    ]);
    const batch = ddbMock.commandCalls(BatchWriteCommand)[0]?.args[0].input.RequestItems?.t;
    expect(batch?.map((r) => r.DeleteRequest?.Key?.SK)).toEqual([
      "ANS#q1",
      "ASSIGN#g1",
      "GRADE#g1",
    ]);
    const deletes = ddbMock.commandCalls(DeleteCommand).map((c) => c.args[0].input);
    expect(deletes.map((d) => d.Key)).toEqual([
      { PK: "ATTEMPT#a1", SK: "META" },
      { PK: "USER#cand", SK: "PROFILE" },
    ]);
    expect(deletes[0]?.ConditionExpression).toBe("#s = :status");
    expect(table.size).toBe(0);
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)[0]?.args[0].input).toEqual({
      UserPoolId: "pool",
      Username: "cand@example.com",
    });
  });

  it("Cognito のユーザーが削除済みでも続行する（再実行）", async () => {
    withData(user, []);
    cognitoMock
      .on(AdminDeleteUserCommand)
      .rejects(new UserNotFoundException({ message: "not found", $metadata: {} }));
    const plan = await planPurge(deps, "cand@example.com");
    await executePurge(deps, plan);
    expect(ddbMock.commandCalls(DeleteCommand).map((c) => c.args[0].input.Key)).toEqual([
      { PK: "USER#cand", SK: "PROFILE" },
    ]);
  });

  it("未処理のアイテムは再送する", async () => {
    withData(user, [attemptMeta("a1", "GRADED")]);
    let first = true;
    ddbMock.on(BatchWriteCommand).callsFake((input) => {
      const reqs = input.RequestItems.t;
      const done = first ? reqs.slice(0, -1) : reqs;
      for (const r of done) table.delete(tkey(r.DeleteRequest.Key.PK, r.DeleteRequest.Key.SK));
      const rest = first ? reqs.slice(-1) : [];
      first = false;
      return { UnprocessedItems: rest.length ? { t: rest } : {} };
    });
    const plan = await planPurge(deps, "cand@example.com");
    await executePurge(deps, plan);
    const calls = ddbMock.commandCalls(BatchWriteCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args[0].input.RequestItems?.t).toHaveLength(1);
    expect(table.size).toBe(0);
  });

  it("確認の間に受験が発行されたら、何も削除せずに中止する", async () => {
    withData(user, [attemptMeta("a1", "GRADED")]);
    const plan = await planPurge(deps, "cand@example.com");
    const a2 = attemptMeta("a2", "CANCELED");
    table.set(tkey(a2.PK, a2.SK), a2);
    await expect(executePurge(deps, plan)).rejects.toThrow("対象が変わりました");
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    expect(fileVersions.deleteVersions).not.toHaveBeenCalled();
  });

  it("確認の間に採点中へ戻ったら拒否する", async () => {
    withData(user, [attemptMeta("a1", "GRADED")]);
    const plan = await planPurge(deps, "cand@example.com");
    table.set(tkey("ATTEMPT#a1", "META"), attemptMeta("a1", "GRADING"));
    await expect(executePurge(deps, plan)).rejects.toBeInstanceOf(StateError);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
  });

  it("META の削除時に状態が変わっていたら、User を消さずに中止する", async () => {
    withData(user, [attemptMeta("a1", "GRADED")]);
    const plan = await planPurge(deps, "cand@example.com");
    // 子アイテムの削除中に再割り当てされた
    ddbMock.on(BatchWriteCommand).callsFake(() => {
      table.set(tkey("ATTEMPT#a1", "META"), attemptMeta("a1", "GRADING"));
      return {};
    });
    await expect(executePurge(deps, plan)).rejects.toThrow("対象が変わりました");
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
    expect(table.has(tkey("USER#cand", "PROFILE"))).toBe(true);
  });
});
