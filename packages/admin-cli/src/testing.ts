import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "./context.js";

/**
 * E2E の後片付け専用。テストで管理画面から作った課題（META・下書き・版）を削除する。
 * 管理者 API には課題を消す手段がない（DeleteItem を与えていない）ため、IAM（スーパー管理者）で消す。
 * 監査ログは消さない。誤って本番の課題を消さないよう、dev の e2e-exam- で始まる課題に限る
 */
export async function deleteE2eExam(ctx: Context, examId: string): Promise<number> {
  if (ctx.env !== "dev") throw new Error("dev 以外では削除できません");
  if (!/^e2e-exam-[a-z0-9-]+$/.test(examId)) {
    throw new Error(`E2E のテストで作った課題ではありません: ${examId}`);
  }
  const pk = `EXAM#${examId}`;
  let deleted = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.deps.ddb.send(
      new QueryCommand({
        TableName: ctx.deps.tableName,
        KeyConditionExpression: "PK = :pk",
        ProjectionExpression: "PK, SK",
        ExpressionAttributeValues: { ":pk": pk },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of res.Items ?? []) {
      await ctx.deps.ddb.send(
        new DeleteCommand({ TableName: ctx.deps.tableName, Key: { PK: item.PK, SK: item.SK } }),
      );
      deleted++;
    }
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return deleted;
}
