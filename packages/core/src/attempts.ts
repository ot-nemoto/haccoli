import { randomUUID } from "node:crypto";
import {
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  type AnswerContent,
  type AssignmentStatus,
  type AttemptStatus,
  type ExamDefinition,
  type GradeItem,
  isAnswered,
  type Question,
} from "@haccoli/shared";
import {
  choiceAnswerSchema,
  fileAnswerRequestSchema,
  textAnswerSchema,
} from "@haccoli/shared/schemas";
import { type AuditDeps, auditPut } from "./audit.js";
import { isConditionFailure, transactionFailureCodes } from "./ddb-errors.js";
import { validateDeadlineDate } from "./deadline.js";
import { NotFoundError, StateError, ValidationError, VersionConflictError } from "./errors.js";
import { type DataDeps, getExamSummary, getExamVersion } from "./exams.js";
import { assertZipFileName, type FileStore, newFileKey, verifyUploadedFile } from "./files.js";
import { GSI1, GSI2, keys } from "./keys.js";
import { findUserByEmail } from "./users.js";

export { isConditionFailure, transactionFailureCodes };

/** 受験（docs/design.md §6.1 Attempt） */
export interface AttemptRecord {
  attemptId: string;
  candidateSub: string;
  /** 非正規化（採点者向け表示用。email は持たない） */
  candidateName: string;
  examId: string;
  examVersion: number;
  /** 非正規化（一覧表示用） */
  examTitle: string;
  status: AttemptStatus;
  issuedAt: string;
  deadlineAt: string;
  startedAt?: string;
  submittedAt?: string;
  canceledAt?: string;
}

export interface AnswerRecord {
  qid: string;
  content: AnswerContent;
  version: number;
  updatedAt: string;
}

export interface AssignmentRecord {
  graderSub: string;
  graderName: string;
  assignedAt: string;
  status: AssignmentStatus;
  finalizedAt?: string;
}

export interface GradeRecord {
  graderSub: string;
  items: Record<string, GradeItem>;
  overallComment: string;
  version: number;
  updatedAt: string;
  finalizedAt?: string;
}

/** 受験 1 件に同一 PK でぶら下がるデータ（§6.1） */
export interface AttemptBundle {
  attempt: AttemptRecord;
  answers: AnswerRecord[];
  assignments: AssignmentRecord[];
  grades: GradeRecord[];
}

const nowOf = (deps: DataDeps) => deps.now?.() ?? new Date();

/**
 * 表示・判定用のステータス。期限到来済みで未提出なら、期限処理バッチの実行前でも EXPIRED とみなす。
 */
export function effectiveStatus(attempt: AttemptRecord, now: Date): AttemptStatus {
  if (
    (attempt.status === "NOT_STARTED" || attempt.status === "IN_PROGRESS") &&
    attempt.deadlineAt <= now.toISOString()
  ) {
    return "EXPIRED";
  }
  return attempt.status;
}

// ---- 管理者（CLI） ----

/** 受験を発行する（最新版の課題で、期限 = 指定日 23:59:59 JST）。docs/design.md §8 attempt:issue */
export async function issueAttempt(
  deps: DataDeps & AuditDeps,
  input: { email: string; examId: string; deadline: string; force?: boolean },
): Promise<AttemptRecord> {
  const now = nowOf(deps);
  const deadlineAt = validateDeadlineDate(input.deadline, now, input.force);

  const user = await findUserByEmail(deps, input.email);
  if (!user) throw new NotFoundError(`登録されていないメールアドレスです: ${input.email}`);
  if (!user.roles.includes("candidate")) {
    throw new ValidationError(`候補者ではありません: ${user.email}`);
  }
  if (user.disabled) throw new ValidationError(`無効化された候補者です: ${user.email}`);

  const exam = await getExamSummary(deps, input.examId);
  if (!exam) throw new NotFoundError(`課題が見つかりません: ${input.examId}`);

  const attempt: AttemptRecord = {
    attemptId: randomUUID(),
    candidateSub: user.sub,
    candidateName: user.name,
    examId: exam.examId,
    examVersion: exam.latestVersion,
    examTitle: exam.title,
    status: "NOT_STARTED",
    issuedAt: now.toISOString(),
    deadlineAt,
  };
  await deps.ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: deps.tableName,
            Item: toItem(attempt),
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        auditPut(deps, {
          action: "attempt.issue",
          target: { type: "attempt", id: attempt.attemptId },
          detail: {
            candidateSub: user.sub,
            examId: exam.examId,
            examVersion: exam.latestVersion,
            deadlineAt,
          },
        }),
      ],
    }),
  );
  return attempt;
}

