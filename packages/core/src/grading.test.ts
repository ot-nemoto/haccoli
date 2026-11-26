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
import type { AttemptRecord } from "./attempts.js";
import { NotFoundError, StateError, ValidationError, VersionConflictError } from "./errors.js";
import { parseExamDefinition } from "./exams.js";
import {
  assignGraders,
  createGraderDownloadUrl,
  finalizeGrade,
  getGraderView,
  listAssignmentsForGrader,
  saveGrade,
  validateGradeItems,
} from "./grading.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-northeast-1" }));
const ddbMock = mockClient(ddb);
const NOW = "2026-11-22T03:00:00.000Z";
const files = {
  createUploadPost: vi.fn(),
  inspect: vi.fn(),
  delete: vi.fn(),
  createDownloadUrl: vi.fn(async (key: string, name: string) => `https://dl/${key}?n=${name}`),
};
const deps = { ddb, tableName: "t", now: () => new Date(NOW), files };

const exam = parseExamDefinition({
  examId: "ex",
  title: "課題",
  intro: "",
  questions: [
    { qid: "q1", type: "text", body: "b", rubric: { body: "基準", points: 10 } },
    { qid: "q2", type: "file", body: "b" },
  ],
});
const attempt: AttemptRecord = {
  attemptId: "at1",
  candidateSub: "cand",
  candidateName: "山田",
  examId: "ex",
  examVersion: 903,
  examTitle: "課題",
  status: "SUBMITTED",
  issuedAt: "2026-11-01T00:00:00.000Z",
  deadlineAt: "2026-11-30T14:59:59.999Z",
  startedAt: "2026-11-02T00:00:00.000Z",
  submittedAt: "2026-11-03T00:00:00.000Z",
};
const assignment = (sub: string, status = "ASSIGNED") => ({
  SK: `ASSIGN#${sub}`,
  graderSub: sub,
  graderName: `採点者${sub}`,
  assignedAt: "2026-11-04T00:00:00.000Z",
  status,
});
const grade = (sub: string, version = 1) => ({
  SK: `GRADE#${sub}`,
  graderSub: sub,
  items: { q1: { score: 8, comment: `${sub} のコメント` } },
  overallComment: "",
  version,
  updatedAt: NOW,
});

