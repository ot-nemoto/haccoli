import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-northeast-1" }));
const ddbMock = mockClient(ddb);
const NOW = "2026-11-20T03:00:00.000Z";
const files = {
  createUploadPost: vi.fn(async (key: string) => ({
    url: "https://bucket.s3.ap-northeast-1.amazonaws.com/",
    fields: { key, Policy: "p", "X-Amz-Signature": "s" },
  })),
  inspect: vi.fn(),
  delete: vi.fn(),
};
const app = createApp({ ddb, tableName: "t", now: () => new Date(NOW), files });

const user = { sub: "me", name: "山田", role: "candidate", disabled: false };
const exam = {
  examId: "ex",
  title: "課題",
  intro: "# はじめに",
  questions: [
    { qid: "q1", type: "text", body: "問1", maxLength: 100, rubric: { body: "秘密の基準" } },
    {
      qid: "q2",
      type: "choice",
      body: "問2",
      multiple: false,
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      rubric: { correct: ["a"], points: 5 },
    },
    { qid: "q3", type: "file", body: "問3", file: { maxSizeMB: 20, extensions: [".zip"] } },
  ],
};
const attempt = {
  SK: "META",
  attemptId: "at1",
  candidateSub: "me",
  candidateName: "山田",
  examId: "ex",
  examVersion: 801,
  examTitle: "課題",
  status: "IN_PROGRESS",
  issuedAt: "2026-11-01T00:00:00.000Z",
  deadlineAt: "2026-11-30T14:59:59.999Z",
  startedAt: "2026-11-02T00:00:00.000Z",
};

function setup(a: Record<string, unknown> = {}, answers: Record<string, unknown>[] = []) {
  ddbMock
    .on(GetCommand, { Key: { PK: "USER#me", SK: "PROFILE" } })
    .resolves({ Item: user })
    .on(GetCommand, { Key: { PK: "ATTEMPT#at1", SK: "META" } })
    .resolves({ Item: { ...attempt, ...a } })
    .on(GetCommand, { Key: { PK: "EXAM#ex", SK: "V#000801" } })
    .resolves({ Item: { definition: exam } })
    .on(QueryCommand, { KeyConditionExpression: "PK = :pk" })
    .resolves({ Items: [{ ...attempt, ...a }, ...answers] });
}

const event = {
  requestContext: {
    authorizer: {
      jwt: { claims: { sub: "me", token_use: "access", "cognito:groups": "[candidate]" } },
    },
  },
} as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

const call = (path: string, init: RequestInit = {}) =>
  app.request(`/api/candidate${path}`, init, { event });
