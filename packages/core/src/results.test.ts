import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { collectResults } from "./results.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-northeast-1" }));
const ddbMock = mockClient(ddb);
const deps = {
  ddb,
  tableName: "t",
  auditTableName: "audit",
  actor: { type: "iam" as const, arn: "arn:aws:iam::123456789012:user/test" },
};

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(ScanCommand).resolves({ Items: [] });
});

describe("collectResults", () => {
  it("個人情報を含むため、渡す前に監査ログに記録する", async () => {
    await collectResults(deps, "ex");
    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item).toMatchObject({
      action: "result.export",
      target: { type: "exam", id: "ex" },
      detail: { attempts: 0, rows: 0 },
      status: "SUCCEEDED",
    });
  });

  it("記録できなければ結果を渡さない", async () => {
    ddbMock.on(PutCommand).rejects(new Error("denied"));
    await expect(collectResults(deps, "ex")).rejects.toThrow("denied");
  });
});
