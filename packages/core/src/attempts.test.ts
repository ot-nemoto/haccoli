import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AttemptRecord,
  effectiveStatus,
  issueAttempt,
  saveAnswer,
  startAttempt,
  submitAttempt,
  validateAnswer,
} from "./attempts.js";
import { NotFoundError, StateError, ValidationError, VersionConflictError } from "./errors.js";
import { parseExamDefinition } from "./exams.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-northeast-1" }));
const ddbMock = mockClient(ddb);
const NOW = "2026-11-20T03:00:00.000Z";
const deps = {
  ddb,
  tableName: "t",
  auditTableName: "audit",
  actor: { type: "iam" as const, arn: "arn:aws:iam::123456789012:user/test" },
  now: () => new Date(NOW),
};

const exam = parseExamDefinition({
  examId: "ex",
  title: "課題",
  intro: "",
  questions: [
    { qid: "q1", type: "text", body: "b", maxLength: 5 },
    {
      qid: "q2",
      type: "choice",
      body: "b",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    },
    {
      qid: "q3",
      type: "choice",
      body: "b",
      multiple: true,
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    },
  ],
});
// 版のキャッシュと衝突しないよう、テスト専用の版番号を使う
const attempt: AttemptRecord = {
  attemptId: "at1",
  candidateSub: "me",
  candidateName: "山田",
  examId: "ex",
  examVersion: 901,
  examTitle: "課題",
  status: "IN_PROGRESS",
  issuedAt: "2026-11-01T00:00:00.000Z",
  deadlineAt: "2026-11-30T14:59:59.999Z",
  startedAt: "2026-11-02T00:00:00.000Z",
};

function withAttempt(a: Partial<AttemptRecord> = {}) {
  ddbMock
    .on(GetCommand, { Key: { PK: "ATTEMPT#at1", SK: "META" } })
    .resolves({ Item: { ...attempt, ...a } })
    .on(GetCommand, { Key: { PK: "EXAM#ex", SK: "V#000901" } })
    .resolves({ Item: { definition: exam } })
    .on(QueryCommand)
    .resolves({ Items: [{ SK: "META", ...attempt, ...a }] });
}

const conditionFailed = () =>
  Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" });