/** 受験一覧（管理者用）。件数は数百の想定のため Scan */
export async function listAttempts(
  deps: DataDeps,
  filter: { status?: AttemptStatus } = {},
): Promise<AttemptRecord[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await deps.ddb.send(
      new ScanCommand({
        TableName: deps.tableName,
        FilterExpression: "#t = :t",
        ExpressionAttributeNames: { "#t": "type" },
        ExpressionAttributeValues: { ":t": "Attempt" },
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  const now = nowOf(deps);
  return items
    .map(toAttempt)
    .filter((a) => !filter.status || effectiveStatus(a, now) === filter.status)
    .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
}

// ---- 候補者（API） ----

export async function listAttemptsByCandidate(
  deps: DataDeps,
  candidateSub: string,
): Promise<AttemptRecord[]> {
  const res = await deps.ddb.send(
    new QueryCommand({
      TableName: deps.tableName,
      IndexName: GSI1,
      KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :sk)",
      ExpressionAttributeValues: {
        ":pk": keys.attemptsByCandidate(candidateSub, "").GSI1PK,
        ":sk": "ATTEMPT#",
      },
      ScanIndexForward: false,
    }),
  );
  return (res.Items ?? []).map(toAttempt).filter((a) => a.candidateSub === candidateSub);
}

/** 受験 1 件と回答をまとめて取得する（同一 PK を 1 クエリ） */
export async function getAttemptBundle(
  deps: DataDeps,
  attemptId: string,
): Promise<AttemptBundle | undefined> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await deps.ddb.send(
      new QueryCommand({
        TableName: deps.tableName,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": keys.attemptPk(attemptId) },
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  const meta = items.find((i) => i.SK === "META");
  if (!meta) return undefined;
  const withPrefix = (prefix: string) => items.filter((i) => String(i.SK).startsWith(prefix));
  return {
    attempt: toAttempt(meta),
    answers: withPrefix("ANS#").map(toAnswer),
    assignments: withPrefix("ASSIGN#").map(toAssignment),
    grades: withPrefix("GRADE#").map(toGrade),
  };
}

/** 候補者本人の受験を取得する。他人の受験は存在しないものとして扱う */
export async function getOwnAttemptBundle(
  deps: DataDeps,
  attemptId: string,
  candidateSub: string,
): Promise<AttemptBundle> {
  const bundle = await getAttemptBundle(deps, attemptId);
  if (!bundle || bundle.attempt.candidateSub !== candidateSub) throw attemptNotFound();
  return bundle;
}

export async function getAttemptExam(
  deps: DataDeps,
  attempt: AttemptRecord,
): Promise<ExamDefinition> {
  const exam = await getExamVersion(deps, attempt.examId, attempt.examVersion);
  if (!exam) throw new Error(`課題の版が見つかりません: ${attempt.examId} v${attempt.examVersion}`);
  return exam;
}

/** 開始。既に開始済みなら何もしない（二重クリック・再読み込み対策） */
export async function startAttempt(
  deps: DataDeps,
  attemptId: string,
  candidateSub: string,
): Promise<AttemptRecord> {
  const now = nowOf(deps).toISOString();
  try {
    const res = await deps.ddb.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: keys.attemptMeta(attemptId),
        UpdateExpression: "SET #s = :next, startedAt = :now, GSI2PK = :gsi2pk",
        ConditionExpression: "candidateSub = :sub AND #s = :cur AND deadlineAt > :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":next": "IN_PROGRESS",
          ":cur": "NOT_STARTED",
          ":sub": candidateSub,
          ":now": now,
          ":gsi2pk": keys.attemptsByStatus("IN_PROGRESS", "").GSI2PK,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return toAttempt(res.Attributes ?? {});
  } catch (e) {
    if (!isConditionFailure(e)) throw e;
    const current = await getAttemptMeta(deps, attemptId);
    if (current?.candidateSub === candidateSub && current.status === "IN_PROGRESS") {
      if (current.deadlineAt > now) return current;
    }
    throw explainStateFailure(current, candidateSub, new Date(now));
  }
}

/**
 * 回答の途中保存。楽観ロック（version）で別画面・別端末の上書きを防ぐ。
 * 受験の状態（本人・回答中・期限前）の確認と回答の書き込みを 1 トランザクションで行う。
 */
export async function saveAnswer(
  deps: DataDeps,
  input: {
    attemptId: string;
    candidateSub: string;
    qid: string;
    content: unknown;
    /** 読み込んだ時点の版。未保存なら 0 */
    version: number;
  },
): Promise<{ content: AnswerContent; version: number; updatedAt: string }> {
  const attempt = await getAttemptMeta(deps, input.attemptId);
  if (!attempt || attempt.candidateSub !== input.candidateSub) throw attemptNotFound();
  const exam = await getAttemptExam(deps, attempt);
  const question = exam.questions.find((q) => q.qid === input.qid);
  if (!question) throw new NotFoundError("問題が見つかりません");
  // 書き込み時の条件でも確認するが、ファイルの検証（S3 の読み込み）の前に弾いておく
  if (effectiveStatus(attempt, nowOf(deps)) !== "IN_PROGRESS") {
    throw explainStateFailure(attempt, input.candidateSub, nowOf(deps));
  }

  let content: AnswerContent;
  let previousFileKey: string | undefined;
  if (question.type === "file") {
    const files = requireFiles(deps);
    const req = fileAnswerRequestSchema.safeParse(input.content);
    if (!req.success) throw new ValidationError("ファイル提出の回答形式が不正です");
    content = await verifyUploadedFile(
      files,
      {
        attemptId: input.attemptId,
        qid: question.qid,
        fileKey: req.data.fileKey,
        fileName: req.data.fileName,
        maxBytes: maxBytesOf(question),
      },
      nowOf(deps),
    );
    previousFileKey = await getAnswerFileKey(deps, input.attemptId, question.qid);
  } else {
    content = validateAnswer(question, input.content);
  }

  const now = nowOf(deps).toISOString();
  const version = input.version + 1;
  const answer: AnswerRecord = { qid: question.qid, content, version, updatedAt: now };
  try {
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: deps.tableName,
              Key: keys.attemptMeta(input.attemptId),
              ConditionExpression: "candidateSub = :sub AND #s = :cur AND deadlineAt > :now",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":sub": input.candidateSub,
                ":cur": "IN_PROGRESS",
                ":now": now,
              },
            },
          },
          {
            Put: {
              TableName: deps.tableName,
              Item: {
                ...keys.answer(input.attemptId, question.qid),
                type: "Answer",
                ...answer,
              },
              ConditionExpression:
                input.version === 0 ? "attribute_not_exists(PK)" : "version = :expected",
              ...(input.version === 0
                ? {}
                : { ExpressionAttributeValues: { ":expected": input.version } }),
            },
          },
        ],
      }),
    );
  } catch (e) {
    const reasons = transactionFailureCodes(e);
    if (!reasons) throw e;
    if (reasons[0] === "ConditionalCheckFailed") {
      throw explainStateFailure(
        await getAttemptMeta(deps, input.attemptId),
        input.candidateSub,
        new Date(now),
      );
    }
    if (reasons[1] === "ConditionalCheckFailed") throw new VersionConflictError();
    throw e;
  }
  // 差し替え前のファイルを削除する（バージョニングで一定期間は復元可能。失敗しても保存は成功扱い）
  if (previousFileKey && "fileKey" in content && previousFileKey !== content.fileKey) {
    await deps.files?.delete(previousFileKey).catch((e: unknown) => {
      console.warn(JSON.stringify({ msg: "previous file delete failed", error: String(e) }));
    });
  }
  return { content, version, updatedAt: now };
}

