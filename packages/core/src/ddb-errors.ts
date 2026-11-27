/** DynamoDB の条件付き書き込み・トランザクションの失敗の判定（core の内部で使う） */

/** @internal */
export function isConditionFailure(e: unknown): boolean {
  return e instanceof Error && e.name === "ConditionalCheckFailedException";
}

/** @internal トランザクションが取り消された理由（アイテムの順）。取り消し以外のエラーは undefined */
export function transactionFailureCodes(e: unknown): (string | undefined)[] | undefined {
  if (!(e instanceof Error) || e.name !== "TransactionCanceledException") return undefined;
  const reasons = (e as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return reasons?.map((r) => r.Code);
}
