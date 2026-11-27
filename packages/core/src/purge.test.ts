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

function withData(u: Record<string, unknown> | undefined, attempts: Record<string, unknown>[]) {
  ddbMock
    .on(QueryCommand, {
      IndexName: "GSI1",
      ExpressionAttributeValues: { ":pk": "EMAIL#cand@example.com" },
    })
    .resolves({ Items: u ? [u] : [] })
    .on(QueryCommand, { IndexName: "GSI1", ExpressionAttributeValues: { ":pk": "CAND#cand" } })
    .resolves({ Items: attempts });
  for (const a of attempts) {
    ddbMock
      .on(QueryCommand, { ExpressionAttributeValues: { ":pk": String(a.PK) } })
      .resolves({ Items: [a, ...children(String(a.attemptId))] });
  }
}

beforeEach(() => {
  ddbMock.reset();
  cognitoMock.reset();
  versions.clear();
  vi.clearAllMocks();
  ddbMock.on(BatchWriteCommand).resolves({});
  ddbMock.on(DeleteCommand).resolves({});
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
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
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
    const deletes = ddbMock.commandCalls(DeleteCommand).map((c) => c.args[0].input.Key);
    expect(deletes).toEqual([
      { PK: "ATTEMPT#a1", SK: "META" },
      { PK: "USER#cand", SK: "PROFILE" },
    ]);
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
    ddbMock
      .on(BatchWriteCommand)
      .resolvesOnce({
        UnprocessedItems: {
          t: [{ DeleteRequest: { Key: { PK: "ATTEMPT#a1", SK: "GRADE#g1" } } }],
        },
      })
      .resolves({});
    const plan = await planPurge(deps, "cand@example.com");
    await executePurge(deps, plan);
    const calls = ddbMock.commandCalls(BatchWriteCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args[0].input.RequestItems?.t).toHaveLength(1);
  });
});