/**
 * ファイル提出用の署名付き POST を発行する。回答中・期限前の本人の受験のみ（期限後は発行しない §6.2）。
 */
export async function createUploadUrl(
  deps: DataDeps,
  input: { attemptId: string; candidateSub: string; qid: string; fileName: string; size: number },
): Promise<{ url: string; fields: Record<string, string>; fileKey: string; maxBytes: number }> {
  const files = requireFiles(deps);
  const attempt = await getAttemptMeta(deps, input.attemptId);
  if (!attempt || attempt.candidateSub !== input.candidateSub) throw attemptNotFound();
  if (effectiveStatus(attempt, nowOf(deps)) !== "IN_PROGRESS") {
    throw explainStateFailure(attempt, input.candidateSub, nowOf(deps));
  }
  const exam = await getAttemptExam(deps, attempt);
  const question = exam.questions.find((q) => q.qid === input.qid);
  if (!question) throw new NotFoundError("問題が見つかりません");
  if (question.type !== "file") throw new ValidationError("ファイル提出の問題ではありません");
  assertZipFileName(input.fileName);
  const maxBytes = maxBytesOf(question);
  if (input.size > maxBytes) {
    throw new ValidationError(`ファイルが大きすぎます（上限 ${question.file.maxSizeMB}MB）`);
  }
  const fileKey = newFileKey(input.attemptId, question.qid, input.fileName);
  const post = await files.createUploadPost(fileKey, maxBytes);
  return { ...post, fileKey, maxBytes };
}