const txCanceled = (codes: string[]) =>
  Object.assign(new Error("canceled"), {
    name: "TransactionCanceledException",
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

beforeEach(() => ddbMock.reset());

describe("effectiveStatus", () => {
  it("期限到来済みの未着手・回答中は EXPIRED、提出済みはそのまま", () => {
    const after = new Date("2026-12-01T00:00:00Z");
    expect(effectiveStatus({ ...attempt, status: "NOT_STARTED" }, after)).toBe("EXPIRED");
    expect(effectiveStatus(attempt, after)).toBe("EXPIRED");
    expect(effectiveStatus({ ...attempt, status: "SUBMITTED" }, after)).toBe("SUBMITTED");
    expect(effectiveStatus(attempt, new Date(NOW))).toBe("IN_PROGRESS");
  });
});

describe("issueAttempt", () => {
  const user = {
    sub: "cand",
    email: "c@example.com",
    name: "候補",
    role: "candidate",
    disabled: false,
    createdAt: "x",
  };

  it("最新版で受験を発行し、GSI のキーを付与する", async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [user] })
      .on(GetCommand)
      .resolves({ Item: { examId: "ex", title: "課題", latestVersion: 2, updatedAt: "x" } });
    const a = await issueAttempt(deps, {
      email: "C@example.com",
      examId: "ex",
      deadline: "2026-11-30",
    });
    expect(a).toMatchObject({
      candidateSub: "cand",
      candidateName: "候補",
      examVersion: 2,
      status: "NOT_STARTED",
      deadlineAt: "2026-11-30T14:59:59.999Z",
    });
    const items = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems;
    const item = items?.[0]?.Put?.Item;
    expect(item).toMatchObject({
      PK: `ATTEMPT#${a.attemptId}`,
      SK: "META",
      GSI1PK: "CAND#cand",
      GSI2PK: "STATUS#NOT_STARTED",
      GSI2SK: "2026-11-30T14:59:59.999Z",
    });
    expect(item).not.toHaveProperty("email");
    // 同じトランザクションで監査ログを書く（メールアドレス・氏名は含めない）
    const audit = items?.[1]?.Put;
    expect(audit?.TableName).toBe("audit");
    expect(audit?.Item).toMatchObject({
      PK: "AUDIT#202611",
      action: "attempt.issue",
      status: "SUCCEEDED",
      actor: deps.actor,
      target: { type: "attempt", id: a.attemptId },
      detail: { candidateSub: "cand", examId: "ex", examVersion: 2 },
    });
    expect(JSON.stringify(audit?.Item)).not.toMatch(/example\.com|候補/);
  });

  it("採点者・無効化された候補者には発行できない", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ ...user, role: "grader" }] });
    await expect(
      issueAttempt(deps, { email: "c@example.com", examId: "ex", deadline: "2026-11-30" }),
    ).rejects.toBeInstanceOf(ValidationError);
    ddbMock.on(QueryCommand).resolves({ Items: [{ ...user, disabled: true }] });
    await expect(
      issueAttempt(deps, { email: "c@example.com", examId: "ex", deadline: "2026-11-30" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("過去日の期限はエラー（DB を見る前に検証する）", async () => {
    await expect(
      issueAttempt(deps, { email: "c@example.com", examId: "ex", deadline: "2026-11-01" }),
    ).rejects.toThrow("過去");
    expect(ddbMock.calls()).toHaveLength(0);
  });
});

describe("startAttempt", () => {
  it("本人・未着手・期限前を条件に IN_PROGRESS にする", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...attempt } });
    await startAttempt(deps, "at1", "me");
    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.ConditionExpression).toBe(
      "candidateSub = :sub AND #s = :cur AND deadlineAt > :now",
    );
    expect(input?.ExpressionAttributeValues).toMatchObject({
      ":sub": "me",
      ":cur": "NOT_STARTED",
      ":now": NOW,
      ":gsi2pk": "STATUS#IN_PROGRESS",
    });
  });

  it("開始済みなら現在の受験を返す（冪等）", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionFailed());
    withAttempt();
    await expect(startAttempt(deps, "at1", "me")).resolves.toMatchObject({ status: "IN_PROGRESS" });
  });

  it("他人の受験は NotFound", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionFailed());
    withAttempt({ status: "NOT_STARTED" });
    await expect(startAttempt(deps, "at1", "other")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("期限切れは EXPIRED", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionFailed());
    withAttempt({ status: "NOT_STARTED", deadlineAt: "2026-11-19T14:59:59.999Z" });
    await expect(startAttempt(deps, "at1", "me")).rejects.toMatchObject({ reason: "EXPIRED" });
  });
});

