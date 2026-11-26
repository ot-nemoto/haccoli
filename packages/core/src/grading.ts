import { QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  type AnswerContent,
  type AssignmentStatus,
  type ExamDefinition,
  GRADABLE_STATUSES,
  type GradeItem,
  type GraderAssignmentSummary,
} from "@haccoli/shared";
import {
  type AnswerRecord,
  type AssignmentRecord,
  type AttemptBundle,
  type AttemptRecord,
  effectiveStatus,
  type GradeRecord,
  getAttemptBundle,
  getAttemptExam,
  getAttemptMeta,
  isConditionFailure,
  toAssignment,
  transactionFailureCodes,
} from "./attempts.js";
import { NotFoundError, StateError, ValidationError, VersionConflictError } from "./errors.js";
import type { DataDeps } from "./exams.js";
import { GSI1, keys } from "./keys.js";
import { findUserByEmail, type UserProfile } from "./users.js";

const nowOf = (deps: DataDeps) => deps.now?.() ?? new Date();
const notFound = () => new NotFoundError("受験が見つかりません");

// ---- 管理者（CLI） ----

/**
 * 受験に採点者を割り当てる（docs/design.md §8 attempt:assign）。複数可。
 * EXPIRED / CANCELED は不可。採点完了（GRADED）の受験に追加した場合は GRADING に戻す。
 * 既に割り当て済みの採点者は skipped として返す。
 */
export async function assignGraders(
  deps: DataDeps,
  input: { attemptId: string; graderEmails: string[] },
): Promise<{ assigned: UserProfile[]; skipped: UserProfile[]; attempt: AttemptRecord }> {
  const graders: UserProfile[] = [];
  for (const email of input.graderEmails) {
    const user = await findUserByEmail(deps, email);
    if (!user) throw new NotFoundError(`登録されていないメールアドレスです: ${email}`);
    if (user.role !== "grader") throw new ValidationError(`採点者ではありません: ${user.email}`);
    if (user.disabled) throw new ValidationError(`無効化された採点者です: ${user.email}`);
    if (!graders.some((g) => g.sub === user.sub)) graders.push(user);
  }

  const bundle = await getAttemptBundle(deps, input.attemptId);
  if (!bundle) throw notFound();
  const now = nowOf(deps);
  const status = effectiveStatus(bundle.attempt, now);
  if (status === "EXPIRED" || status === "CANCELED") {
    throw new StateError("INVALID", `${status} の受験には採点者を割り当てられません`);
  }

  // 書き込みの条件に使う、保存されている状態と割り当て数（同時実行の検出用）
  let storedStatus = bundle.attempt.status;
  let assignmentCount = bundle.assignments.length;
  const assigned: UserProfile[] = [];
  const skipped: UserProfile[] = [];
  for (const grader of graders) {
    if (bundle.assignments.some((a) => a.graderSub === grader.sub)) {
      skipped.push(grader);
      continue;
    }
    const assignedAt = now.toISOString();
    const toGrading = storedStatus === "GRADED";
    // 割り当て数を受験メタに持たせ、確定時の GRADED 化の条件にする（finalizeGrade）。
    // 割り当て数を持たない既存データは、今の件数で初期化する
    const attemptUpdate = {
      Update: {
        TableName: deps.tableName,
        Key: keys.attemptMeta(input.attemptId),
        UpdateExpression: toGrading
          ? "SET #s = :next, GSI2PK = :gsi2pk, assignmentCount = :count"
          : "SET assignmentCount = :count",
        ConditionExpression:
          "#s = :cur AND (attribute_not_exists(assignmentCount) OR assignmentCount = :prev)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":cur": storedStatus,
          ":prev": assignmentCount,
          ":count": assignmentCount + 1,
          ...(toGrading
            ? {
                ":next": "GRADING",
                ":gsi2pk": keys.attemptsByStatus("GRADING", "").GSI2PK,
              }
            : {}),
        },
      },
    };
    try {
      await deps.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: deps.tableName,
                Item: {
                  ...keys.assignment(input.attemptId, grader.sub),
                  ...keys.assignmentsByGrader(grader.sub, assignedAt),
                  type: "Assignment",
                  attemptId: input.attemptId,
                  graderSub: grader.sub,
                  graderName: grader.name,
                  // 一覧表示用に非正規化（email は持たない）
                  candidateName: bundle.attempt.candidateName,
                  examTitle: bundle.attempt.examTitle,
                  assignedAt,
                  status: "ASSIGNED" satisfies AssignmentStatus,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            attemptUpdate,
          ],
        }),
      );
      assigned.push(grader);
      assignmentCount += 1;
      if (toGrading) storedStatus = "GRADING";
    } catch (e) {
      const reasons = transactionFailureCodes(e);
      if (reasons?.[0] === "ConditionalCheckFailed") {
        skipped.push(grader);
        continue;
      }
      if (reasons?.[1] === "ConditionalCheckFailed") {
        throw new StateError("INVALID", "受験の状態が変わりました。もう一度実行してください");
      }
      throw e;
    }
  }
  const attempt = (await getAttemptMeta(deps, input.attemptId)) ?? bundle.attempt;
  return { assigned, skipped, attempt };
}

