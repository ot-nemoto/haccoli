import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AttemptRecord,
  cancelAttempt,
  createUploadUrl,
  expireAttempts,
  extendAttempt,
  saveAnswer,
} from "./attempts.js";
import { NotFoundError, StateError, ValidationError } from "./errors.js";
import { parseExamDefinition } from "./exams.js";
import type { FileStore } from "./files.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-northeast-1" }));
const ddbMock = mockClient(ddb);
const NOW = "2026-11-21T03:00:00.000Z";

const files = {
  createUploadPost: vi.fn(async (key: string, maxBytes: number) => ({
    url: "https://bucket.s3.amazonaws.com/",
    fields: { key, max: String(maxBytes) },
  })),
  inspect: vi.fn(async () => ({
    size: 10,
    head: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    sha256: "f".repeat(64),
  })),
  delete: vi.fn(async () => undefined),
  createDownloadUrl: vi.fn(async () => "https://example.com/dl"),
} satisfies FileStore;
const deps = { ddb, tableName: "t", now: () => new Date(NOW), files };

const exam = parseExamDefinition({
  examId: "ex",
  title: "課題",
  intro: "",
  questions: [
    { qid: "q1", type: "text", body: "b" },
    { qid: "q3", type: "file", body: "b", file: { maxSizeMB: 5 } },
  ],
});
const attempt: AttemptRecord = {
  attemptId: "at1",
  candidateSub: "me",
  candidateName: "山田",
  examId: "ex",
  examVersion: 902,
  examTitle: "課題",
  status: "IN_PROGRESS",
  issuedAt: "2026-11-01T00:00:00.000Z",
  deadlineAt: "2026-11-30T14:59:59.999Z",
  startedAt: "2026-11-02T00:00:00.000Z",
};

function withAttempt(a: Partial<AttemptRecord> = {}, answerItem?: Record<string, unknown>) {
  ddbMock
    .on(GetCommand, { Key: { PK: "ATTEMPT#at1", SK: "META" } })
    .resolves({ Item: { ...attempt, ...a } })
    .on(GetCommand, { Key: { PK: "EXAM#ex", SK: "V#000902" } })
    .resolves({ Item: { definition: exam } })
    .on(GetCommand, { Key: { PK: "ATTEMPT#at1", SK: "ANS#q3" } })
    .resolves({ Item: answerItem });
}

beforeEach(() => {
  ddbMock.reset();
  vi.clearAllMocks();
});

