import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  type AnswerContent,
  ATTEMPT_STATUSES,
  type AttemptStatus,
  type ExamDefinition,
} from "@haccoli/shared";
import {
  type AttemptBundle,
  type AttemptRecord,
  effectiveStatus,
  getAttemptBundle,
  getAttemptExam,
  toAttempt,
} from "./attempts.js";
import { NotFoundError, ValidationError } from "./errors.js";
import type { DataDeps } from "./exams.js";
import { GSI2, keys } from "./keys.js";
import {
  type AnyKey,
  decodeSourcesCursor,
  type Page,
  type PageSource,
  readSourcesPage,
} from "./paging.js";
import { getUserBySub, type UserProfile } from "./users.js";

/**
 * 管理者（画面）向けの受験の閲覧（docs/design.md §14.6・§14.7）。変更操作（発行・期限の変更・
 * 取消・割り当て）は CLI と同じ attempts.ts・grading.ts の関数を使う。
 *
 * 一覧は GSI2（状態ごと。ソートキーは期限）を Query する。期限処理バッチ（1 時間毎）の前でも、
 * 期限を過ぎた未着手・回答中は「期限切れ」として扱う（effectiveStatus と同じ）。そのため、
 * 未着手・回答中は期限で区切って読み、期限を過ぎた分は期限切れの一覧に入れる。
 */

const nowOf = (deps: DataDeps) => deps.now?.() ?? new Date();

/** 一覧の並び：状態ごとにまとめる（状態をまたいで期限順に混ぜない）。進行中 → 提出済み以降 → 期限切れ → 取消 */
const LIST_ORDER: readonly AttemptStatus[] = [
  "IN_PROGRESS",
  "NOT_STARTED",
  "SUBMITTED",
  "GRADING",
  "GRADED",
  "EXPIRED",
  "CANCELED",
];

/** GSI2 の 1 つの状態。range は期限（GSI2SK）での区切り */
interface StatusSource {
  stored: AttemptStatus;
  range?: "future" | "past";
}

/** 表示上の状態（effectiveStatus）が status の受験を、GSI2 のどこから読むか */
function sourcesOf(status: AttemptStatus): StatusSource[] {
  switch (status) {
    case "NOT_STARTED":
    case "IN_PROGRESS":
      return [{ stored: status, range: "future" }];
    case "EXPIRED":
      // バッチ前の期限切れ（回答中・未着手のまま期限を過ぎたもの）と、バッチ後の期限切れ
      return [
        { stored: "IN_PROGRESS", range: "past" },
        { stored: "NOT_STARTED", range: "past" },
        { stored: "EXPIRED" },
      ];
    default:
      return [{ stored: status }];
  }
}

