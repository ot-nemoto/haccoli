import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { ExamDraftDefinition } from "@haccoli/shared";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { issueAttempt } from "./attempts.js";
import { NotFoundError, StateError, ValidationError, VersionConflictError } from "./errors.js";
import {
  ExamAlreadyExistsError,
  examProblems,
  getExamForEdit,
  listExamsWithDrafts,
  publishExamDraft,
  saveExamDraft,
} from "./exam-drafts.js";
import { publishExam } from "./exams.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-northeast-1" }));
const ddbMock = mockClient(ddb);
const NOW = "2026-11-28T03:00:00.000Z";
const deps = {
  ddb,
  tableName: "t",
  auditTableName: "audit",
  actor: { type: "admin" as const, sub: "sub-a", name: "管理 花子" },
  now: () => new Date(NOW),
};
const editor = { sub: "sub-a", name: "管理 花子" };

/** テーブル（PK|SK → アイテム）と監査ログ */
let table: Map<string, Record<string, unknown>>;
let audits: Record<string, unknown>[];
const keyOf = (k: { PK: unknown; SK: unknown }) => `${k.PK}|${k.SK}`;

function canceled(codes: (string | undefined)[]) {
  return Object.assign(new Error("canceled"), {
    name: "TransactionCanceledException",
    CancellationReasons: codes.map((Code) => ({ Code: Code ?? "None" })),
  });
}

/** exams.ts・exam-drafts.ts が使う条件式だけを評価する */
function holds(
  item: Record<string, unknown> | undefined,
  cond: string | undefined,
  values: Record<string, unknown> = {},
): boolean {
  if (!cond) return true;
  if (cond === "attribute_not_exists(PK)") return !item;
  if (cond === "attribute_not_exists(latestVersion)") return item?.latestVersion === undefined;
  if (cond === "latestVersion = :prev") return item?.latestVersion === values[":prev"];
  if (cond === "version = :expected") return item?.version === values[":expected"];
  throw new Error(`未対応の条件式: ${cond}`);
}

beforeEach(() => {
  ddbMock.reset();
  table = new Map();
  audits = [];
  ddbMock.on(GetCommand).callsFake((i) => ({ Item: table.get(keyOf(i.Key)) }));
  ddbMock.on(QueryCommand).callsFake((i) => ({
    Items: [...table.values()].filter((x) => x.PK === i.ExpressionAttributeValues[":pk"]),
  }));
  ddbMock.on(ScanCommand).callsFake((i) => ({
    Items: [...table.values()].filter((x) =>
      Object.values(i.ExpressionAttributeValues ?? {}).includes(x.type),
    ),
  }));
  ddbMock.on(TransactWriteCommand).callsFake((input) => {
    const items = input.TransactItems as Record<string, Record<string, unknown>>[];
    const codes = items.map((t) => {
      const op = (t.Put ?? t.Update) as Record<string, unknown>;
      if (op.TableName === "audit") return undefined;
      const key = keyOf((op.Item ?? op.Key) as { PK: unknown; SK: unknown });
      const ok = holds(
        table.get(key),
        op.ConditionExpression as string | undefined,
        op.ExpressionAttributeValues as Record<string, unknown>,
      );
      return ok ? undefined : "ConditionalCheckFailed";
    });
    if (codes.some(Boolean)) throw canceled(codes);
    for (const t of items) {
      if (t.Put) {
        const put = t.Put as { TableName: string; Item: Record<string, unknown> };
        if (put.TableName === "audit") audits.push(put.Item);
        else table.set(keyOf(put.Item as { PK: unknown; SK: unknown }), put.Item);
      } else if (t.Update) {
        const u = t.Update as {
          Key: { PK: unknown; SK: unknown };
          UpdateExpression: string;
          ExpressionAttributeValues: Record<string, unknown>;
        };
        if (u.UpdateExpression !== "SET publishedVersion = :v, baseVersion = :v") {
          throw new Error(`未対応の更新: ${u.UpdateExpression}`);
        }
        const cur = table.get(keyOf(u.Key)) ?? {};
        const v = u.ExpressionAttributeValues[":v"];
        table.set(keyOf(u.Key), { ...cur, publishedVersion: v, baseVersion: v });
      }
    }
    return {};
  });
});

let seq = 0;
/** テストごとに別の課題 ID（getExamVersion のキャッシュを共有しない） */
const newId = () => `ex-${++seq}`;

const draftOf = (examId: string, over: Partial<ExamDraftDefinition> = {}): ExamDraftDefinition => ({
  examId,
  title: "課題",
  intro: "説明",
  questions: [{ qid: "q1", type: "text", body: "問題文" }],
  ...over,
});