describe("createUploadUrl", () => {
  const req = (over: Partial<Parameters<typeof createUploadUrl>[1]> = {}) =>
    createUploadUrl(deps, {
      attemptId: "at1",
      candidateSub: "me",
      qid: "q3",
      fileName: "src.zip",
      size: 1000,
      ...over,
    });

  it("問題の上限サイズで署名付き POST を発行する", async () => {
    withAttempt();
    const res = await req();
    expect(res.fileKey).toMatch(/^attempts\/at1\/q3\/[0-9a-f-]{36}\/src\.zip$/);
    expect(res.maxBytes).toBe(5 * 1024 * 1024);
    expect(files.createUploadPost).toHaveBeenCalledWith(res.fileKey, 5 * 1024 * 1024);
  });

  it.each([
    ["ファイル提出でない問題", { qid: "q1" }],
    ["zip 以外", { fileName: "src.7z" }],
    ["上限超過", { size: 5 * 1024 * 1024 + 1 }],
  ])("%s は ValidationError", async (_, over) => {
    withAttempt();
    await expect(req(over)).rejects.toBeInstanceOf(ValidationError);
    expect(files.createUploadPost).not.toHaveBeenCalled();
  });

  it("期限後・提出後は発行しない", async () => {
    withAttempt({ deadlineAt: "2026-11-20T14:59:59.999Z" });
    await expect(req()).rejects.toMatchObject({ reason: "EXPIRED" });
    withAttempt({ status: "SUBMITTED" });
    await expect(req()).rejects.toMatchObject({ reason: "ALREADY_SUBMITTED" });
    expect(files.createUploadPost).not.toHaveBeenCalled();
  });

  it("他人の受験は NotFound", async () => {
    withAttempt({ candidateSub: "other" });
    await expect(req()).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("saveAnswer（ファイル）", () => {
  const save = (fileKey = "attempts/at1/q3/new/src.zip", version = 0) =>
    saveAnswer(deps, {
      attemptId: "at1",
      candidateSub: "me",
      qid: "q3",
      content: { fileKey, fileName: "src.zip" },
      version,
    });

  it("S3 の実体を検証し、サイズ・SHA-256 を記録する", async () => {
    withAttempt();
    ddbMock.on(TransactWriteCommand).resolves({});
    await save();
    expect(files.inspect).toHaveBeenCalledWith("attempts/at1/q3/new/src.zip", 5 * 1024 * 1024);
    const put = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems?.[1];
    expect(put?.Put?.Item?.content).toEqual({
      fileKey: "attempts/at1/q3/new/src.zip",
      fileName: "src.zip",
      size: 10,
      sha256: "f".repeat(64),
      uploadedAt: NOW,
    });
    expect(files.delete).not.toHaveBeenCalled();
  });

  it("差し替えたら前のファイルを削除する", async () => {
    withAttempt({}, { content: { fileKey: "attempts/at1/q3/old/src.zip" } });
    ddbMock.on(TransactWriteCommand).resolves({});
    await save("attempts/at1/q3/new/src.zip", 1);
    expect(files.delete).toHaveBeenCalledWith("attempts/at1/q3/old/src.zip");
  });

  it("保存に失敗したら前のファイルは消さない", async () => {
    withAttempt({}, { content: { fileKey: "attempts/at1/q3/old/src.zip" } });
    ddbMock.on(TransactWriteCommand).rejects(
      Object.assign(new Error("x"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }],
      }),
    );
    await expect(save("attempts/at1/q3/new/src.zip", 1)).rejects.toThrow("他の画面");
    expect(files.delete).not.toHaveBeenCalled();
  });

  it("提出後はファイルを読む前に拒否する", async () => {
    withAttempt({ status: "SUBMITTED" });
    await expect(save()).rejects.toBeInstanceOf(StateError);
    expect(files.inspect).not.toHaveBeenCalled();
  });
});

describe("expireAttempts", () => {
  it("期限切れの未着手・回答中を条件付きで EXPIRED にし、競合したものは飛ばす", async () => {
    ddbMock
      .on(UpdateCommand)
      .resolves({})
      .on(UpdateCommand, { Key: { PK: "ATTEMPT#a3", SK: "META" } })
      .rejects(Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" }))
      .on(QueryCommand, { ExpressionAttributeValues: { ":pk": "STATUS#NOT_STARTED", ":now": NOW } })
      .resolves({ Items: [{ attemptId: "a1" }] })
      .on(QueryCommand, { ExpressionAttributeValues: { ":pk": "STATUS#IN_PROGRESS", ":now": NOW } })
      .resolves({ Items: [{ attemptId: "a2" }, { attemptId: "a3" }] });
    await expect(expireAttempts(deps)).resolves.toEqual({ expired: ["a1", "a2"] });
    const queries = ddbMock.commandCalls(QueryCommand).map((c) => c.args[0].input);
    expect(queries.every((q) => q.IndexName === "GSI2")).toBe(true);
    const update = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(update?.ConditionExpression).toBe("#s = :cur AND deadlineAt <= :now");
    expect(update?.ExpressionAttributeValues).toMatchObject({
      ":next": "EXPIRED",
      ":cur": "NOT_STARTED",
      ":gsi2pk": "STATUS#EXPIRED",
    });
  });
});

describe("extendAttempt", () => {
  const extend = (deadline = "2026-12-15") => extendAttempt(deps, { attemptId: "at1", deadline });

  it.each([
    ["開始済みの EXPIRED → IN_PROGRESS", { status: "EXPIRED" as const }, "IN_PROGRESS"],
    [
      "未着手の EXPIRED → NOT_STARTED",
      { status: "EXPIRED" as const, startedAt: undefined },
      "NOT_STARTED",
    ],
    ["回答中はそのまま", {}, "IN_PROGRESS"],
  ])("%s", async (_, a, next) => {
    withAttempt(a);
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...attempt, status: next } });
    await extend();
    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.ExpressionAttributeValues).toMatchObject({
      ":next": next,
      ":cur": (a as Partial<AttemptRecord>).status ?? "IN_PROGRESS",
      ":deadline": "2026-12-15T14:59:59.999Z",
      ":gsi2pk": `STATUS#${next}`,
    });
    expect(input?.UpdateExpression).toContain("GSI2SK = :deadline");
    expect(input?.UpdateExpression).toContain("REMOVE expiredAt");
  });

  it("提出済みは変更できない", async () => {
    withAttempt({ status: "SUBMITTED" });
    await expect(extend()).rejects.toBeInstanceOf(StateError);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("過去日は指定できない", async () => {
    await expect(extend("2026-11-01")).rejects.toThrow("過去");
  });
});

describe("cancelAttempt", () => {
  const cancel = () => cancelAttempt(deps, { attemptId: "at1" });

  it.each([
    ["受験中", {}],
    ["未着手", { status: "NOT_STARTED" as const, startedAt: undefined }],
  ])("%s の受験を取り消す（読み込み時の状態を条件にする）", async (_, a) => {
    withAttempt(a);
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...attempt, ...a, status: "CANCELED", canceledAt: NOW },
    });
    const res = await cancel();
    expect(res.after).toMatchObject({ status: "CANCELED", canceledAt: NOW });
    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.ConditionExpression).toBe("#s = :cur AND deadlineAt > :now");
    expect(input?.ExpressionAttributeValues).toEqual({
      ":canceled": "CANCELED",
      ":cur": (a as Partial<AttemptRecord>).status ?? "IN_PROGRESS",
      ":now": NOW,
      ":gsi2pk": "STATUS#CANCELED",
    });
  });

  it.each([
    ["提出済み", { status: "SUBMITTED" as const }],
    ["採点中", { status: "GRADING" as const }],
    ["期限切れ", { status: "EXPIRED" as const }],
    ["期限が過ぎた受験中（バッチ処理前）", { deadlineAt: "2026-11-20T14:59:59.999Z" }],
    ["取消済み", { status: "CANCELED" as const }],
  ])("%s は取り消せない", async (_, a) => {
    withAttempt(a);
    await expect(cancel()).rejects.toBeInstanceOf(StateError);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("読み込み後に提出された・期限を迎えた場合は StateError", async () => {
    withAttempt();
    ddbMock
      .on(UpdateCommand)
      .rejects(Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" }));
    await expect(cancel()).rejects.toThrow("状態が変わりました");
  });

  it("存在しない受験は NotFound", async () => {
    ddbMock.on(GetCommand).resolves({});
    await expect(cancel()).rejects.toBeInstanceOf(NotFoundError);
  });
});
