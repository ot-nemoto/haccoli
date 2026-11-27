import { randomUUID } from "node:crypto";
import {
  type DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  Actor,
  AuditAction,
  AuditDetail,
  AuditEntry,
  AuditRecord,
  AuditStatus,
  AuditTarget,
} from "@haccoli/shared";
import { jstDate } from "./deadline.js";
import { ValidationError } from "./errors.js";
import { type Page, readPage } from "./paging.js";

/**
 * 監査ログ（docs/design.md §14.4）。管理者（画面）とスーパー管理者（CLI）の変更操作を、
 * 業務データとは別のテーブルに記録する。
 *
 * - DynamoDB だけの操作は、操作と同じトランザクションで書く（auditPut）
 * - Cognito・S3 にまたがる操作は、実行前に STARTED、終了後に SUCCEEDED / FAILED（withAudit）
 *
 * 回答・採点の本文や候補者のメールアドレス・氏名は含めない。個人データの削除後も残るため。
 */

export {
  type Actor,
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditDetail,
  type AuditEntry,
  type AuditRecord,
  type AuditStatus,
  type AuditTarget,
  isAuditAction,
} from "@haccoli/shared";

export interface AuditDeps {
  ddb: DynamoDBDocumentClient;
  auditTableName: string;
  /** 記録する実行者。変更操作では必須にし、API・CLI のどちらから呼んでも記録が漏れないようにする */
  actor: Actor;
  now?: () => Date;
}

const nowOf = (deps: Pick<AuditDeps, "now">) => deps.now?.() ?? new Date();

/** JST の年月（yyyymm）。月ごとの一覧に使う */
export function auditMonth(at: Date): string {
  return jstDate(at).slice(0, 7).replace("-", "");
}

const auditKey = (month: string, id: string) => ({ PK: `AUDIT#${month}`, SK: id });

function newRecord(deps: AuditDeps, entry: AuditEntry, status: AuditStatus): AuditRecord {
  const at = nowOf(deps);
  const iso = at.toISOString();
  return {
    id: `${iso}#${randomUUID()}`,
    month: auditMonth(at),
    at: iso,
    actor: deps.actor,
    action: entry.action,
    ...(entry.target ? { target: entry.target } : {}),
    detail: compact(entry.detail ?? {}),
    status,
  };
}

function toItem(record: AuditRecord): Record<string, unknown> {
  return { ...auditKey(record.month, record.id), type: "Audit", ...record };
}

/**
 * DynamoDB だけの操作で、操作と同じトランザクションに入れる記録（SUCCEEDED）。
 * 記録できなければ操作も行われない。
 */
export function auditPut(deps: AuditDeps, entry: AuditEntry) {
  return {
    Put: {
      TableName: deps.auditTableName,
      Item: toItem(newRecord(deps, entry, "SUCCEEDED")),
      ConditionExpression: "attribute_not_exists(PK)",
    },
  };
}