/** 提出。以降は回答を変更できない。未回答の問題があっても受け付け、一覧を返す */
export async function submitAttempt(
  deps: DataDeps,
  attemptId: string,
  candidateSub: string,
): Promise<{ attempt: AttemptRecord; unanswered: string[] }> {
  const bundle = await getOwnAttemptBundle(deps, attemptId, candidateSub);
  const exam = await getAttemptExam(deps, bundle.attempt);
  const now = nowOf(deps).toISOString();
  try {
    const res = await deps.ddb.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: keys.attemptMeta(attemptId),
        UpdateExpression: "SET #s = :next, submittedAt = :now, GSI2PK = :gsi2pk",
        ConditionExpression: "candidateSub = :sub AND #s = :cur AND deadlineAt > :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":next": "SUBMITTED",
          ":cur": "IN_PROGRESS",
          ":sub": candidateSub,
          ":now": now,
          ":gsi2pk": keys.attemptsByStatus("SUBMITTED", "").GSI2PK,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return {
      attempt: toAttempt(res.Attributes ?? {}),
      unanswered: unansweredQuestions(exam, bundle.answers),
    };
  } catch (e) {
    if (!isConditionFailure(e)) throw e;
    throw explainStateFailure(await getAttemptMeta(deps, attemptId), candidateSub, new Date(now));
  }
}

// ---- 回答の検証 ----

