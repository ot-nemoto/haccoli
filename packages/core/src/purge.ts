import {
  AdminDeleteUserCommand,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import { DeleteObjectsCommand, ListObjectVersionsCommand, type S3Client } from "@aws-sdk/client-s3";
import { BatchWriteCommand, DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { AttemptStatus } from "@haccoli/shared";
import { type AttemptRecord, effectiveStatus, toAttempt } from "./attempts.js";
import { StateError, ValidationError } from "./errors.js";
import { GSI1, keys } from "./keys.js";
import { findUserByEmail, type UserDeps, UserNotFoundError, type UserProfile } from "./users.js";

/** 提出ファイルを全バージョン（削除マーカーを含む）削除するための操作 */
export interface FileVersionStore {
  /** プレフィックス配下の全バージョン・削除マーカー */
  listVersions(prefix: string): Promise<{ key: string; versionId: string }[]>;
  deleteVersions(versions: { key: string; versionId: string }[]): Promise<void>;
}

export interface PurgeDeps extends UserDeps {
  fileVersions: FileVersionStore;
}

export interface PurgeTarget {
  attempt: AttemptRecord;
  status: AttemptStatus;
  /** 受験の PK 配下のアイテム数（受験・回答・割り当て・採点） */
  itemCount: number;
  fileVersionCount: number;
}

export interface PurgePlan {
  user: UserProfile;
  attempts: PurgeTarget[];
}

/** 採点が終わっていない受験。削除すると候補者・採点者の作業が壊れるため、先に取消・採点を済ませる */
const BLOCKING: AttemptStatus[] = ["NOT_STARTED", "IN_PROGRESS", "SUBMITTED", "GRADING"];

const attemptPrefix = (attemptId: string) => `attempts/${attemptId}/`;

/**
 * 個人データ削除の対象を調べる（docs/design.md §8 user:purge）。何も削除しない。
 * 対象は候補者のみ（採点者は grader:disable で無効化する）。
 */
export async function planPurge(
  deps: PurgeDeps,
  email: string,
  now: Date = deps.now?.() ?? new Date(),
): Promise<PurgePlan> {
  const user = await findUserByEmail(deps, email);
  if (!user) throw new UserNotFoundError(email);
  if (user.role !== "candidate") {
    throw new ValidationError(
      `候補者ではありません（${user.role}）。採点者は grader:disable で無効化してください`,
    );
  }

  const attempts = await queryAll(deps, {
    IndexName: GSI1,
    KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": keys.attemptsByCandidate(user.sub, "").GSI1PK,
      ":sk": "ATTEMPT#",
    },
  });
  const targets: PurgeTarget[] = [];
  for (const item of attempts) {
    const attempt = toAttempt(item);
    if (attempt.candidateSub !== user.sub) continue;
    const status = effectiveStatus(attempt, now);
    if (BLOCKING.includes(status)) {
      throw new StateError(
        "INVALID",
        `採点が終わっていない受験があります: ${attempt.attemptId}（${status}）。取消（attempt:cancel）または採点の確定を済ませてください`,
      );
    }
    const items = await attemptItems(deps, attempt.attemptId);
    const versions = await deps.fileVersions.listVersions(attemptPrefix(attempt.attemptId));
    targets.push({
      attempt,
      status,
      itemCount: items.length,
      fileVersionCount: versions.length,
    });
  }
  return { user, attempts: targets };
}

/**
 * 個人データを削除する。途中で失敗しても、再実行すれば残りを削除できる順序にしている：
 * 受験ごとに S3 → 回答・割り当て・採点 → 受験（META）、最後に Cognito → User。
 * User を最後に消すので、再実行時もメールアドレスから対象を見つけられる。
 */
export async function executePurge(deps: PurgeDeps, plan: PurgePlan): Promise<void> {
  for (const { attempt } of plan.attempts) {
    const versions = await deps.fileVersions.listVersions(attemptPrefix(attempt.attemptId));
    if (versions.length > 0) await deps.fileVersions.deleteVersions(versions);

    const items = await attemptItems(deps, attempt.attemptId);
    const children = items.filter((i) => i.SK !== "META");
    await batchDelete(deps, children);
    await deps.ddb.send(
      new DeleteCommand({ TableName: deps.tableName, Key: keys.attemptMeta(attempt.attemptId) }),
    );
  }

  try {
    await deps.cognito.send(
      new AdminDeleteUserCommand({ UserPoolId: deps.userPoolId, Username: plan.user.email }),
    );
  } catch (e) {
    // 前回の実行で削除済み
    if (!(e instanceof UserNotFoundException)) throw e;
  }
  await deps.ddb.send(
    new DeleteCommand({ TableName: deps.tableName, Key: keys.user(plan.user.sub) }),
  );
}

async function attemptItems(deps: UserDeps, attemptId: string) {
  return queryAll(deps, {
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": keys.attemptMeta(attemptId).PK },
    ConsistentRead: true,
  });
}

async function queryAll(
  deps: UserDeps,
  input: Omit<ConstructorParameters<typeof QueryCommand>[0], "TableName" | "ExclusiveStartKey">,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await deps.ddb.send(
      new QueryCommand({ ...input, TableName: deps.tableName, ExclusiveStartKey: startKey }),
    );
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items;
}

const BATCH_SIZE = 25;
const MAX_BATCH_RETRIES = 5;

async function batchDelete(deps: UserDeps, items: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    let requests = items.slice(i, i + BATCH_SIZE).map((item) => ({
      DeleteRequest: { Key: { PK: item.PK, SK: item.SK } },
    }));
    for (let attempt = 0; requests.length > 0; attempt++) {
      if (attempt > MAX_BATCH_RETRIES) {
        throw new Error("DynamoDB の削除が完了しませんでした。もう一度実行してください");
      }
      if (attempt > 0) await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      const res = await deps.ddb.send(
        new BatchWriteCommand({ RequestItems: { [deps.tableName]: requests } }),
      );
      requests = (res.UnprocessedItems?.[deps.tableName] ?? []) as typeof requests;
    }
  }
}

/** S3 の実装。バージョニングが有効なバケットの旧版・削除マーカーも含めて削除する */
export function s3FileVersionStore(s3: S3Client, bucket: string): FileVersionStore {
  return {
    async listVersions(prefix) {
      const out: { key: string; versionId: string }[] = [];
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      do {
        const res = await s3.send(
          new ListObjectVersionsCommand({
            Bucket: bucket,
            Prefix: prefix,
            KeyMarker: keyMarker,
            VersionIdMarker: versionIdMarker,
          }),
        );
        for (const v of [...(res.Versions ?? []), ...(res.DeleteMarkers ?? [])]) {
          if (v.Key && v.VersionId) out.push({ key: v.Key, versionId: v.VersionId });
        }
        keyMarker = res.IsTruncated ? res.NextKeyMarker : undefined;
        versionIdMarker = res.IsTruncated ? res.NextVersionIdMarker : undefined;
      } while (keyMarker);
      return out;
    },

    async deleteVersions(versions) {
      for (let i = 0; i < versions.length; i += 1000) {
        const res = await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
              Quiet: true,
              Objects: versions
                .slice(i, i + 1000)
                .map((v) => ({ Key: v.key, VersionId: v.versionId })),
            },
          }),
        );
        if (res.Errors && res.Errors.length > 0) {
          const first = res.Errors[0];
          throw new Error(
            `提出ファイルを削除できませんでした（${res.Errors.length} 件。例: ${first?.Key} ${first?.Code}）。もう一度実行してください`,
          );
        }
      }
    },
  };
}