describe("saveExamDraft", () => {
  it("新しい課題は、版の番号のない META と下書き（版 1）を作り、保存を監査ログに残す", async () => {
    const examId = newId();
    const res = await saveExamDraft(deps, {
      examId,
      definition: draftOf(examId, { questions: [] }),
      version: 0,
      baseVersion: 0,
      create: true,
      editor,
    });
    expect(res.draft).toMatchObject({ version: 1, baseVersion: 0, updatedBy: editor });
    // 問題がないなど、公開の前に直すべき点を返す（保存はできる）
    expect(res.problems).toEqual([expect.stringContaining("問題")]);
    expect(table.get(`EXAM#${examId}|META`)).toMatchObject({ type: "Exam", title: "課題" });
    expect(table.get(`EXAM#${examId}|META`)?.latestVersion).toBeUndefined();
    expect(audits).toEqual([
      expect.objectContaining({
        action: "exam.save",
        target: { type: "exam", id: examId },
        detail: { version: 1, baseVersion: 0, questions: 0, created: true },
        actor: { type: "admin", sub: "sub-a", name: "管理 花子" },
      }),
    ]);
  });

  it("既にある課題 ID では新しい課題を作れない", async () => {
    const examId = newId();
    const save = () =>
      saveExamDraft(deps, {
        examId,
        definition: draftOf(examId),
        version: 0,
        baseVersion: 0,
        create: true,
        editor,
      });
    await save();
    await expect(save()).rejects.toThrow(ExamAlreadyExistsError);
  });

  it("楽観ロック：読み込んだ時点より後に保存されていたら、上書きしない", async () => {
    const examId = newId();
    await saveExamDraft(deps, {
      examId,
      definition: draftOf(examId),
      version: 0,
      baseVersion: 0,
      create: true,
      editor,
    });
    const save = (version: number) =>
      saveExamDraft(deps, { examId, definition: draftOf(examId), version, baseVersion: 0, editor });
    await expect(save(1)).resolves.toMatchObject({ draft: { version: 2 } });
    // 別の画面が版 1 を読み込んだまま保存する
    await expect(save(1)).rejects.toThrow(VersionConflictError);
    await expect(save(0)).rejects.toThrow(VersionConflictError);
    expect(audits.filter((a) => a.action === "exam.save")).toHaveLength(2);
  });

  it("課題 ID の変更・存在しない課題・存在しない版を元にした下書き・不正な形は拒否する", async () => {
    const examId = newId();
    await expect(
      saveExamDraft(deps, {
        examId,
        definition: draftOf("other"),
        version: 0,
        baseVersion: 0,
        create: true,
        editor,
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      saveExamDraft(deps, {
        examId,
        definition: draftOf(examId),
        version: 0,
        baseVersion: 0,
        editor,
      }),
    ).rejects.toThrow(NotFoundError);
    await saveExamDraft(deps, {
      examId,
      definition: draftOf(examId),
      version: 0,
      baseVersion: 0,
      create: true,
      editor,
    });
    await expect(
      saveExamDraft(deps, {
        examId,
        definition: draftOf(examId),
        version: 1,
        baseVersion: 3,
        editor,
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      saveExamDraft(deps, {
        examId,
        definition: { ...draftOf(examId), extra: 1 } as unknown as ExamDraftDefinition,
        version: 1,
        baseVersion: 0,
        editor,
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("publishExamDraft", () => {
  async function created(over: Partial<ExamDraftDefinition> = {}) {
    const examId = newId();
    await saveExamDraft(deps, {
      examId,
      definition: draftOf(examId, over),
      version: 0,
      baseVersion: 0,
      create: true,
      editor,
    });
    return examId;
  }

  it("下書きを検証して v1 として公開し、下書きに公開した版を記録する（下書きは消さない）", async () => {
    const examId = await created();
    await expect(publishExamDraft(deps, { examId, version: 1 })).resolves.toMatchObject({
      kind: "published",
      version: 1,
    });
    expect(table.get(`EXAM#${examId}|META`)).toMatchObject({ latestVersion: 1 });
    expect(table.get(`EXAM#${examId}|V#000001`)).toMatchObject({
      title: "課題",
      definition: { questions: [{ qid: "q1", maxLength: 20_000 }] },
    });
    expect(table.get(`EXAM#${examId}|DRAFT`)).toMatchObject({
      version: 1,
      baseVersion: 1,
      publishedVersion: 1,
    });
    expect(audits.at(-1)).toMatchObject({
      action: "exam.publish",
      detail: { version: 1, draftVersion: 1 },
    });
  });

  it("最新版と同じ内容なら版を作らない", async () => {
    const examId = await created();
    await publishExamDraft(deps, { examId, version: 1 });
    // 同じ内容のまま保存し直して公開する
    await saveExamDraft(deps, {
      examId,
      definition: draftOf(examId),
      version: 1,
      baseVersion: 1,
      editor,
    });
    await expect(publishExamDraft(deps, { examId, version: 2 })).resolves.toMatchObject({
      kind: "unchanged",
      version: 1,
    });
    expect(table.has(`EXAM#${examId}|V#000002`)).toBe(false);
    expect(table.get(`EXAM#${examId}|DRAFT`)).toMatchObject({ publishedVersion: 1 });
  });

  it("公開の検証を通らない下書きは公開しない（直すべき点を示す）", async () => {
    const examId = await created({
      questions: [{ qid: "q1", type: "choice", body: "", options: [{ id: "a", label: "A" }] }],
    });
    const err = await publishExamDraft(deps, { examId, version: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain("問 1の本文");
    expect((err as Error).message).toContain("問 1の選択肢");
    expect(table.get(`EXAM#${examId}|META`)?.latestVersion).toBeUndefined();
  });

  it("下書きを作った後に CLI で新しい版が公開されていたら、公開しない（新しい版を上書きしない）", async () => {
    const examId = await created();
    await publishExamDraft(deps, { examId, version: 1 });
    await saveExamDraft(deps, {
      examId,
      definition: draftOf(examId, { title: "画面で編集" }),
      version: 1,
      baseVersion: 1,
      editor,
    });
    // その後に CLI で v2 を投入する
    await publishExam(deps, {
      ...draftOf(examId, { title: "CLI で投入" }),
      questions: [{ qid: "q1", type: "text", body: "問題文", maxLength: 100 }],
    });
    await expect(publishExamDraft(deps, { examId, version: 2 })).rejects.toThrow(StateError);
    expect(table.get(`EXAM#${examId}|META`)).toMatchObject({
      latestVersion: 2,
      title: "CLI で投入",
    });
  });

  it("読み込んだ後に下書きが保存し直されていたら、公開しない", async () => {
    const examId = await created();
    await expect(publishExamDraft(deps, { examId, version: 2 })).rejects.toThrow(
      VersionConflictError,
    );
    await expect(publishExamDraft(deps, { examId: newId(), version: 1 })).rejects.toThrow(
      NotFoundError,
    );
  });

  it("CLI の exam:publish は、画面で作った未公開の課題にも v1 を作れる", async () => {
    const examId = await created();
    await expect(
      publishExam(deps, {
        ...draftOf(examId),
        questions: [{ qid: "q1", type: "text", body: "b", maxLength: 10 }],
      }),
    ).resolves.toMatchObject({ version: 1 });
    // 画面の下書き（v0 を元にしたもの）は、もう公開できない
    await expect(publishExamDraft(deps, { examId, version: 1 })).rejects.toThrow(StateError);
  });
});

describe("未公開の課題", () => {
  it("受験を発行できない", async () => {
    const examId = newId();
    await saveExamDraft(deps, {
      examId,
      definition: draftOf(examId),
      version: 0,
      baseVersion: 0,
      create: true,
      editor,
    });
    table.set("USER#c1|PROFILE", {
      PK: "USER#c1",
      SK: "PROFILE",
      sub: "c1",
      email: "c@example.com",
      name: "候補",
      roles: ["candidate"],
      disabled: false,
    });
    ddbMock
      .on(QueryCommand, { IndexName: "GSI1" })
      .resolves({ Items: [table.get("USER#c1|PROFILE") as Record<string, unknown>] });
    await expect(
      issueAttempt(deps, { email: "c@example.com", examId, deadline: "2026-12-10" }),
    ).rejects.toThrow("まだ公開していない課題です");
  });

  it("一覧・詳細に、未公開の課題と下書きを出す", async () => {
    const examId = newId();
    await saveExamDraft(deps, {
      examId,
      definition: draftOf(examId, { title: "下書きの題名" }),
      version: 0,
      baseVersion: 0,
      create: true,
      editor,
    });
    const list = await listExamsWithDrafts(deps);
    const mine = list.find((e) => e.examId === examId);
    expect(mine?.latestVersion).toBeUndefined();
    expect(mine?.draft).toMatchObject({ version: 1, title: "下書きの題名", baseVersion: 0 });

    await publishExamDraft(deps, { examId, version: 1 });
    const view = await getExamForEdit(deps, examId);
    expect(view.exam.latestVersion).toBe(1);
    expect(view.latest?.title).toBe("下書きの題名");
    expect(view.draft).toMatchObject({ version: 1, publishedVersion: 1, problems: [] });
    expect(view.versions).toEqual([{ version: 1, title: "下書きの題名", publishedAt: NOW }]);
    await expect(getExamForEdit(deps, newId())).rejects.toThrow(NotFoundError);
  });
});

describe("examProblems", () => {
  it("直すべき点を日本語で、場所（問・選択肢）を添えて返す", () => {
    const problems = examProblems({
      examId: "x",
      title: "",
      intro: "",
      questions: [
        { qid: "q1", type: "text", body: "ok" },
        { qid: "q1", type: "choice", body: "", options: [{ id: "a", label: "" }] },
      ],
    });
    expect(problems).toContain("題名: 小さすぎる値: stringは1文字以上である必要があります");
    expect(problems.some((p) => p.startsWith("問 2の本文"))).toBe(true);
    expect(problems.some((p) => p.startsWith("問 2の選択肢 1の表示"))).toBe(true);
    expect(problems.some((p) => p.startsWith("問題: qid が重複"))).toBe(true);
    expect(examProblems(draftOf("x"))).toEqual([]);
  });
});
