import { GetCommand, QueryCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { ExamDefinition, ExamDraftDefinition } from "@haccoli/shared";
import { examDefinitionSchema, examDraftSchema } from "@haccoli/shared/schemas";
import * as z from "zod";
import { type AuditDeps, auditPut } from "./audit.js";
import { transactionFailureCodes } from "./ddb-errors.js";
import {
  DomainError,
  NotFoundError,
  StateError,
  ValidationError,
  VersionConflictError,
} from "./errors.js";
import {
  type DataDeps,
  type ExamSummary,
  getExamVersion,
  latestVersionOf,
  type PublishResult,
  parseExamDefinition,
  publishVersion,
} from "./exams.js";
import { keys } from "./keys.js";

/**
 * 課題の作成・編集（docs/design.md §14.5）。編集中の内容は下書き（EXAM#<examId> / DRAFT）に保存し、
 * 公開で新しい版（V#<version>）を作る。発行済みの受験は版を指すので影響しない。
 *
 * - 下書きは楽観ロック（version）で、別の画面の保存を上書きしない
 * - 下書きは元にした公開版（baseVersion）を持つ。その後に CLI などで新しい版が公開されていたら、
 *   公開を拒否する（新しい版の内容を、古い版を元にした下書きで上書きしない）
 * - 管理者 API の Lambda には DeleteItem を与えないため、公開しても下書きは消さず、
 *   公開した版（publishedVersion）を記録する
 */

/** 下書きを保存した人（管理画面の管理者） */
export interface Editor {
  sub: string;
  name: string;
}

export interface ExamDraftRecord {
  examId: string;
  definition: ExamDraftDefinition;
  version: number;
  baseVersion: number;
  updatedAt: string;
  updatedBy: Editor;
  publishedVersion?: number;
}

/** 既にある課題 ID で新しい課題を作ろうとした */
export class ExamAlreadyExistsError extends DomainError {}

/** DynamoDB の 1 アイテム上限（400KB）に余裕を持たせた下書きのサイズ上限 */
const MAX_DRAFT_BYTES = 350_000;

const nowOf = (deps: DataDeps) => deps.now?.() ?? new Date();

/**
 * 公開の前に直すべき点（公開時の検証の結果）。無ければ公開できる。
 * 画面に出すため、メッセージは日本語にし、場所を「問 2 の問題文」のように示す
 */
export function examProblems(definition: unknown): string[] {
  const result = examDefinitionSchema.safeParse(definition, { error: z.locales.ja().localeError });
  const problems = result.success
    ? []
    : result.error.issues.map((i) => `${placeOf(i.path)}: ${i.message}`);
  if (result.success) {
    const bytes = Buffer.byteLength(JSON.stringify(result.data));
    if (bytes > MAX_DRAFT_BYTES) problems.push(`全体: 大きすぎます（${bytes} バイト）`);
  }
  return problems;
}

const FIELD_LABELS: Record<string, string> = {
  examId: "課題 ID",
  title: "題名",
  intro: "冒頭説明",
  questions: "問題",
  qid: "問題 ID",
  type: "回答形式",
  body: "本文",
  rubric: "採点基準",
  points: "配点",
  correct: "正解",
  maxLength: "最大文字数",
  multiple: "複数選択",
  options: "選択肢",
  id: "ID",
  label: "表示",
  file: "ファイル",
  maxSizeMB: "最大サイズ",
};

/** zod の issue の path を「問 2 の選択肢 1 の表示」のような場所にする */
function placeOf(path: PropertyKey[]): string {
  if (path.length === 0) return "全体";
  const parts: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    const next = path[i + 1];
    if (key === "questions" && typeof next === "number") {
      parts.push(`問 ${next + 1}`);
      i++;
    } else if (key === "options" && typeof next === "number") {
      parts.push(`選択肢 ${next + 1}`);
      i++;
    } else if (key === "body" && path[i - 1] === "rubric") {
      parts[parts.length - 1] = "採点基準";
    } else if (typeof key === "number") {
      parts.push(`${key + 1} 番目`);
    } else {
      parts.push(FIELD_LABELS[String(key)] ?? String(key));
    }
  }
  return parts.join("の");
}

/**
 * 下書きを保存する。create なら新しい課題として META も作る（版の番号なし。§14.5）。
 * 監査ログ（exam.save）は同じトランザクションで書く。保存した下書きと、公開の前に直すべき点を返す
 */
