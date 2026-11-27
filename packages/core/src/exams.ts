import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  type DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { ExamDefinition } from "@haccoli/shared";
import { examDefinitionSchema } from "@haccoli/shared/schemas";
import { type AuditDeps, auditPut } from "./audit.js";
import { ValidationError } from "./errors.js";
import type { FileStore } from "./files.js";
import { keys } from "./keys.js";

export interface DataDeps {
  ddb: DynamoDBDocumentClient;
  tableName: string;
  now?: () => Date;
  /** 提出ファイルの保存先（ファイル提出を扱う処理でのみ必要） */
  files?: FileStore;
}

/** DynamoDB の 1 アイテム上限（400KB）に余裕を持たせた課題定義のサイズ上限 */
const MAX_DEFINITION_BYTES = 350_000;

/**
 * exams/<examId>/ を読み込み、本文ファイル参照（intro / questions[].body / rubric.body）を
 * 展開して検証する（docs/design.md §5）。
 */
export async function loadExamDir(dir: string): Promise<ExamDefinition> {
  const root = resolve(dir);
  const readText = async (ref: unknown, label: string): Promise<string> => {
    if (typeof ref !== "string" || !ref)
      throw new ValidationError(`${label} にファイルを指定してください`);
    const path = resolve(root, ref);
    const rel = relative(root, path);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new ValidationError(
        `${label} は課題ディレクトリ内のファイルを指定してください: ${ref}`,
      );
    }
    try {
      return await readFile(path, "utf8");
    } catch {
      throw new ValidationError(`${label} のファイルを読み込めません: ${ref}`);
    }
  };

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(join(root, "exam.json"), "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new ValidationError(`exam.json を読み込めません: ${(e as Error).message}`);
  }
  if (!Array.isArray(raw.questions))
    throw new ValidationError("questions は配列で指定してください");

  const questions = await Promise.all(
    raw.questions.map(async (q: Record<string, unknown>, i: number) => {
      const label = `questions[${i}]`;
      const rubric = q.rubric as Record<string, unknown> | undefined;
      return {
        ...q,
        body: await readText(q.body, `${label}.body`),
        ...(rubric
          ? {
              rubric: {
                ...rubric,
                ...(rubric.body !== undefined
                  ? { body: await readText(rubric.body, `${label}.rubric.body`) }
                  : {}),
              },
            }
          : {}),
      };
    }),
  );

  return parseExamDefinition({
    ...raw,
    intro: await readText(raw.intro, "intro"),
    questions,
  });
}

export function parseExamDefinition(input: unknown): ExamDefinition {
  const result = examDefinitionSchema.safeParse(input);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ValidationError(`課題定義が不正です:\n${detail}`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(result.data));
  if (bytes > MAX_DEFINITION_BYTES) {
    throw new ValidationError(
      `課題定義が大きすぎます（${bytes} バイト > ${MAX_DEFINITION_BYTES}）。本文を短くしてください`,
    );
  }
  return result.data;
}

export interface ExamSummary {
  examId: string;
  title: string;
  latestVersion: number;
  updatedAt: string;
}

export type PublishResult =
  | { kind: "published"; examId: string; version: number }
  | { kind: "unchanged"; examId: string; version: number };

/**
 * 課題定義を新しい版として投入する。最新版と同一内容なら投入しない。
 * 版の採番は META の latestVersion を条件付きで更新して競合を防ぐ。
 */
export async function publishExam(
  deps: DataDeps & AuditDeps,
  definition: ExamDefinition,
): Promise<PublishResult> {
  const def = parseExamDefinition(definition);
  const meta = await deps.ddb.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: keys.examMeta(def.examId),
      ConsistentRead: true,
    }),
  );
  const prev = meta.Item ? Number(meta.Item.latestVersion) : 0;

  if (prev > 0) {
    const latest = await getExamVersion(deps, def.examId, prev);
    // DynamoDB の Map は項目順を保持しないため、項目順に依存しない形で比較する
    if (latest && canonicalJson(latest) === canonicalJson(def)) {
      return { kind: "unchanged", examId: def.examId, version: prev };
    }
  }

  const version = prev + 1;
  const now = (deps.now?.() ?? new Date()).toISOString();
  await deps.ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: deps.tableName,
            Item: {
              ...keys.examMeta(def.examId),
              type: "Exam",
              examId: def.examId,
              title: def.title,
              latestVersion: version,
              updatedAt: now,
            },
            ConditionExpression: prev === 0 ? "attribute_not_exists(PK)" : "latestVersion = :prev",
            ...(prev === 0 ? {} : { ExpressionAttributeValues: { ":prev": prev } }),
          },
        },
        {
          Put: {
            TableName: deps.tableName,
            Item: {
              ...keys.examVersion(def.examId, version),
              type: "ExamVersion",
              examId: def.examId,
              version,
              definition: def,
              publishedAt: now,
            },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        auditPut(deps, {
          action: "exam.publish",
          target: { type: "exam", id: def.examId },
          detail: { version, title: def.title },
        }),
      ],
    }),
  );
  return { kind: "published", examId: def.examId, version };
}

export async function getExamSummary(
  deps: DataDeps,
  examId: string,
): Promise<ExamSummary | undefined> {
  const res = await deps.ddb.send(
    new GetCommand({ TableName: deps.tableName, Key: keys.examMeta(examId) }),
  );
  return res.Item ? toExamSummary(res.Item) : undefined;
}

/** 版は不変なので、Lambda のコンテナ内でキャッシュしてよい */
const versionCache = new Map<string, ExamDefinition>();

export async function getExamVersion(
  deps: DataDeps,
  examId: string,
  version: number,
): Promise<ExamDefinition | undefined> {
  const cacheKey = `${examId}#${version}`;
  const cached = versionCache.get(cacheKey);
  if (cached) return cached;
  const res = await deps.ddb.send(
    new GetCommand({ TableName: deps.tableName, Key: keys.examVersion(examId, version) }),
  );
  if (!res.Item) return undefined;
  const def = res.Item.definition as ExamDefinition;
  versionCache.set(cacheKey, def);
  return def;
}

export async function listExams(deps: DataDeps): Promise<ExamSummary[]> {
  // 課題は数件の想定。増えたら一覧用の GSI を追加する
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await deps.ddb.send(
      new ScanCommand({
        TableName: deps.tableName,
        FilterExpression: "#t = :t",
        ExpressionAttributeNames: { "#t": "type" },
        ExpressionAttributeValues: { ":t": "Exam" },
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items.map(toExamSummary).sort((a, b) => a.examId.localeCompare(b.examId));
}

/** オブジェクトのキーを並べ替えた JSON（配列の順序は保つ） */
export function canonicalJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, normalize((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(normalize(value));
}

function toExamSummary(item: Record<string, unknown>): ExamSummary {
  return {
    examId: String(item.examId),
    title: String(item.title),
    latestVersion: Number(item.latestVersion),
    updatedAt: String(item.updatedAt),
  };
}