// ---- 採点者（API） ----

/** 自分の担当一覧。提出済み以降の受験のみ（docs/design.md §2） */
export async function listAssignmentsForGrader(
  deps: DataDeps,
  graderSub: string,
): Promise<GraderAssignmentSummary[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await deps.ddb.send(
      new QueryCommand({
        TableName: deps.tableName,
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": keys.assignmentsByGrader(graderSub, "").GSI1PK,
          ":sk": "ASSIGN#",
        },
        ScanIndexForward: false,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey);

  // 受験の状態を確認するため、受験メタを並列に読む（順番に読むと件数に比例して遅くなる）
  const own = items.filter((item) => item.graderSub === graderSub);
  const attempts = await Promise.all(
    own.map((item) => getAttemptMeta(deps, String(item.attemptId))),
  );
  const summaries: GraderAssignmentSummary[] = [];
  own.forEach((item, i) => {
    const attempt = attempts[i];
    if (!attempt || !GRADABLE_STATUSES.includes(attempt.status)) return;
    const assignment = toAssignment(item);
    summaries.push({
      attemptId: attempt.attemptId,
      examTitle: attempt.examTitle,
      candidateName: attempt.candidateName,
      ...(attempt.submittedAt ? { submittedAt: attempt.submittedAt } : {}),
      assignedAt: assignment.assignedAt,
      assignmentStatus: assignment.status,
    });
  });
  return summaries;
}

export interface GraderView {
  attempt: AttemptRecord;
  exam: ExamDefinition;
  answers: AnswerRecord[];
  assignment: AssignmentRecord;
  grade?: GradeRecord;
}

/**
 * 採点者が受験を閲覧する。自分に割り当てられた、提出済み以降の受験のみ。
 * それ以外は存在を区別せず NotFound（IDOR 対策）。他の採点者の採点は含めない。
 */
export async function getGraderView(
  deps: DataDeps,
  attemptId: string,
  graderSub: string,
): Promise<GraderView> {
  const bundle: AttemptBundle | undefined = await getAttemptBundle(deps, attemptId);
  const assignment = bundle?.assignments.find((a) => a.graderSub === graderSub);
  if (!bundle || !assignment || !GRADABLE_STATUSES.includes(bundle.attempt.status)) {
    throw notFound();
  }
  const exam = await getAttemptExam(deps, bundle.attempt);
  const grade = bundle.grades.find((g) => g.graderSub === graderSub);
  return {
    attempt: bundle.attempt,
    exam,
    answers: bundle.answers,
    assignment,
    ...(grade ? { grade } : {}),
  };
}

/** 採点内容を検証する。存在しない問題・配点を超える点数は不可 */
export function validateGradeItems(
  exam: ExamDefinition,
  items: Record<string, GradeItem>,
): Record<string, GradeItem> {
  const result: Record<string, GradeItem> = {};
  for (const [qid, item] of Object.entries(items)) {
    const q = exam.questions.find((x) => x.qid === qid);
    if (!q) throw new ValidationError(`存在しない問題です: ${qid}`);
    const points = q.rubric?.points;
    if (item.score !== undefined && points !== undefined && item.score > points) {
      throw new ValidationError(`${qid} の点数が配点（${points} 点）を超えています`);
    }
    const normalized: GradeItem = {};
    if (item.score !== undefined) normalized.score = item.score;
    if (item.comment) normalized.comment = item.comment;
    result[qid] = normalized;
  }
  return result;
}

/** 採点の下書き保存。確定後は変更不可。初回保存で受験を GRADING にする（§6.3） */
export async function saveGrade(
  deps: DataDeps,
  input: {
    attemptId: string;
    graderSub: string;
    items: Record<string, GradeItem>;
    overallComment: string;
    version: number;
  },
): Promise<{ version: number; updatedAt: string }> {
  const view = await getGraderView(deps, input.attemptId, input.graderSub);
  if (view.assignment.status === "DONE") throw finalized();
  const items = validateGradeItems(view.exam, input.items);
  const now = nowOf(deps).toISOString();
  const version = input.version + 1;
  try {
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: deps.tableName,
              Key: keys.assignment(input.attemptId, input.graderSub),
              UpdateExpression: "SET #s = :draft",
              ConditionExpression: "attribute_exists(PK) AND #s <> :done",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":draft": "DRAFT", ":done": "DONE" },
            },
          },
          {
            Put: {
              TableName: deps.tableName,
              Item: {
                ...keys.grade(input.attemptId, input.graderSub),
                type: "Grade",
                attemptId: input.attemptId,
                graderSub: input.graderSub,
                items,
                overallComment: input.overallComment,
                version,
                updatedAt: now,
              },
              ConditionExpression:
                input.version === 0 ? "attribute_not_exists(PK)" : "version = :expected",
              ...(input.version === 0
                ? {}
                : { ExpressionAttributeValues: { ":expected": input.version } }),
            },
          },
          {
            Update: {
              TableName: deps.tableName,
              Key: keys.attemptMeta(input.attemptId),
              UpdateExpression: "SET #s = :grading, GSI2PK = :gsi2pk",
              ConditionExpression: "#s IN (:submitted, :grading)",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":submitted": "SUBMITTED",
                ":grading": "GRADING",
                ":gsi2pk": keys.attemptsByStatus("GRADING", "").GSI2PK,
              },
            },
          },
        ],
      }),
    );
  } catch (e) {
    const reasons = transactionFailureCodes(e);
    if (!reasons) throw e;
    if (reasons[0] === "ConditionalCheckFailed") throw finalized();
    if (reasons[1] === "ConditionalCheckFailed") throw new VersionConflictError();
    if (reasons[2] === "ConditionalCheckFailed") {
      throw new StateError("INVALID", "受験の状態が変わりました。再読み込みしてください");
    }
    throw e;
  }
  return { version, updatedAt: now };
}