export async function saveExamDraft(
  deps: DataDeps & AuditDeps,
  input: {
    examId: string;
    definition: ExamDraftDefinition;
    version: number;
    /** 元にした版を、今の最新版に付け替える（最新版の内容から作り直したとき） */
    rebase?: boolean;
    /** 下書きを初めて作るとき（version 0）、画面が編集を始めた公開版 */
    startedFrom?: number;
    create?: boolean;
    editor: Editor;
  },
): Promise<{ draft: ExamDraftRecord; problems: string[] }> {
  const parsed = examDraftSchema.safeParse(input.definition);
  if (!parsed.success) throw new ValidationError("下書きの形が不正です");
  const definition = parsed.data;
  if (definition.examId !== input.examId) {
    throw new ValidationError("課題 ID は変更できません");
  }
  const bytes = Buffer.byteLength(JSON.stringify(definition));
  if (bytes > MAX_DRAFT_BYTES) {
    throw new ValidationError(`下書きが大きすぎます（${bytes} バイト）。本文を短くしてください`);
  }

  // 元にした版はサーバーで決める（画面の値を信じると、新しい版の上書きを防げない）
  //  - 新しい課題：0（未公開）
  //  - 下書きを初めて作る：画面が編集を始めた版（省略時は今の最新版）
  //  - 保存し直す：前の下書きの値を引き継ぐ。rebase のときだけ今の最新版に付け替える
  const meta = await getMeta(deps, input.examId);
  let baseVersion = 0;
  if (input.create) {
    if (meta) throw new ExamAlreadyExistsError(`既にある課題 ID です: ${input.examId}`);
    if (input.version !== 0) {
      throw new ValidationError("新しい課題の下書きは、版 0 から保存してください");
    }
  } else {
    if (!meta) throw new NotFoundError(`課題が見つかりません: ${input.examId}`);
    const latest = latestVersionOf(meta);
    if (input.version === 0) {
      // 編集を始めた後に新しい版が公開されていたら、編集を始めた版を元にしたことにする
      // （公開を止めて、最新版からの作り直しを促す）。今の最新版より新しい版は無い
      const started = input.startedFrom ?? latest;
      if (started > latest) throw new ValidationError("編集を始めた版が不正です");
      baseVersion = started;
    } else {
      const current = await getDraft(deps, input.examId);
      if (!current || current.version !== input.version) throw new VersionConflictError();
      baseVersion = input.rebase ? latest : current.baseVersion;
    }
  }

  const now = nowOf(deps).toISOString();
  const draft: ExamDraftRecord = {
    examId: input.examId,
    definition,
    version: input.version + 1,
    baseVersion,
    updatedAt: now,
    updatedBy: { sub: input.editor.sub, name: input.editor.name },
  };
  try {
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          ...(input.create
            ? [
                {
                  Put: {
                    TableName: deps.tableName,
                    Item: {
                      ...keys.examMeta(input.examId),
                      type: "Exam",
                      examId: input.examId,
                      title: definition.title || input.examId,
                      updatedAt: now,
                    },
                    ConditionExpression: "attribute_not_exists(PK)",
                  },
                },
              ]
            : []),
          {
            Put: {
              TableName: deps.tableName,
              Item: { ...keys.examDraft(input.examId), type: "ExamDraft", ...draft },
              // 読み込んだ時点の版のまま（別の画面で保存されていない）こと
              ConditionExpression:
                input.version === 0 ? "attribute_not_exists(PK)" : "version = :expected",
              ...(input.version === 0
                ? {}
                : { ExpressionAttributeValues: { ":expected": input.version } }),
            },
          },
          auditPut(deps, {
            action: "exam.save",
            target: { type: "exam", id: input.examId },
            detail: {
              version: draft.version,
              baseVersion: draft.baseVersion,
              questions: definition.questions.length,
              ...(input.create ? { created: true } : {}),
              ...(input.rebase ? { rebased: true } : {}),
            },
          }),
        ],
      }),
    );
  } catch (e) {
    const codes = transactionFailureCodes(e);
    if (input.create && codes?.[0] === "ConditionalCheckFailed") {
      throw new ExamAlreadyExistsError(`既にある課題 ID です: ${input.examId}`);
    }
    if (codes?.[input.create ? 1 : 0] === "ConditionalCheckFailed") {
      throw new VersionConflictError();
    }
    throw e;
  }
  return { draft, problems: examProblems(definition) };
}