/** 問題の型に合わせて回答内容を検証し、保存する形に正規化する（§5.1） */
export function validateAnswer(question: Question, content: unknown): AnswerContent {
  switch (question.type) {
    case "text": {
      const parsed = textAnswerSchema.safeParse(content);
      if (!parsed.success) throw new ValidationError("記述式の回答形式が不正です");
      const length = [...parsed.data.text].length;
      if (length > question.maxLength) {
        throw new ValidationError(
          `${question.maxLength} 文字以内で入力してください（${length} 文字）`,
        );
      }
      return { text: parsed.data.text };
    }
    case "choice": {
      const parsed = choiceAnswerSchema.safeParse(content);
      if (!parsed.success) throw new ValidationError("選択式の回答形式が不正です");
      const selected = parsed.data.selected;
      if (new Set(selected).size !== selected.length) {
        throw new ValidationError("同じ選択肢が重複しています");
      }
      if (!selected.every((id) => question.options.some((o) => o.id === id))) {
        throw new ValidationError("存在しない選択肢です");
      }
      if (!question.multiple && selected.length > 1) {
        throw new ValidationError("選択肢は 1 つだけ選んでください");
      }
      return { selected: [...selected] };
    }
    case "file":
      // ファイルは S3 の実体を検証する必要があるため saveAnswer で扱う
      throw new ValidationError("ファイル提出の回答は検証済みの内容が必要です");
  }
}

export function unansweredQuestions(exam: ExamDefinition, answers: AnswerRecord[]): string[] {
  const byQid = new Map(answers.map((a) => [a.qid, a.content]));
  return exam.questions.filter((q) => !isAnswered(byQid.get(q.qid))).map((q) => q.qid);
}

// ---- 内部 ----

const attemptNotFound = () => new NotFoundError("受験が見つかりません");

const maxBytesOf = (q: Extract<Question, { type: "file" }>) =>
  Math.floor(q.file.maxSizeMB * 1024 * 1024);

function requireFiles(deps: DataDeps): FileStore {
  if (!deps.files) throw new Error("FileStore が設定されていません");
  return deps.files;
}

async function getAnswerFileKey(
  deps: DataDeps,
  attemptId: string,
  qid: string,
): Promise<string | undefined> {
  const res = await deps.ddb.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: keys.answer(attemptId, qid),
      ConsistentRead: true,
    }),
  );
  const content = res.Item?.content as Record<string, unknown> | undefined;
  return typeof content?.fileKey === "string" ? content.fileKey : undefined;
}

/** @internal grading.ts からも使う */
export async function getAttemptMeta(
  deps: DataDeps,
  attemptId: string,
): Promise<AttemptRecord | undefined> {
  const res = await deps.ddb.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: keys.attemptMeta(attemptId),
      ConsistentRead: true,
    }),
  );
  return res.Item ? toAttempt(res.Item) : undefined;
}

/** 条件付き書き込みが失敗した理由を、現在の受験の状態から利用者向けのエラーにする */
function explainStateFailure(
  attempt: AttemptRecord | undefined,
  candidateSub: string,
  now: Date,
): Error {
  if (!attempt || attempt.candidateSub !== candidateSub) return attemptNotFound();
  switch (effectiveStatus(attempt, now)) {
    case "NOT_STARTED":
      return new StateError("NOT_STARTED", "まだ開始していません");
    case "EXPIRED":
      return new StateError("EXPIRED", "受験期限を過ぎています");
    case "CANCELED":
      return new StateError("CANCELED", "この受験は取り消されました");
    case "SUBMITTED":
    case "GRADING":
    case "GRADED":
      return new StateError("ALREADY_SUBMITTED", "提出済みのため変更できません");
    default:
      return new StateError("INVALID", "現在の状態ではこの操作はできません");
  }
}

function toItem(a: AttemptRecord): Record<string, unknown> {
  return {
    ...keys.attemptMeta(a.attemptId),
    ...keys.attemptsByCandidate(a.candidateSub, a.issuedAt),
    ...keys.attemptsByStatus(a.status, a.deadlineAt),
    type: "Attempt",
    ...a,
  };
}