/**
 * 採点を確定する。確定後は変更できない。割り当てられた全採点者が確定したら受験を GRADED にする。
 */
export async function finalizeGrade(
  deps: DataDeps,
  input: { attemptId: string; graderSub: string; version: number },
): Promise<{ finalizedAt: string; attemptStatus: AttemptRecord["status"] }> {
  const view = await getGraderView(deps, input.attemptId, input.graderSub);
  if (view.assignment.status === "DONE") throw finalized();
  if (!view.grade) throw new ValidationError("採点を保存してから確定してください");
  const now = nowOf(deps).toISOString();
  try {
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: deps.tableName,
              Key: keys.assignment(input.attemptId, input.graderSub),
              UpdateExpression: "SET #s = :done, finalizedAt = :now",
              ConditionExpression: "attribute_exists(PK) AND #s <> :done",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":done": "DONE", ":now": now },
            },
          },
          {
            Update: {
              TableName: deps.tableName,
              Key: keys.grade(input.attemptId, input.graderSub),
              UpdateExpression: "SET finalizedAt = :now",
              // 確定するのは画面で見ていた版（保存後に別の画面で変更されていない）
              ConditionExpression: "version = :expected",
              ExpressionAttributeValues: { ":now": now, ":expected": input.version },
            },
          },
        ],
      }),
    );
  } catch (e) {
    const reasons = transactionFailureCodes(e);
    if (!reasons) throw e;
    if (reasons[0] === "ConditionalCheckFailed") throw finalized();
    if (reasons[1] === "ConditionalCheckFailed") throw new VersionConflictError();
    throw e;
  }

  // 全員確定したら GRADED。同時に確定した場合も、後から確定した側が全員分を確認できる。
  // 読み込んだ後に採点者が追加されていたら GRADED にしない（割り当て数を条件にする）
  const bundle = await getAttemptBundle(deps, input.attemptId);
  let attemptStatus = bundle?.attempt.status ?? view.attempt.status;
  if (
    bundle &&
    bundle.assignments.length > 0 &&
    bundle.assignments.every((a) => a.status === "DONE")
  ) {
    try {
      await deps.ddb.send(
        new UpdateCommand({
          TableName: deps.tableName,
          Key: keys.attemptMeta(input.attemptId),
          UpdateExpression: "SET #s = :graded, gradedAt = :now, GSI2PK = :gsi2pk",
          ConditionExpression:
            "#s = :grading AND (attribute_not_exists(assignmentCount) OR assignmentCount = :count)",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":graded": "GRADED",
            ":grading": "GRADING",
            ":count": bundle.assignments.length,
            ":now": now,
            ":gsi2pk": keys.attemptsByStatus("GRADED", "").GSI2PK,
          },
        }),
      );
      attemptStatus = "GRADED";
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
    }
  }
  return { finalizedAt: now, attemptStatus };
}

/** 提出ファイルのダウンロード用 URL（割り当て確認後に発行。§6.2） */
export async function createGraderDownloadUrl(
  deps: DataDeps,
  input: { attemptId: string; graderSub: string; qid: string },
): Promise<string> {
  if (!deps.files) throw new Error("FileStore が設定されていません");
  const view = await getGraderView(deps, input.attemptId, input.graderSub);
  const content = view.answers.find((a) => a.qid === input.qid)?.content as
    | (AnswerContent & { fileKey?: string; fileName?: string })
    | undefined;
  if (!content?.fileKey) throw new NotFoundError("提出ファイルがありません");
  return deps.files.createDownloadUrl(content.fileKey, content.fileName ?? "submission.zip");
}

const finalized = () => new StateError("ALREADY_FINALIZED", "採点は確定済みのため変更できません");