/**
 * 下書きを検証して、新しい版として公開する（exam:publish と同じ検証）。最新版と同じ内容なら版を作らない。
 * 下書きを読み込んだ後に保存し直されていたら（version が違う）、元にした版より新しい版が公開されて
 * いたら、公開しない
 */
export async function publishExamDraft(
  deps: DataDeps & AuditDeps,
  input: { examId: string; version: number },
): Promise<PublishResult & { draftVersion: number }> {
  const [meta, draft] = await Promise.all([
    getMeta(deps, input.examId),
    getDraft(deps, input.examId),
  ]);
  if (!meta || !draft) throw new NotFoundError("下書きが見つかりません");
  if (draft.version !== input.version) throw new VersionConflictError();
  const latest = latestVersionOf(meta);
  if (draft.baseVersion !== latest) {
    throw new StateError(
      "INVALID",
      `この下書きは v${draft.baseVersion} を元にしていますが、その後に v${latest} が公開されています。最新版の内容を確かめてから、下書きを作り直してください`,
    );
  }
  let def: ExamDefinition;
  try {
    def = parseExamDefinition(draft.definition);
  } catch {
    const problems = examProblems(draft.definition);
    throw new ValidationError(`公開の前に直してください: ${problems.join(" / ")}`);
  }

  /**
   * 公開した版を下書きに記録する（下書きは消さない）。下書きの版も進め、公開前に読み込んだ画面が
   * 保存して公開の記録を消さないようにする。下書きの版が変わっていたら失敗させる
   */
  const draftVersion = input.version + 1;
  const markDraft = (version: number) => [
    {
      Update: {
        TableName: deps.tableName,
        Key: keys.examDraft(input.examId),
        UpdateExpression: "SET publishedVersion = :v, baseVersion = :v, version = :next",
        ConditionExpression: "version = :expected",
        ExpressionAttributeValues: {
          ":v": version,
          ":next": draftVersion,
          ":expected": input.version,
        },
      },
    },
  ];
  let result: PublishResult;
  try {
    result = await publishVersion(deps, def, latest, {
      extra: markDraft,
      detail: { draftVersion: input.version },
    });
  } catch (e) {
    // publishVersion のトランザクション：[0] META、[1] 新しい版、[2] 下書き、[3] 監査ログ
    const codes = transactionFailureCodes(e);
    if (codes?.[0] === "ConditionalCheckFailed") {
      throw new StateError(
        "INVALID",
        "公開の途中で、別の版が公開されました。最新版の内容を確かめてください",
      );
    }
    if (codes?.[2] === "ConditionalCheckFailed") throw new VersionConflictError();
    throw e;
  }
  if (result.kind === "published") return { ...result, draftVersion };
  if (draft.publishedVersion === result.version) {
    // 記録済み（同じ下書きをもう一度公開した）：何も書かない
    return { ...result, draftVersion: input.version };
  }
  // 最新版と同じ内容：版は作らず、下書きがその版と同じであることを記録する（監査ログも同じトランザクション）
  try {
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          ...markDraft(result.version),
          auditPut(deps, {
            action: "exam.publish",
            target: { type: "exam", id: input.examId },
            detail: { version: result.version, draftVersion: input.version, unchanged: true },
          }),
        ],
      }),
    );
  } catch (e) {
    if (transactionFailureCodes(e)?.[0] === "ConditionalCheckFailed") {
      throw new VersionConflictError();
    }
    throw e;
  }
  return { ...result, draftVersion };
}

export interface AdminExamSummary extends ExamSummary {
  draft?: Omit<ExamDraftRecord, "definition" | "examId"> & { title: string };
}

