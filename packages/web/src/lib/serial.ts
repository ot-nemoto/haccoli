/**
 * キー（問題）ごとに非同期処理を直列化する。
 *
 * 実行中に同じキーで要求されたら、終わった後にもう一度だけ実行する（途中の要求はまとめる）。
 * どの要求も、そのキーの処理がすべて終わる（再実行を含めて空く）まで待ってから解決する。
 * 「保存の通信中に提出すると、保存の完了を待たずに判定される」不具合（#19）を防ぐため。
 */
export class SerialRunner {
  private readonly running = new Map<string, Promise<void>>();
  private readonly pending = new Set<string>();

  constructor(private readonly task: (key: string) => Promise<void>) {}

  /** 処理を要求する。そのキーの処理がすべて終わったら解決する（失敗しても reject しない） */
  run(key: string): Promise<void> {
    if (this.running.has(key)) {
      this.pending.add(key);
      return this.idle(key);
    }
    const p = this.task(key)
      .catch(() => undefined)
      .finally(() => {
        this.running.delete(key);
        if (this.pending.delete(key)) void this.run(key);
      });
    this.running.set(key, p);
    return this.idle(key);
  }

  /** そのキーの処理（再実行を含む）がすべて終わるまで待つ */
  async idle(key: string): Promise<void> {
    for (let p = this.running.get(key); p; p = this.running.get(key)) await p;
  }
}