/** @internal */
export function toAttempt(item: Record<string, unknown>): AttemptRecord {
  return {
    attemptId: String(item.attemptId),
    candidateSub: String(item.candidateSub),
    candidateName: String(item.candidateName),
    examId: String(item.examId),
    examVersion: Number(item.examVersion),
    examTitle: String(item.examTitle),
    status: item.status as AttemptStatus,
    issuedAt: String(item.issuedAt),
    deadlineAt: String(item.deadlineAt),
    ...(item.startedAt ? { startedAt: String(item.startedAt) } : {}),
    ...(item.submittedAt ? { submittedAt: String(item.submittedAt) } : {}),
    ...(item.canceledAt ? { canceledAt: String(item.canceledAt) } : {}),
  };
}

export function toAssignment(item: Record<string, unknown>): AssignmentRecord {
  return {
    graderSub: String(item.graderSub),
    graderName: String(item.graderName),
    assignedAt: String(item.assignedAt),
    status: item.status as AssignmentStatus,
    ...(item.finalizedAt ? { finalizedAt: String(item.finalizedAt) } : {}),
  };
}

export function toGrade(item: Record<string, unknown>): GradeRecord {
  return {
    graderSub: String(item.graderSub),
    items: (item.items as Record<string, GradeItem> | undefined) ?? {},
    overallComment: String(item.overallComment ?? ""),
    version: Number(item.version),
    updatedAt: String(item.updatedAt),
    ...(item.finalizedAt ? { finalizedAt: String(item.finalizedAt) } : {}),
  };
}

function toAnswer(item: Record<string, unknown>): AnswerRecord {
  return {
    qid: String(item.qid),
    content: item.content as AnswerContent,
    version: Number(item.version),
    updatedAt: String(item.updatedAt),
  };
}

// ---- 期限処理・期限延長 ----

/**
 * 期限到来済みの未着手・回答中の受験を EXPIRED にする（docs/design.md §6.4。1 時間毎のバッチ）。
 * 期限の厳密な判定は書き込み時の条件式で担保済みのため、これは状態の後片付け。
 * 並行して提出・延長された受験は条件式で除外される。
 */
export async function expireAttempts(deps: DataDeps): Promise<{ expired: string[] }> {
  const now = nowOf(deps).toISOString();
  const expired: string[] = [];
  for (const status of ["NOT_STARTED", "IN_PROGRESS"] as const) {
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await deps.ddb.send(
        new QueryCommand({
          TableName: deps.tableName,
          IndexName: GSI2,
          KeyConditionExpression: "GSI2PK = :pk AND GSI2SK <= :now",
          ExpressionAttributeValues: {
            ":pk": keys.attemptsByStatus(status, "").GSI2PK,
            ":now": now,
          },
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of res.Items ?? []) {
        const attemptId = String(item.attemptId);
        try {
          await deps.ddb.send(
            new UpdateCommand({
              TableName: deps.tableName,
              Key: keys.attemptMeta(attemptId),
              UpdateExpression: "SET #s = :next, expiredAt = :now, GSI2PK = :gsi2pk",
              ConditionExpression: "#s = :cur AND deadlineAt <= :now",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":next": "EXPIRED",
                ":cur": status,
                ":now": now,
                ":gsi2pk": keys.attemptsByStatus("EXPIRED", "").GSI2PK,
              },
            }),
          );
          expired.push(attemptId);
        } catch (e) {
          if (!isConditionFailure(e)) throw e;
        }
      }
      startKey = res.LastEvaluatedKey;
    } while (startKey);
  }
  return { expired };
}

/**
 * 期限を変更する（docs/design.md §8 attempt:extend）。EXPIRED からも戻せる。
 * 開始済みなら IN_PROGRESS、未着手なら NOT_STARTED に戻す。提出済み・取消は変更不可。
 */