function withBundle(a: Partial<AttemptRecord> = {}, children: Record<string, unknown>[] = []) {
  ddbMock
    .on(QueryCommand, { KeyConditionExpression: "PK = :pk" })
    .resolves({ Items: [{ SK: "META", ...attempt, ...a }, ...children] })
    .on(GetCommand, { Key: { PK: "EXAM#ex", SK: "V#000903" } })
    .resolves({ Item: { definition: exam } })
    .on(GetCommand, { Key: { PK: "ATTEMPT#at1", SK: "META" } })
    .resolves({ Item: { ...attempt, ...a } });
}
const txCanceled = (codes: string[]) =>
  Object.assign(new Error("x"), {
    name: "TransactionCanceledException",
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

beforeEach(() => {
  ddbMock.reset();
  vi.clearAllMocks();
});

describe("assignGraders", () => {
  const grader = {
    sub: "g1",
    email: "g1@example.com",
    name: "採点 一郎",
    role: "grader",
    disabled: false,
  };
  const withGrader = (u: Record<string, unknown> = grader) =>
    ddbMock.on(QueryCommand, { IndexName: "GSI1" }).resolves({ Items: [u] });

  it("割り当てを作成し、受験の状態を条件にする（email は保存しない）", async () => {
    withBundle();
    withGrader();
    ddbMock.on(TransactWriteCommand).resolves({});
    const res = await assignGraders(deps, { attemptId: "at1", graderEmails: ["G1@example.com"] });
    expect(res.assigned.map((g) => g.sub)).toEqual(["g1"]);
    const items = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems;
    expect(items?.[0]?.Put?.Item).toMatchObject({
      PK: "ATTEMPT#at1",
      SK: "ASSIGN#g1",
      GSI1PK: "GRADER#g1",
      graderName: "採点 一郎",
      candidateName: "山田",
      status: "ASSIGNED",
    });
    expect(JSON.stringify(items?.[0]?.Put?.Item)).not.toContain("@");
    expect(items?.[1]?.Update?.ExpressionAttributeValues).toEqual({
      ":cur": "SUBMITTED",
      ":prev": 0,
      ":count": 1,
    });
  });

  it("採点完了（GRADED）の受験に追加したら GRADING に戻す", async () => {
    withBundle({ status: "GRADED" });
    withGrader();
    ddbMock.on(TransactWriteCommand).resolves({});
    await assignGraders(deps, { attemptId: "at1", graderEmails: ["g1@example.com"] });
    const items = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems;
    expect(items?.[1]?.Update?.ExpressionAttributeValues).toMatchObject({
      ":cur": "GRADED",
      ":next": "GRADING",
    });
  });

  it("GRADED の受験に 2 人まとめて追加すると、2 人目は GRADING を条件にする", async () => {
    withBundle({ status: "GRADED" }, [assignment("g0", "DONE")]);
    ddbMock
      .on(QueryCommand, {
        IndexName: "GSI1",
        ExpressionAttributeValues: { ":pk": "EMAIL#g1@example.com" },
      })
      .resolves({ Items: [grader] })
      .on(QueryCommand, {
        IndexName: "GSI1",
        ExpressionAttributeValues: { ":pk": "EMAIL#g2@example.com" },
      })
      .resolves({ Items: [{ ...grader, sub: "g2", email: "g2@example.com" }] });
    ddbMock.on(TransactWriteCommand).resolves({});
    const res = await assignGraders(deps, {
      attemptId: "at1",
      graderEmails: ["g1@example.com", "g2@example.com"],
    });
    expect(res.assigned.map((g) => g.sub)).toEqual(["g1", "g2"]);
    const calls = ddbMock.commandCalls(TransactWriteCommand);
    expect(
      calls[0]?.args[0].input.TransactItems?.[1]?.Update?.ExpressionAttributeValues,
    ).toMatchObject({
      ":cur": "GRADED",
      ":next": "GRADING",
      ":prev": 1,
      ":count": 2,
    });
    expect(calls[1]?.args[0].input.TransactItems?.[1]?.Update?.ExpressionAttributeValues).toEqual({
      ":cur": "GRADING",
      ":prev": 2,
      ":count": 3,
    });
  });

  it("割り当て済みの採点者は skipped", async () => {
    withBundle({}, [assignment("g1")]);
    withGrader();
    const res = await assignGraders(deps, { attemptId: "at1", graderEmails: ["g1@example.com"] });
    expect(res.skipped.map((g) => g.sub)).toEqual(["g1"]);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("期限切れ・取消の受験には割り当てない", async () => {
    withGrader();
    withBundle({ status: "IN_PROGRESS", deadlineAt: "2026-11-20T14:59:59.999Z" });
    await expect(
      assignGraders(deps, { attemptId: "at1", graderEmails: ["g1@example.com"] }),
    ).rejects.toBeInstanceOf(StateError);
    withBundle({ status: "CANCELED" });
    await expect(
      assignGraders(deps, { attemptId: "at1", graderEmails: ["g1@example.com"] }),
    ).rejects.toBeInstanceOf(StateError);
  });

  it("候補者・無効化された採点者は割り当てられない", async () => {
    withBundle();
    withGrader({ ...grader, role: "candidate" });
    await expect(
      assignGraders(deps, { attemptId: "at1", graderEmails: ["g1@example.com"] }),
    ).rejects.toBeInstanceOf(ValidationError);
    withGrader({ ...grader, disabled: true });
    await expect(
      assignGraders(deps, { attemptId: "at1", graderEmails: ["g1@example.com"] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("listAssignmentsForGrader", () => {
  it("提出済み以降の受験だけを返す", async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({
        Items: [
          { ...assignment("g1"), attemptId: "a-sub" },
          { ...assignment("g1"), attemptId: "a-prog" },
        ],
      })
      .on(GetCommand, { Key: { PK: "ATTEMPT#a-sub", SK: "META" } })
      .resolves({ Item: { ...attempt, attemptId: "a-sub" } })
      .on(GetCommand, { Key: { PK: "ATTEMPT#a-prog", SK: "META" } })
      .resolves({ Item: { ...attempt, attemptId: "a-prog", status: "IN_PROGRESS" } });
    const res = await listAssignmentsForGrader(deps, "g1");
    expect(res.map((r) => r.attemptId)).toEqual(["a-sub"]);
    expect(res[0]).toMatchObject({ candidateName: "山田", assignmentStatus: "ASSIGNED" });
    expect(res[0]).not.toHaveProperty("candidateSub");
  });
});

describe("getGraderView", () => {
  it("自分の採点だけを含め、他の採点者の採点は含めない", async () => {
    withBundle({}, [assignment("g1"), assignment("g2"), grade("g1"), grade("g2")]);
    const view = await getGraderView(deps, "at1", "g1");
    expect(view.grade?.graderSub).toBe("g1");
    expect(JSON.stringify(view)).not.toContain("g2 のコメント");
    expect(view.exam.questions[0]?.rubric?.body).toBe("基準");
  });

  it.each([
    ["割り当てられていない", {}, [assignment("g2")]],
    ["提出前", { status: "IN_PROGRESS" as const }, [assignment("g1")]],
  ])("%s受験は NotFound", async (_, a, children) => {
    withBundle(a, children);
    await expect(getGraderView(deps, "at1", "g1")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("validateGradeItems", () => {
  it("存在しない問題・配点超過はエラー、空のコメントは落とす", () => {
    expect(() => validateGradeItems(exam, { zz: { score: 1 } })).toThrow("存在しない");
    expect(() => validateGradeItems(exam, { q1: { score: 11 } })).toThrow("配点");
    expect(validateGradeItems(exam, { q1: { score: 10, comment: "" }, q2: { score: 99 } })).toEqual(
      {
        q1: { score: 10 },
        q2: { score: 99 },
      },
    );
  });
});

describe("saveGrade", () => {
  const save = (version = 0) =>
    saveGrade(deps, {
      attemptId: "at1",
      graderSub: "g1",
      items: { q1: { score: 5, comment: "良い" } },
      overallComment: "全体",
      version,
    });

  it("割り当てを DRAFT、受験を GRADING にして採点を保存する", async () => {
    withBundle({}, [assignment("g1")]);
    ddbMock.on(TransactWriteCommand).resolves({});
    await expect(save()).resolves.toEqual({ version: 1, updatedAt: NOW });
    const items = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems;
    expect(items?.[0]?.Update?.ConditionExpression).toBe("attribute_exists(PK) AND #s <> :done");
    expect(items?.[1]?.Put?.Item).toMatchObject({
      SK: "GRADE#g1",
      items: { q1: { score: 5, comment: "良い" } },
      overallComment: "全体",
      version: 1,
    });
    expect(items?.[2]?.Update?.ExpressionAttributeValues).toMatchObject({ ":grading": "GRADING" });
  });

  it("確定済みは書き込まずに拒否する", async () => {
    withBundle({}, [assignment("g1", "DONE")]);
    await expect(save()).rejects.toMatchObject({ reason: "ALREADY_FINALIZED" });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("版の競合は VersionConflictError、書き込み時に確定済みなら ALREADY_FINALIZED", async () => {
    withBundle({}, [assignment("g1")]);
    ddbMock
      .on(TransactWriteCommand)
      .rejects(txCanceled(["None", "ConditionalCheckFailed", "None"]));
    await expect(save(1)).rejects.toBeInstanceOf(VersionConflictError);
    ddbMock
      .on(TransactWriteCommand)
      .rejects(txCanceled(["ConditionalCheckFailed", "None", "None"]));
    await expect(save(1)).rejects.toMatchObject({ reason: "ALREADY_FINALIZED" });
  });
});

describe("finalizeGrade", () => {
  it("下書きがなければ確定できない", async () => {
    withBundle({ status: "GRADING" }, [assignment("g1")]);
    await expect(
      finalizeGrade(deps, { attemptId: "at1", graderSub: "g1", version: 1 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("全員が確定したら受験を GRADED にする", async () => {
    withBundle({ status: "GRADING" }, [assignment("g1", "DRAFT"), grade("g1")]);
    ddbMock.on(TransactWriteCommand).callsFake(() => {
      // 確定後の再取得では DONE になっている
      withBundle({ status: "GRADING" }, [assignment("g1", "DONE"), grade("g1")]);
      return {};
    });
    ddbMock.on(UpdateCommand).resolves({});
    const res = await finalizeGrade(deps, { attemptId: "at1", graderSub: "g1", version: 1 });
    expect(res.attemptStatus).toBe("GRADED");
    const tx = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems;
    expect(tx?.[1]?.Update?.ExpressionAttributeValues).toMatchObject({ ":expected": 1 });
    expect(
      ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input.ExpressionAttributeValues,
    ).toMatchObject({
      ":graded": "GRADED",
      ":grading": "GRADING",
      ":count": 1,
    });
  });

  it("読み込んだ後に採点者が追加されていたら GRADING のまま", async () => {
    withBundle({ status: "GRADING" }, [assignment("g1", "DRAFT"), grade("g1")]);
    ddbMock.on(TransactWriteCommand).callsFake(() => {
      withBundle({ status: "GRADING" }, [assignment("g1", "DONE"), grade("g1")]);
      return {};
    });
    // 割り当て数の条件が合わない（別の採点者が追加された）
    ddbMock
      .on(UpdateCommand)
      .rejects(Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" }));
    const res = await finalizeGrade(deps, { attemptId: "at1", graderSub: "g1", version: 1 });
    expect(res.attemptStatus).toBe("GRADING");
  });

  it("未確定の採点者が残っていれば GRADING のまま", async () => {
    withBundle({ status: "GRADING" }, [
      assignment("g1", "DRAFT"),
      assignment("g2", "DRAFT"),
      grade("g1"),
    ]);
    ddbMock.on(TransactWriteCommand).callsFake(() => {
      withBundle({ status: "GRADING" }, [
        assignment("g1", "DONE"),
        assignment("g2", "DRAFT"),
        grade("g1"),
      ]);
      return {};
    });
    const res = await finalizeGrade(deps, { attemptId: "at1", graderSub: "g1", version: 1 });
    expect(res.attemptStatus).toBe("GRADING");
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("確定済みは再確定できない", async () => {
    withBundle({ status: "GRADING" }, [assignment("g1", "DONE"), grade("g1")]);
    await expect(
      finalizeGrade(deps, { attemptId: "at1", graderSub: "g1", version: 1 }),
    ).rejects.toMatchObject({ reason: "ALREADY_FINALIZED" });
  });
});

describe("createGraderDownloadUrl", () => {
  it("割り当てられた受験の提出ファイルの URL を発行する", async () => {
    withBundle({}, [
      assignment("g1"),
      {
        SK: "ANS#q2",
        qid: "q2",
        content: { fileKey: "attempts/at1/q2/u/src.zip", fileName: "提出.zip" },
        version: 1,
        updatedAt: NOW,
      },
    ]);
    await expect(
      createGraderDownloadUrl(deps, { attemptId: "at1", graderSub: "g1", qid: "q2" }),
    ).resolves.toContain("attempts/at1/q2/u/src.zip");
    expect(files.createDownloadUrl).toHaveBeenCalledWith("attempts/at1/q2/u/src.zip", "提出.zip");
  });

  it("ファイルがない・割り当てがなければ NotFound", async () => {
    withBundle({}, [assignment("g1")]);
    await expect(
      createGraderDownloadUrl(deps, { attemptId: "at1", graderSub: "g1", qid: "q2" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      createGraderDownloadUrl(deps, { attemptId: "at1", graderSub: "other", qid: "q2" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
