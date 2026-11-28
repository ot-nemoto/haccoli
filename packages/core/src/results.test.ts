import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { NotFoundError } from "./errors.js";
import { collectResults, type ResultRow, resultsCsv } from "./results.js";

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

  it("存在しない課題は NotFound にし、出力を記録しない", async () => {
    ddbMock.on(GetCommand).resolves({});
    await expect(collectResults(deps, "nope")).rejects.toThrow(NotFoundError);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
  });

  it("記録できなければ結果を渡さない", async () => {
    ddbMock.on(PutCommand).rejects(new Error("denied"));
    await expect(collectResults(deps, "ex")).rejects.toThrow("denied");
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
