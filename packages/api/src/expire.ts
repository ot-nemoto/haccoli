import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { expireAttempts } from "@haccoli/core";
import { requiredEnv } from "./env.js";

/**
 * 期限処理（docs/design.md §6.4）。EventBridge Scheduler から 1 時間毎に起動する。
 * 失敗時は例外を投げ、Lambda のエラーとして監視・再実行の対象にする。
 */
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const tableName = requiredEnv("TABLE_NAME");

export async function handler(): Promise<{ expired: number }> {
  const { expired } = await expireAttempts({ ddb, tableName });
  // 個人情報は出さない（受験 ID のみ）
  console.log(
    JSON.stringify({ msg: "expire attempts", count: expired.length, attemptIds: expired }),
  );
  return { expired: expired.length };
}