/** 課題の一覧（未公開の課題・下書きの有無を含む）。下書きの本文は読まない */
export async function listExamsWithDrafts(deps: DataDeps): Promise<AdminExamSummary[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await deps.ddb.send(
      new ScanCommand({
        TableName: deps.tableName,
        FilterExpression: "#type IN (:exam, :draft)",
        ProjectionExpression:
          "#type, examId, title, latestVersion, updatedAt, version, baseVersion, updatedBy, publishedVersion, #def.title",
        ExpressionAttributeNames: { "#type": "type", "#def": "definition" },
        ExpressionAttributeValues: { ":exam": "Exam", ":draft": "ExamDraft" },
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey);

  const drafts = new Map(
    items
      .filter((i) => i.type === "ExamDraft")
      .map((i) => [String(i.examId), toDraftInfo(i)] as const),
  );
  return items
    .filter((i) => i.type === "Exam")
    .map((i) => {
      const draft = drafts.get(String(i.examId));
      return {
        examId: String(i.examId),
        title: String(i.title),
        ...(i.latestVersion !== undefined ? { latestVersion: Number(i.latestVersion) } : {}),
        updatedAt: String(i.updatedAt),
        ...(draft ? { draft } : {}),
      };
    })
    .sort((a, b) => a.examId.localeCompare(b.examId));
}

export interface ExamEditView {
  exam: AdminExamSummary;
  latest?: ExamDefinition;
  draft?: ExamDraftRecord & { problems: string[] };
  versions: { version: number; title: string; publishedAt: string }[];
}

/** 課題の詳細（最新版・下書き・版の履歴）。編集の画面で使う */
export async function getExamForEdit(deps: DataDeps, examId: string): Promise<ExamEditView> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await deps.ddb.send(
      new QueryCommand({
        TableName: deps.tableName,
        KeyConditionExpression: "PK = :pk",
        // 版の定義は最新版だけ読む（履歴は題名と公開日時だけ）
        ProjectionExpression:
          "SK, #type, examId, title, latestVersion, updatedAt, version, baseVersion, updatedBy, publishedVersion, publishedAt, #def.title",
        ExpressionAttributeNames: { "#type": "type", "#def": "definition" },
        ExpressionAttributeValues: { ":pk": keys.examMeta(examId).PK },
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey);

  const meta = items.find((i) => i.SK === "META");
  if (!meta) throw new NotFoundError(`課題が見つかりません: ${examId}`);
  const latestVersion = latestVersionOf(meta);
  const [latest, draft] = await Promise.all([
    latestVersion > 0 ? getExamVersion(deps, examId, latestVersion) : undefined,
    getDraft(deps, examId),
  ]);
  const draftInfo = draft ? toDraftInfo({ ...draft, definition: draft.definition }) : undefined;
  return {
    exam: {
      examId,
      title: String(meta.title),
      ...(latestVersion > 0 ? { latestVersion } : {}),
      updatedAt: String(meta.updatedAt),
      ...(draftInfo ? { draft: draftInfo } : {}),
    },
    ...(latest ? { latest } : {}),
    ...(draft ? { draft: { ...draft, problems: examProblems(draft.definition) } } : {}),
    versions: items
      .filter((i) => String(i.SK).startsWith("V#"))
      .map((i) => ({
        version: Number(i.version),
        // 題名を持たない古い版は、定義の題名を使う
        title: String(i.title ?? (i.definition as { title?: string } | undefined)?.title ?? ""),
        publishedAt: String(i.publishedAt),
      }))
      .sort((a, b) => b.version - a.version),
  };
}

async function getMeta(
  deps: DataDeps,
  examId: string,
): Promise<Record<string, unknown> | undefined> {
  const res = await deps.ddb.send(
    new GetCommand({ TableName: deps.tableName, Key: keys.examMeta(examId), ConsistentRead: true }),
  );
  return res.Item;
}

async function getDraft(deps: DataDeps, examId: string): Promise<ExamDraftRecord | undefined> {
  const res = await deps.ddb.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: keys.examDraft(examId),
      ConsistentRead: true,
    }),
  );
  const i = res.Item;
  if (!i) return undefined;
  return {
    examId: String(i.examId),
    definition: i.definition as ExamDraftDefinition,
    version: Number(i.version),
    baseVersion: Number(i.baseVersion),
    updatedAt: String(i.updatedAt),
    updatedBy: i.updatedBy as Editor,
    ...(i.publishedVersion !== undefined ? { publishedVersion: Number(i.publishedVersion) } : {}),
  };
}

function toDraftInfo(i: Record<string, unknown>): NonNullable<AdminExamSummary["draft"]> {
  return {
    version: Number(i.version),
    title: String((i.definition as { title?: string } | undefined)?.title ?? ""),
    baseVersion: Number(i.baseVersion),
    updatedAt: String(i.updatedAt),
    updatedBy: i.updatedBy as Editor,
    ...(i.publishedVersion !== undefined ? { publishedVersion: Number(i.publishedVersion) } : {}),
  };
}