function queryOf(
  deps: DataDeps,
  source: StatusSource,
  at: string,
  extra: { examId?: string; filter?: string; values?: Record<string, unknown> } = {},
) {
  const conditions = [extra.examId ? "examId = :examId" : undefined, extra.filter].filter(Boolean);
  return {
    TableName: deps.tableName,
    IndexName: GSI2,
    KeyConditionExpression:
      source.range === "future"
        ? "GSI2PK = :pk AND GSI2SK > :at"
        : source.range === "past"
          ? "GSI2PK = :pk AND GSI2SK <= :at"
          : "GSI2PK = :pk",
    ...(conditions.length > 0 ? { FilterExpression: conditions.join(" AND ") } : {}),
    ExpressionAttributeValues: {
      ":pk": keys.attemptsByStatus(source.stored, "").GSI2PK,
      ...(source.range ? { ":at": at } : {}),
      ...(extra.examId ? { ":examId": extra.examId } : {}),
      ...extra.values,
    },
    // 進行中は期限が近い順、それ以外は期限が新しい順
    ScanIndexForward: source.range === "future",
  };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** 受験の一覧のページ。status は表示上の状態。examId で絞り込める */
export async function listAttemptPage(
  deps: DataDeps,
  opts: { status?: AttemptStatus; examId?: string; limit?: number; cursor?: string },
): Promise<Page<AttemptRecord>> {
  const cursor = opts.cursor ? decodeSourcesCursor(opts.cursor) : undefined;
  if (cursor && !ISO.test(cursor.t)) throw new ValidationError("ページの指定が不正です");
  // 1 ページ目の時刻で区切り続ける（ページの途中で期限を迎えた受験が、重複・欠落しないように）
  const at = cursor?.t ?? nowOf(deps).toISOString();
  const statuses = opts.status ? [opts.status] : LIST_ORDER;
  const sources = statuses.flatMap(sourcesOf).map(
    (source): PageSource => ({
      fetch: (startKey) =>
        deps.ddb.send(
          new QueryCommand({
            ...queryOf(deps, source, at, { examId: opts.examId }),
            ExclusiveStartKey: startKey,
          }),
        ),
      keyOf: (item) => ({
        PK: String(item.PK),
        SK: String(item.SK),
        GSI2PK: String(item.GSI2PK),
        GSI2SK: String(item.GSI2SK),
      }),
      isValidKey: (key) => isAttemptKey(key, source, at),
    }),
  );
  const page = await readSourcesPage(sources, { limit: opts.limit, cursor, token: at });
  const now = new Date(at);
  return {
    ...page,
    items: page.items.map(toAttempt).map((a) => ({ ...a, status: effectiveStatus(a, now) })),
  };
}

/** 読み込み元のキーか（同じ状態の、期限の区切りの内側か）。外側のキーから Query すると DynamoDB が拒否する */
function isAttemptKey(key: AnyKey, source: StatusSource, at: string): boolean {
  const sk = key.GSI2SK ?? "";
  return (
    Object.keys(key).length === 4 &&
    /^ATTEMPT#[\w-]{1,64}$/.test(key.PK ?? "") &&
    key.SK === "META" &&
    key.GSI2PK === keys.attemptsByStatus(source.stored, "").GSI2PK &&
    ISO.test(sk) &&
    (source.range === "future" ? sk > at : source.range === "past" ? sk <= at : true)
  );
}

// ---- ダッシュボード ----

export interface AttemptSummary {
  /** 集計の基準時刻 */
  at: string;
  /** 表示上の状態ごとの件数 */
  counts: Record<AttemptStatus, number>;
  /** 期限が DUE_SOON_DAYS 日以内の未着手・回答中（期限が近い順、最大 SUMMARY_ITEMS 件） */
  dueSoon: AttemptRecord[];
  dueSoonTotal: number;
  /** 提出済みで、採点者が割り当てられていない受験（提出が古い順、最大 SUMMARY_ITEMS 件） */
  unassigned: AttemptRecord[];
  unassignedTotal: number;
}

export const DUE_SOON_DAYS = 3;
export const SUMMARY_ITEMS = 20;

/** ダッシュボードの集計（docs/design.md §14.7 /admin） */
export async function summarizeAttempts(deps: DataDeps): Promise<AttemptSummary> {
  const now = nowOf(deps);
  const at = now.toISOString();
  const countOf = async (source: StatusSource) => {
    let total = 0;
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await deps.ddb.send(
        new QueryCommand({
          ...queryOf(deps, source, at),
          Select: "COUNT",
          ExclusiveStartKey: startKey,
        }),
      );
      total += res.Count ?? 0;
      startKey = res.LastEvaluatedKey;
    } while (startKey);
    return total;
  };
  const countEntries = await Promise.all(
    ATTEMPT_STATUSES.map(async (status) => {
      const parts = await Promise.all(sourcesOf(status).map(countOf));
      return [status, parts.reduce((a, b) => a + b, 0)] as const;
    }),
  );

  const until = new Date(now.getTime() + DUE_SOON_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const [dueSoon, unassigned] = await Promise.all([
    Promise.all(
      (["NOT_STARTED", "IN_PROGRESS"] as const).map((stored) =>
        queryAll(
          deps,
          // 索引のキー（GSI2SK）は Query のフィルタに使えないため、同じ値の deadlineAt で絞り込む
          queryOf(deps, { stored, range: "future" }, at, {
            filter: "deadlineAt <= :until",
            values: { ":until": until },
          }),
        ),
      ),
    ).then((lists) => lists.flat().sort((a, b) => a.deadlineAt.localeCompare(b.deadlineAt))),
    queryAll(
      deps,
      queryOf(deps, { stored: "SUBMITTED" }, at, {
        filter: "(attribute_not_exists(assignmentCount) OR assignmentCount = :zero)",
        values: { ":zero": 0 },
      }),
    )
      .then(withoutAssignments(deps))
      .then((list) =>
        list.sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? "")),
      ),
  ]);

  return {
    at,
    counts: Object.fromEntries(countEntries) as Record<AttemptStatus, number>,
    dueSoon: dueSoon.slice(0, SUMMARY_ITEMS),
    dueSoonTotal: dueSoon.length,
    unassigned: unassigned.slice(0, SUMMARY_ITEMS),
    unassignedTotal: unassigned.length,
  };
}

