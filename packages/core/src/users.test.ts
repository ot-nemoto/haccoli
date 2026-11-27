import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { registerUser, UserAlreadyExistsError } from "./users.js";

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-northeast-1" }));
const ddbMock = mockClient(ddb);

const deps = {
  cognito: new CognitoIdentityProviderClient({ region: "ap-northeast-1" }),
  ddb,
  userPoolId: "pool",
  tableName: "table",
  auditTableName: "audit",
  actor: { type: "iam" as const, arn: "arn:aws:iam::123456789012:user/test" },
  now: () => new Date("2026-11-19T00:00:00Z"),
};

describe("registerUser", () => {
  beforeEach(() => {
    cognitoMock.reset();
    ddbMock.reset();
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    cognitoMock
      .on(AdminCreateUserCommand)
      .resolves({ User: { Attributes: [{ Name: "sub", Value: "sub-1" }] } });
  });

  it("Cognito ユーザー作成・グループ付与・プロフィール保存を行う", async () => {
    const profile = await registerUser(deps, {
      email: " Cand@Example.com ",
      name: "山田 太郎",
      roles: ["candidate"],
    });

    expect(profile).toEqual({
      sub: "sub-1",
      email: "cand@example.com",
      name: "山田 太郎",
      roles: ["candidate"],
      disabled: false,
      createdAt: "2026-11-19T00:00:00.000Z",
    });

    const create = cognitoMock.commandCalls(AdminCreateUserCommand)[0]?.args[0].input;
    expect(create?.MessageAction).toBe("SUPPRESS");
    expect(create?.Username).toBe("cand@example.com");

    const pwd = cognitoMock.commandCalls(AdminSetUserPasswordCommand)[0]?.args[0].input;
    expect(pwd?.Permanent).toBe(true);
    expect(pwd?.Password?.length).toBeGreaterThanOrEqual(64);

    const group = cognitoMock.commandCalls(AdminAddUserToGroupCommand)[0]?.args[0].input;
    expect(group?.GroupName).toBe("candidate");

    const puts = ddbMock.commandCalls(PutCommand).map((c) => c.args[0].input);
    const put = puts.find((p) => p.TableName === "table");
    expect(put?.Item).toMatchObject({
      PK: "USER#sub-1",
      SK: "PROFILE",
      GSI1PK: "EMAIL#cand@example.com",
      roles: ["candidate"],
    });
    // 実行前に STARTED、成功後に SUCCEEDED と sub を記録する。メールアドレス・氏名は記録しない
    const started = puts.find((p) => p.TableName === "audit");
    expect(started?.Item).toMatchObject({ action: "user.add", status: "STARTED" });
    expect(JSON.stringify(started?.Item)).not.toMatch(/example\.com|山田/);
    const finished = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(finished?.TableName).toBe("audit");
    expect(finished?.ExpressionAttributeValues).toMatchObject({
      ":status": "SUCCEEDED",
      ":target": { type: "user", id: "sub-1" },
    });
  });

  it("登録済みメールアドレスはエラー", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ sub: "x", email: "cand@example.com" }] });
    await expect(
      registerUser(deps, { email: "cand@example.com", name: "x", roles: ["grader"] }),
    ).rejects.toBeInstanceOf(UserAlreadyExistsError);
    expect(cognitoMock.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });

  it("DynamoDB 保存に失敗したら Cognito ユーザーを削除して巻き戻す", async () => {
    ddbMock.on(PutCommand, { TableName: "table" }).rejects(new Error("boom"));
    await expect(
      registerUser(deps, { email: "cand@example.com", name: "x", roles: ["candidate"] }),
    ).rejects.toThrow("boom");
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(1);
    expect(
      ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input.ExpressionAttributeValues,
    ).toMatchObject({ ":status": "FAILED", ":error": "Error: boom" });
  });
});