export async function extendAttempt(
  deps: DataDeps & AuditDeps,
  input: { attemptId: string; deadline: string; force?: boolean },
): Promise<{ before: AttemptRecord; after: AttemptRecord }> {
  const now = nowOf(deps);
  const deadlineAt = validateDeadlineDate(input.deadline, now, input.force);
  const before = await getAttemptMeta(deps, input.attemptId);
  if (!before) throw attemptNotFound();
  if (!["NOT_STARTED", "IN_PROGRESS", "EXPIRED"].includes(before.status)) {
    throw new StateError("INVALID", `この受験は期限を変更できません（${before.status}）`);
  }
  const next: AttemptStatus =
    before.status === "EXPIRED"
      ? before.startedAt
        ? "IN_PROGRESS"
        : "NOT_STARTED"
      : before.status;
  try {
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: deps.tableName,
              Key: keys.attemptMeta(input.attemptId),
              UpdateExpression:
                "SET #s = :next, deadlineAt = :deadline, GSI2PK = :gsi2pk, GSI2SK = :deadline REMOVE expiredAt",
              // 読み取り後に提出・期限処理された場合は失敗させる
              ConditionExpression: "#s = :cur",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":next": next,
                ":cur": before.status,
                ":deadline": deadlineAt,
                ":gsi2pk": keys.attemptsByStatus(next, "").GSI2PK,
              },
            },
          },
          auditPut(deps, {
            action: "attempt.extend",
            target: { type: "attempt", id: input.attemptId },
            detail: {
              deadlineBefore: before.deadlineAt,
              deadlineAfter: deadlineAt,
              statusBefore: before.status,
              statusAfter: next,
            },
          }),
        ],
      }),
    );
    // 条件（状態が読んだときのまま）を満たして更新したので、更新後の値は読んだ値から決まる
    return { before, after: { ...before, status: next, deadlineAt } };
  } catch (e) {
    if (transactionFailureCodes(e)?.[0] === "ConditionalCheckFailed") {
      throw new StateError("INVALID", "受験の状態が変わりました。もう一度実行してください");
    }
    throw e;
  }
}

/**
 * 受験を取り消す（docs/design.md §6.3 attempt:cancel）。未着手・受験中のみ。
 * 期限切れ（バッチ処理前を含む）・提出済み以降・取消済みは不可。保存済みの回答は削除しない。
 */
export async function cancelAttempt(
  deps: DataDeps & AuditDeps,
  input: { attemptId: string },
): Promise<{ before: AttemptRecord; after: AttemptRecord }> {
  const now = nowOf(deps);
  const before = await getAttemptMeta(deps, input.attemptId);
  if (!before) throw attemptNotFound();
  const status = effectiveStatus(before, now);
  if (status !== "NOT_STARTED" && status !== "IN_PROGRESS") {
    throw new StateError("INVALID", `この受験は取り消せません（${status}）`);
  }
  // 判定から書き込みまでに期限を迎えた場合も取り消さないよう、書き込み直前の時刻を使う
  const canceledAt = nowOf(deps).toISOString();
  try {
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: deps.tableName,
              Key: keys.attemptMeta(input.attemptId),
              UpdateExpression: "SET #s = :canceled, canceledAt = :now, GSI2PK = :gsi2pk",
              // 読み取り後に開始・提出・期限処理された場合や、期限を迎えた場合は失敗させる
              ConditionExpression: "#s = :cur AND deadlineAt > :now",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":canceled": "CANCELED",
                ":cur": before.status,
                ":now": canceledAt,
                ":gsi2pk": keys.attemptsByStatus("CANCELED", "").GSI2PK,
              },
            },
          },
          auditPut(deps, {
            action: "attempt.cancel",
            target: { type: "attempt", id: input.attemptId },
            detail: { statusBefore: before.status },
          }),
        ],
      }),
    );
    return { before, after: { ...before, status: "CANCELED", canceledAt } };
  } catch (e) {
    if (transactionFailureCodes(e)?.[0] === "ConditionalCheckFailed") {
      throw new StateError("INVALID", "受験の状態が変わりました。もう一度実行してください");
    }
    throw e;
  }
}