/**
 * 割り当て数を持たない受験から、割り当てのアイテムがあるものを除く。割り当て数は assignGraders が
 * 割り当てのときに初期化するが、それより前に割り当てた既存データは持たない（割り当てても、採点を
 * 始めるまでは SUBMITTED のまま）。割り当て数が 0 の受験はそのまま未割り当てとする
 */
function withoutAssignments(deps: DataDeps) {
  return async (list: AttemptRecord[]): Promise<AttemptRecord[]> => {
    const assigned = await Promise.all(
      list.map(async (a) => {
        if (a.assignmentCount !== undefined) return false;
        const res = await deps.ddb.send(
          new QueryCommand({
            TableName: deps.tableName,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
            ExpressionAttributeValues: { ":pk": keys.attemptPk(a.attemptId), ":sk": "ASSIGN#" },
            Select: "COUNT",
            Limit: 1,
          }),
        );
        return (res.Count ?? 0) > 0;
      }),
    );
    return list.filter((_, i) => !assigned[i]);
  };
}

async function queryAll(
  deps: DataDeps,
  input: ReturnType<typeof queryOf>,
): Promise<AttemptRecord[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await deps.ddb.send(new QueryCommand({ ...input, ExclusiveStartKey: startKey }));
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items.map(toAttempt);
}

// ---- 詳細 ----

export interface AdminAttemptView extends AttemptBundle {
  exam: ExamDefinition;
  /** 候補者の登録情報（個人データを削除した後は無い） */
  candidate?: UserProfile;
}

/** 受験の詳細（回答・割り当て・すべての採点者の採点）。状態は表示上の状態にする */
export async function getAdminAttemptView(
  deps: DataDeps,
  attemptId: string,
): Promise<AdminAttemptView> {
  const bundle = await getAttemptBundle(deps, attemptId);
  if (!bundle) throw new NotFoundError("受験が見つかりません");
  const [exam, candidate] = await Promise.all([
    getAttemptExam(deps, bundle.attempt),
    getUserBySub(deps, bundle.attempt.candidateSub),
  ]);
  return {
    ...bundle,
    attempt: { ...bundle.attempt, status: effectiveStatus(bundle.attempt, nowOf(deps)) },
    exam,
    ...(candidate ? { candidate } : {}),
  };
}

/** 提出ファイルのダウンロード用 URL（管理者。割り当ての確認はしない） */
export async function createAdminDownloadUrl(
  deps: DataDeps,
  input: { attemptId: string; qid: string },
): Promise<string> {
  if (!deps.files) throw new Error("FileStore が設定されていません");
  const bundle = await getAttemptBundle(deps, input.attemptId);
  if (!bundle) throw new NotFoundError("受験が見つかりません");
  const content = bundle.answers.find((a) => a.qid === input.qid)?.content as
    | (AnswerContent & { fileKey?: string; fileName?: string })
    | undefined;
  if (!content?.fileKey) throw new NotFoundError("提出ファイルがありません");
  return deps.files.createDownloadUrl(content.fileKey, content.fileName ?? "submission.zip");
}