/** 1 件だけ記録する（データを渡す前に記録する読み取り操作など）。記録できなければ例外 */
export async function writeAudit(deps: AuditDeps, entry: AuditEntry): Promise<AuditRecord> {
  const record = newRecord(deps, entry, "SUCCEEDED");
  await deps.ddb.send(
    new PutCommand({
      TableName: deps.auditTableName,
      Item: toItem(record),
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  return record;
}

/**
 * Cognito・S3 にまたがる操作の記録。実行前に STARTED を書き（失敗したら操作しない）、
 * 終わったら SUCCEEDED / FAILED に更新する。最後の更新に失敗しても操作の結果は変えない
 * （STARTED のまま残り、一覧で結果不明として扱う）。
 *
 * @param finish 成功時に記録へ加える対象・内容（登録で決まる sub など）
 */
export async function withAudit<T>(
  deps: AuditDeps,
  entry: AuditEntry,
  run: () => Promise<T>,
  finish?: (value: T) => Omit<AuditEntry, "action">,
): Promise<T> {
  const record = newRecord(deps, entry, "STARTED");
  await deps.ddb.send(
    new PutCommand({
      TableName: deps.auditTableName,
      Item: toItem(record),
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  let value: T;
  try {
    value = await run();
  } catch (e) {
    await finishAudit(deps, record, { status: "FAILED", error: describeError(e) });
    throw e;
  }
  const extra = finish?.(value) ?? {};
  await finishAudit(deps, record, {
    status: "SUCCEEDED",
    target: extra.target,
    detail: extra.detail ? compact({ ...record.detail, ...extra.detail }) : undefined,
  });
  return value;
}

async function finishAudit(
  deps: AuditDeps,
  record: AuditRecord,
  result: { status: AuditStatus; target?: AuditTarget; detail?: AuditDetail; error?: string },
): Promise<void> {
  const values: Record<string, unknown> = {
    ":status": result.status,
    ":started": "STARTED",
    ":finishedAt": nowOf(deps).toISOString(),
  };
  const sets = ["#s = :status", "finishedAt = :finishedAt"];
  for (const key of ["target", "detail", "error"] as const) {
    if (result[key] === undefined) continue;
    sets.push(`#${key} = :${key}`);
    values[`:${key}`] = result[key];
  }
  try {
    await deps.ddb.send(
      new UpdateCommand({
        TableName: deps.auditTableName,
        Key: auditKey(record.month, record.id),
        UpdateExpression: `SET ${sets.join(", ")}`,
        ConditionExpression: "#s = :started",
        ExpressionAttributeNames: {
          "#s": "status",
          ...Object.fromEntries(
            (["target", "detail", "error"] as const)
              .filter((k) => result[k] !== undefined)
              .map((k) => [`#${k}`, k]),
          ),
        },
        ExpressionAttributeValues: values,
      }),
    );
  } catch (e) {
    // 操作自体は終わっているので結果は変えない。STARTED のまま残り、一覧で結果不明と表示する
    console.error("監査ログの結果を記録できませんでした", record.id, e);
  }
}

/** 失敗の理由。メッセージにメールアドレスが入ることがあるため伏せ、長さも抑える */
export function describeError(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return text.replace(/[^\s@:<>（）()]+@[^\s@:<>（）()]+/g, "<email>").slice(0, 500);
}

function compact(detail: AuditDetail): AuditDetail {
  return Object.fromEntries(Object.entries(detail).filter(([, v]) => v !== undefined));
}

export interface AuditFilter {
  /** JST の年月（yyyymm） */
  month: string;
  action?: AuditAction;
}

/** 監査ログの一覧（新しい順、すべて）。CLI で使う */
export async function listAuditLogs(
  deps: Pick<AuditDeps, "ddb" | "auditTableName">,
  filter: AuditFilter,
): Promise<AuditRecord[]> {
  const fetch = auditQuery(deps, filter);
  const records: AuditRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await fetch(startKey);
    records.push(...(res.Items ?? []).map(toRecord));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return records;
}

/** 監査ログの一覧（新しい順、ページごと）。管理者 API で使う */
export async function listAuditLogPage(
  deps: Pick<AuditDeps, "ddb" | "auditTableName">,
  filter: AuditFilter & { limit?: number; cursor?: string },
): Promise<Page<AuditRecord>> {
  const page = await readPage(auditQuery(deps, filter), {
    limit: filter.limit,
    cursor: filter.cursor,
    isValidKey: (key) => key.PK === `AUDIT#${filter.month}`,
  });
  return { ...page, items: page.items.map(toRecord) };
}

function auditQuery(deps: Pick<AuditDeps, "ddb" | "auditTableName">, filter: AuditFilter) {
  if (!/^\d{6}$/.test(filter.month)) {
    throw new ValidationError(`月は yyyymm の形式で指定してください: ${filter.month}`);
  }
  return (startKey: Record<string, unknown> | undefined) =>
    deps.ddb.send(
      new QueryCommand({
        TableName: deps.auditTableName,
        KeyConditionExpression: "PK = :pk",
        ...(filter.action
          ? {
              FilterExpression: "#a = :action",
              ExpressionAttributeNames: { "#a": "action" },
            }
          : {}),
        ExpressionAttributeValues: {
          ":pk": `AUDIT#${filter.month}`,
          ...(filter.action ? { ":action": filter.action } : {}),
        },
        ScanIndexForward: false,
        ExclusiveStartKey: startKey,
      }),
    );
}

function toRecord(item: Record<string, unknown>): AuditRecord {
  return {
    id: String(item.id),
    month: String(item.month),
    at: String(item.at),
    actor: item.actor as Actor,
    action: item.action as AuditAction,
    ...(item.target ? { target: item.target as AuditTarget } : {}),
    detail: (item.detail ?? {}) as AuditDetail,
    status: item.status as AuditStatus,
    ...(item.finishedAt ? { finishedAt: String(item.finishedAt) } : {}),
    ...(item.error ? { error: String(item.error) } : {}),
  };
}
