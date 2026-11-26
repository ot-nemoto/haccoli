import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-northeast-1" }));
const ddbMock = mockClient(ddb);
const NOW = "2026-11-22T03:00:00.000Z";
const files = {
  createUploadPost: vi.fn(),
  inspect: vi.fn(),
  delete: vi.fn(),
  createDownloadUrl: vi.fn(async () => "https://bucket.s3.amazonaws.com/signed"),
};
const app = createApp({ ddb, tableName: "t", now: () => new Date(NOW), files });

const exam = {
  examId: "ex",
  title: "課題",
  intro: "説明",
  questions: [
    { qid: "q1", type: "text", body: "問1", maxLength: 100, rubric: { body: "基準", points: 10 } },
  ],
};
const attempt = {
  SK: "META",
  attemptId: "at1",
  candidateSub: "cand",
  candidateName: "山田",
  examId: "ex",
  examVersion: 701,
  examTitle: "課題",
  status: "SUBMITTED",
  issuedAt: "2026-11-01T00:00:00.000Z",
  deadlineAt: "2026-11-30T14:59:59.999Z",
  startedAt: "2026-11-02T00:00:00.000Z",
  submittedAt: "2026-11-03T00:00:00.000Z",
};

function setup(children: Record<string, unknown>[]) {
  ddbMock
    .on(GetCommand, { Key: { PK: "USER#g1", SK: "PROFILE" } })
    .resolves({ Item: { sub: "g1", name: "採点", role: "grader", disabled: false } })
    .on(GetCommand, { Key: { PK: "EXAM#ex", SK: "V#000701" } })
    .resolves({ Item: { definition: exam } })
    .on(QueryCommand, { KeyConditionExpression: "PK = :pk" })
    .resolves({ Items: [attempt, ...children] });
}

const assigned = {
  SK: "ASSIGN#g1",
  graderSub: "g1",
  graderName: "採点",
  assignedAt: NOW,
  status: "ASSIGNED",
};
const event = {
  requestContext: {
    authorizer: {
      jwt: { claims: { sub: "g1", token_use: "access", "cognito:groups": "[grader]" } },
    },
  },
} as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
const call = (path: string, init: RequestInit = {}) =>
  app.request(`/api/grader${path}`, init, { event });
const send = (method: string, path: string, body: unknown) =>
  call(path, {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  ddbMock.reset();
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("GET /attempts/:id", () => {
  it("課題（rubric 含む）・回答・自分の採点を返し、候補者の email・sub は含めない", async () => {
    setup([
      assigned,
      { SK: "ANS#q1", qid: "q1", content: { text: "回答" }, version: 1, updatedAt: NOW },
    ]);
    const res = await call("/attempts/at1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      candidateName: "山田",
      assignmentStatus: "ASSIGNED",
      answers: { q1: { content: { text: "回答" } } },
      grade: { items: {}, overallComment: "", version: 0 },
    });
    expect(JSON.stringify(body)).toContain("基準");
    expect(body).not.toHaveProperty("candidateSub");
    expect(JSON.stringify(body)).not.toContain('"cand"');
  });

  it("割り当てがなければ 404", async () => {
    setup([]);
    expect((await call("/attempts/at1")).status).toBe(404);
  });
});

describe("PUT /attempts/:id/grade", () => {
  it("下書きを保存する", async () => {
    setup([assigned]);
    ddbMock.on(TransactWriteCommand).resolves({});
    const res = await send("PUT", "/attempts/at1/grade", {
      items: { q1: { score: 7, comment: "良い" } },
      overallComment: "総評",
      version: 0,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 1, updatedAt: NOW });
  });

  it.each([
    ["負の点数", { items: { q1: { score: -1 } }, version: 0 }],
    ["配点超過", { items: { q1: { score: 11 } }, version: 0 }],
    ["存在しない問題", { items: { zz: { score: 1 } }, version: 0 }],
    ["version なし", { items: {} }],
  ])("%s は 400", async (_, body) => {
    setup([assigned]);
    expect((await send("PUT", "/attempts/at1/grade", body)).status).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("形式エラーは不正な項目のパスをログに出す（値は出さない）", async () => {
    setup([assigned]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await send("PUT", "/attempts/at1/grade", {
        items: { q1: { score: -12345 } },
        version: 0,
      });
      expect(res.status).toBe(400);
      const lines = log.mock.calls.map((c) => String(c[0]));
      const line = lines.find((l) => l.includes("client_error"));
      expect(JSON.parse(line ?? "{}")).toMatchObject({
        code: "VALIDATION",
        detail: "items.q1.score",
      });
      expect(lines.join("\n")).not.toContain("-12345");
    } finally {
      log.mockRestore();
    }
  });

  it("確定済みは 409 INVALID_STATE", async () => {
    setup([{ ...assigned, status: "DONE" }]);
    const res = await send("PUT", "/attempts/at1/grade", { items: {}, version: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "INVALID_STATE", message: "採点は確定済みのため変更できません" },
    });
  });
});

describe("POST /attempts/:id/answers/:qid/download-url", () => {
  it("提出ファイルの署名付き URL を返す", async () => {
    setup([
      assigned,
      {
        SK: "ANS#q1",
        qid: "q1",
        content: { fileKey: "attempts/at1/q1/u/a.zip", fileName: "a.zip" },
        version: 1,
        updatedAt: NOW,
      },
    ]);
    const res = await call("/attempts/at1/answers/q1/download-url", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://bucket.s3.amazonaws.com/signed" });
  });
});