describe("saveAnswer", () => {
  const save = (over: Partial<Parameters<typeof saveAnswer>[1]> = {}) =>
    saveAnswer(deps, {
      attemptId: "at1",
      candidateSub: "me",
      qid: "q1",
      content: { text: "abc" },
      version: 0,
      ...over,
    });

  it("初回保存は存在しないことを条件に v1 を書き込む", async () => {
    withAttempt();
    ddbMock.on(TransactWriteCommand).resolves({});
    await expect(save()).resolves.toEqual({
      content: { text: "abc" },
      version: 1,
      updatedAt: NOW,
    });
    const items = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems;
    expect(items?.[0]?.ConditionCheck?.ExpressionAttributeValues).toMatchObject({
      ":sub": "me",
      ":cur": "IN_PROGRESS",
    });
    expect(items?.[1]?.Put?.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(items?.[1]?.Put?.Item).toMatchObject({
      SK: "ANS#q1",
      version: 1,
      content: { text: "abc" },
    });
  });

  it("2 回目以降は読み込んだ版を条件にする", async () => {
    withAttempt();
    ddbMock.on(TransactWriteCommand).resolves({});
    await expect(save({ version: 3 })).resolves.toMatchObject({ version: 4 });
    const put = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems?.[1];
    expect(put?.Put?.ExpressionAttributeValues).toEqual({ ":expected": 3 });
  });

  it("版の競合は VersionConflictError", async () => {
    withAttempt();
    ddbMock.on(TransactWriteCommand).rejects(txCanceled(["None", "ConditionalCheckFailed"]));
    await expect(save({ version: 1 })).rejects.toBeInstanceOf(VersionConflictError);
  });

  it("書き込み時に提出済み・期限切れなら StateError", async () => {
    withAttempt({ status: "SUBMITTED" });
    ddbMock.on(TransactWriteCommand).rejects(txCanceled(["ConditionalCheckFailed", "None"]));
    await expect(save()).rejects.toMatchObject({ reason: "ALREADY_SUBMITTED" });
  });

  it("他人の受験には書き込まない", async () => {
    withAttempt({ candidateSub: "other" });
    await expect(save()).rejects.toBeInstanceOf(NotFoundError);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("存在しない問題は NotFound、内容が不正なら ValidationError", async () => {
    withAttempt();
    await expect(save({ qid: "zz" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(save({ content: { text: "123456" } })).rejects.toBeInstanceOf(ValidationError);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe("validateAnswer", () => {
  const [q1, q2, q3] = exam.questions as [
    (typeof exam.questions)[0],
    (typeof exam.questions)[0],
    (typeof exam.questions)[0],
  ];

  it("記述式は文字数（サロゲートペアは 1 文字）で上限を判定し、余分な項目を落とす", () => {
    expect(validateAnswer(q1, { text: "𠮷𠮷𠮷𠮷𠮷" })).toEqual({ text: "𠮷𠮷𠮷𠮷𠮷" });
    expect(() => validateAnswer(q1, { text: "abcdef" })).toThrow("5 文字以内");
    expect(() => validateAnswer(q1, { text: "a", extra: 1 })).toThrow(ValidationError);
    expect(() => validateAnswer(q1, { selected: [] })).toThrow(ValidationError);
  });

  it("選択式は存在する選択肢のみ・単一選択は 1 つまで・重複不可", () => {
    expect(validateAnswer(q2, { selected: ["a"] })).toEqual({ selected: ["a"] });
    expect(validateAnswer(q2, { selected: [] })).toEqual({ selected: [] });
    expect(() => validateAnswer(q2, { selected: ["a", "b"] })).toThrow("1 つだけ");
    expect(() => validateAnswer(q2, { selected: ["z"] })).toThrow("存在しない");
    expect(validateAnswer(q3, { selected: ["a", "b"] })).toEqual({ selected: ["a", "b"] });
    expect(() => validateAnswer(q3, { selected: ["a", "a"] })).toThrow("重複");
  });
});

describe("submitAttempt", () => {
  it("回答中・期限前を条件に提出し、未回答の問題を返す", async () => {
    ddbMock
      .on(GetCommand, { Key: { PK: "EXAM#ex", SK: "V#000901" } })
      .resolves({ Item: { definition: exam } })
      .on(QueryCommand)
      .resolves({
        Items: [
          { SK: "META", ...attempt },
          { SK: "ANS#q1", qid: "q1", content: { text: "  " }, version: 1, updatedAt: NOW },
          { SK: "ANS#q2", qid: "q2", content: { selected: ["a"] }, version: 1, updatedAt: NOW },
        ],
      })
      .on(UpdateCommand)
      .resolves({ Attributes: { ...attempt, status: "SUBMITTED", submittedAt: NOW } });
    const res = await submitAttempt(deps, "at1", "me");
    expect(res.unanswered).toEqual(["q1", "q3"]);
    expect(res.attempt.status).toBe("SUBMITTED");
    expect(
      ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input.ExpressionAttributeValues,
    ).toMatchObject({
      ":cur": "IN_PROGRESS",
      ":gsi2pk": "STATUS#SUBMITTED",
    });
  });

  it("二重提出は ALREADY_SUBMITTED", async () => {
    withAttempt({ status: "SUBMITTED" });
    ddbMock.on(UpdateCommand).rejects(conditionFailed());
    const err = await submitAttempt(deps, "at1", "me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StateError);
    expect(err).toMatchObject({ reason: "ALREADY_SUBMITTED" });
  });
});
