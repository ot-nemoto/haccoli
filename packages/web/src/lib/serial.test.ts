import { describe, expect, it, vi } from "vitest";
import { SerialRunner } from "./serial.js";

/** 外から完了させられる処理 */
function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("SerialRunner", () => {
  it("実行中の要求は、実行中の処理と再実行の両方が終わるまで解決しない（#19）", async () => {
    const calls: ReturnType<typeof deferred>[] = [];
    const runner = new SerialRunner(() => {
      const d = deferred();
      calls.push(d);
      return d.promise;
    });

    // 自動保存などで 1 回目が通信中
    const first = runner.run("q1");
    // 提出の直前の「すべて保存」
    let done = false;
    const second = runner.run("q1").then(() => {
      done = true;
    });
    await tick();
    expect(calls).toHaveLength(1);

    calls[0]?.resolve();
    await tick();
    // 1 回目が終わっても、まとめた再実行が終わるまでは待つ
    expect(calls).toHaveLength(2);
    expect(done).toBe(false);

    calls[1]?.resolve();
    await Promise.all([first, second]);
    expect(done).toBe(true);
  });

  it("実行中の複数の要求は、再実行 1 回にまとめる", async () => {
    const calls: ReturnType<typeof deferred>[] = [];
    const runner = new SerialRunner(() => {
      const d = deferred();
      calls.push(d);
      return d.promise;
    });
    const all = [runner.run("q1"), runner.run("q1"), runner.run("q1")];
    await tick();
    calls[0]?.resolve();
    await tick();
    calls[1]?.resolve();
    await Promise.all(all);
    expect(calls).toHaveLength(2);
  });

  it("キーが違えば並行して実行する", async () => {
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const runner = new SerialRunner((key) => {
      started.push(key);
      const d = deferred();
      gates.set(key, d);
      return d.promise;
    });
    const a = runner.run("q1");
    const b = runner.run("q2");
    await tick();
    expect(started).toEqual(["q1", "q2"]);
    gates.get("q1")?.resolve();
    gates.get("q2")?.resolve();
    await Promise.all([a, b]);
  });

  it("処理が失敗しても（同期的な例外を含む）reject せず記録し、次の要求を実行できる", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let n = 0;
    const runner = new SerialRunner((): Promise<void> => {
      n += 1;
      if (n === 1) throw new Error("sync");
      if (n === 2) return Promise.reject(new Error("network"));
      return Promise.resolve();
    });
    await expect(runner.run("q1")).resolves.toBeUndefined();
    await expect(runner.run("q1")).resolves.toBeUndefined();
    await runner.run("q1");
    expect(n).toBe(3);
    expect(logged).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });

  it("idle は処理がなければすぐ解決する", async () => {
    const runner = new SerialRunner(async () => undefined);
    await expect(runner.idle("q1")).resolves.toBeUndefined();
  });
});
