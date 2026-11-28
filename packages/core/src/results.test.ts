import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { NotFoundError } from "./errors.js";
import { exportResultsCsv, type ResultRow, ResultsTooLargeError, resultsCsv } from "./results.js";

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
  ddbMock.on(GetCommand).resolves({
    Item: {
      PK: "EXAM#ex",
      SK: "META",
      examId: "ex",
      title: "課題",
      latestVersion: 1,
      updatedAt: "u",
    },
  });
});

describe("exportResultsCsv", () => {
  it("個人情報を含むため、渡す前に監査ログに記録する", async () => {
    await exportResultsCsv(deps, "ex");
    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item).toMatchObject({
      action: "result.export",
      target: { type: "exam", id: "ex" },
      detail: { attempts: 0, rows: 0 },
      status: "SUCCEEDED",
    });
  });

  it("存在しない課題は NotFound にし、出力を記録しない", async () => {
    ddbMock.on(GetCommand).resolves({});
    await expect(exportResultsCsv(deps, "nope")).rejects.toThrow(NotFoundError);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
  });

  it("受験数・大きさの上限を超えるときは渡さず、出力を記録しない", async () => {
    const meta = (id: string) => ({
      PK: `ATTEMPT#${id}`,
      SK: "META",
      type: "Attempt",
      attemptId: id,
      candidateSub: "c1",
      candidateName: "候補",
      examId: "ex",
      examVersion: 1,
      examTitle: "課題",
      status: "NOT_STARTED",
      issuedAt: "2026-11-01T00:00:00.000Z",
      deadlineAt: "2099-11-30T14:59:59.999Z",
    });
    ddbMock.on(ScanCommand).resolves({ Items: [meta("a1"), meta("a2")] });
    ddbMock.on(QueryCommand).callsFake((i) => ({
      Items: [meta(String(i.ExpressionAttributeValues[":pk"]).replace("ATTEMPT#", ""))],
    }));
    await expect(exportResultsCsv(deps, "ex", { maxAttempts: 1 })).rejects.toThrow(
      ResultsTooLargeError,
    );
    // 受験数の上限は、受験ごとのデータを読む前に確かめる
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    await expect(exportResultsCsv(deps, "ex", { maxBytes: 10 })).rejects.toThrow(
      ResultsTooLargeError,
    );
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);

    // 上限内なら、発行の順に並べて記録してから渡す
    const res = await exportResultsCsv(deps, "ex", { maxAttempts: 2, maxBytes: 10_000 });
    expect(res.rows).toBe(2);
    expect(
      res.csv
        .split("\r\n")
        .slice(1, 3)
        .map((l) => l.split(",")[0]),
    ).toEqual(["a1", "a2"]);
    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item).toMatchObject({
      action: "result.export",
      detail: { attempts: 2, rows: 2 },
    });
  });

  it("記録できなければ結果を渡さない", async () => {
    ddbMock.on(PutCommand).rejects(new Error("denied"));
    await expect(exportResultsCsv(deps, "ex")).rejects.toThrow("denied");
  });
});

describe("resultsCsv", () => {
  const attempt = {
    attemptId: "a1",
    candidateSub: "c1",
    candidateName: "候補 花子",
    examId: "ex",
    examVersion: 2,
    examTitle: "課題",
    status: "GRADED" as const,
    issuedAt: "2026-11-01T00:00:00.000Z",
    deadlineAt: "2026-11-30T14:59:59.999Z",
    submittedAt: "2026-11-20T00:00:00.000Z",
  };
  const rows: ResultRow[] = [
    {
      attempt,
      candidateEmail: "c@example.com",
      assignment: {
        graderSub: "g1",
        graderName: "採点 太郎",
        assignedAt: "2026-11-21T00:00:00.000Z",
        status: "DONE",
        finalizedAt: "2026-11-22T00:00:00.000Z",
      },
      graderEmail: "g@example.com",
      grade: {
        graderSub: "g1",
        items: { q1: { score: 3, comment: "良い,です" }, q2: { score: 1.5 } },
        overallComment: "=SUM(A1)",
        version: 2,
        updatedAt: "2026-11-22T00:00:00.000Z",
      },
    },
    // 採点者を割り当てていない受験は、採点者なしで 1 行
    { attempt: { ...attempt, attemptId: "a2", status: "EXPIRED" }, candidateEmail: "" },
  ];

  it("CLI の result:export と同じ形式（列・BOM・CRLF・引用・式の無害化）", () => {
    expect(resultsCsv([{ qid: "q1", points: 5 }, { qid: "q2" }], rows)).toBe(
      "\uFEFF" +
        [
          "attemptId,examVersion,candidateName,candidateEmail,attemptStatus,submittedAt,graderName,graderEmail,gradeStatus,finalizedAt,totalScore,q1_score(/5),q1_comment,q2_score,q2_comment,overallComment",
          'a1,2,候補 花子,c@example.com,GRADED（採点完了）,2026-11-20T00:00:00.000Z,採点 太郎,g@example.com,DONE（確定）,2026-11-22T00:00:00.000Z,4.5,3,"良い,です",1.5,,\'=SUM(A1)',
          "a2,2,候補 花子,,EXPIRED（期限切れ（未提出））,2026-11-20T00:00:00.000Z,,,,,,,,,,",
        ].join("\r\n") +
        "\r\n",
    );
  });
});