const put = (path: string, body: unknown) =>
  call(path, {
    method: "PUT",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  ddbMock.reset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("GET /attempts", () => {
  it("自分の受験一覧を返し、期限切れはバッチ前でも EXPIRED にする", async () => {
    setup();
    ddbMock.on(QueryCommand, { IndexName: "GSI1" }).resolves({
      Items: [
        { ...attempt },
        { ...attempt, attemptId: "old", status: "NOT_STARTED", deadlineAt: "2026-11-01T00:00:00Z" },
      ],
    });
    const res = await call("/attempts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attemptId: string; status: string }[];
    expect(body.map((b) => [b.attemptId, b.status])).toEqual([
      ["at1", "IN_PROGRESS"],
      ["old", "EXPIRED"],
    ]);
    expect(JSON.stringify(body)).not.toContain("candidateSub");
  });
});

describe("GET /attempts/:id", () => {
  it("問題と回答を返し、rubric は含めない", async () => {
    setup({}, [{ SK: "ANS#q1", qid: "q1", content: { text: "回答" }, version: 2, updatedAt: NOW }]);
    const res = await call("/attempts/at1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { questions: unknown[] };
    expect(body).toMatchObject({
      intro: "# はじめに",
      status: "IN_PROGRESS",
      answers: { q1: { content: { text: "回答" }, version: 2 } },
    });
    expect(body.questions).toHaveLength(3);
    const text = JSON.stringify(body);
    expect(text).not.toContain("rubric");
    expect(text).not.toContain("秘密の基準");
    expect(text).not.toContain("correct");
  });

  it("開始前は問題を返さない", async () => {
    setup({ status: "NOT_STARTED", startedAt: undefined });
    const body = await (await call("/attempts/at1")).json();
    expect(body).toMatchObject({ status: "NOT_STARTED", questions: [], answers: {} });
  });

  it("他人の受験は 404", async () => {
    setup({ candidateSub: "other" });
    expect((await call("/attempts/at1")).status).toBe(404);
  });
});

describe("PUT /attempts/:id/answers/:qid", () => {
  it("保存して新しい版を返す", async () => {
    setup();
    ddbMock.on(TransactWriteCommand).resolves({});
    const res = await put("/attempts/at1/answers/q2", { content: { selected: ["b"] }, version: 0 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ content: { selected: ["b"] }, version: 1, updatedAt: NOW });
  });

  it.each([
    ["JSON でない", "not json"],
    ["version なし", { content: { text: "a" } }],
    ["余分な項目", { content: { text: "a" }, version: 0, extra: 1 }],
  ])("リクエスト形式が不正（%s）なら 400", async (_, body) => {
    setup();
    const res = await put("/attempts/at1/answers/q1", body);
    expect(res.status).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("回答内容が問題の型に合わなければ 400", async () => {
    setup();
    const res = await put("/attempts/at1/answers/q2", {
      content: { selected: ["a", "b"] },
      version: 0,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION");
  });

  it("版の競合は 409 VERSION_CONFLICT", async () => {
    setup();
    ddbMock.on(TransactWriteCommand).rejects(
      Object.assign(new Error("x"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }],
      }),
    );
    const res = await put("/attempts/at1/answers/q1", { content: { text: "a" }, version: 1 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VERSION_CONFLICT");
  });

  it("期限切れ後は 409 INVALID_STATE", async () => {
    setup({ deadlineAt: "2026-11-19T14:59:59.999Z" });
    ddbMock.on(TransactWriteCommand).rejects(
      Object.assign(new Error("x"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
      }),
    );
    const res = await put("/attempts/at1/answers/q1", { content: { text: "a" }, version: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "INVALID_STATE", message: "受験期限を過ぎています" },
    });
  });
});

describe("POST /attempts/:id/start, submit", () => {
  it("開始する", async () => {
    setup({ status: "NOT_STARTED", startedAt: undefined });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...attempt, startedAt: NOW } });
    const res = await call("/attempts/at1/start", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "IN_PROGRESS", startedAt: NOW });
  });

  it("提出し、未回答の問題を返す", async () => {
    setup({}, [{ SK: "ANS#q1", qid: "q1", content: { text: "回答" }, version: 1, updatedAt: NOW }]);
    ddbMock
      .on(UpdateCommand)
      .resolves({ Attributes: { ...attempt, status: "SUBMITTED", submittedAt: NOW } });
    const res = await call("/attempts/at1/submit", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ submittedAt: NOW, unanswered: ["q2", "q3"] });
  });
});

describe("POST /attempts/:id/answers/:qid/upload-url", () => {
  const post = (qid: string, body: unknown) =>
    call(`/attempts/at1/answers/${qid}/upload-url`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

  it("署名付き POST とキーを返す", async () => {
    setup();
    const res = await post("q3", { fileName: "src.zip", size: 1000 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fileKey: string; url: string; maxBytes: number };
    expect(body.fileKey).toMatch(/^attempts\/at1\/q3\//);
    expect(body.maxBytes).toBe(20 * 1024 * 1024);
    expect(body.url).toContain("s3");
  });

  it.each([
    ["サイズなし", "q3", { fileName: "src.zip" }],
    ["ファイル提出でない問題", "q1", { fileName: "src.zip", size: 1 }],
    ["zip 以外", "q3", { fileName: "src.exe", size: 1 }],
  ])("%s は 400", async (_, qid, body) => {
    setup();
    expect((await post(qid, body)).status).toBe(400);
  });

  it("提出後は 409", async () => {
    setup({ status: "SUBMITTED" });
    expect((await post("q3", { fileName: "src.zip", size: 1 })).status).toBe(409);
  });
});
