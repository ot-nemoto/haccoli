import { closeSync, fchmodSync, openSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { assignGraders, exportResultsCsv } from "@haccoli/core";
import type { Command } from "commander";
import { confirmIfProd } from "./confirm.js";
import { createContext } from "./context.js";

type Globals = () => { env: string; yes: boolean };

const fromInvocationDir = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path);

export function addGradingCommands(program: Command, globals: Globals) {
  program
    .command("attempt:assign")
    .description("受験に採点者を割り当てる（複数可。EXPIRED / CANCELED は不可）")
    .requiredOption("--attempt <attemptId>", "受験 ID")
    .requiredOption("--grader <email...>", "採点者のメールアドレス（複数指定可）")
    .action(async (opts: { attempt: string; grader: string[] }) => {
      const ctx = await createContext(globals().env);
      await confirmIfProd(
        ctx,
        `受験 ${opts.attempt} に ${opts.grader.join(", ")} を割り当てます。`,
        globals().yes,
      );
      const res = await assignGraders(ctx.deps, {
        attemptId: opts.attempt,
        graderEmails: opts.grader,
      });
      console.log(
        `受験: ${res.attempt.attemptId}（${res.attempt.candidateName}） ${res.attempt.status}`,
      );
      for (const g of res.assigned) console.log(`  割り当てました: ${g.name} <${g.email}>`);
      for (const g of res.skipped) console.log(`  割り当て済み:   ${g.name} <${g.email}>`);
      if (res.assigned.length > 0) console.log(`採点画面 URL: ${ctx.outputs.WebUrl}/grader/login`);
    });

  program
    .command("result:export")
    .description("採点結果を CSV に出力する（受験 × 採点者ごとに 1 行。問題ごとの点数・コメント）")
    .requiredOption("--exam <examId>", "課題 ID")
    .option("--out <file>", "出力先", "results.csv")
    .action(async (opts: { exam: string; out: string }) => {
      const ctx = await createContext(globals().env);
      const { csv, rows } = await exportResultsCsv(ctx.deps, opts.exam);
      const out = fromInvocationDir(opts.out);
      writePrivateFile(out, csv);
      console.log(`出力しました: ${out}（${rows} 行）`);
      console.log("候補者の個人情報を含みます。取り扱いに注意し、不要になったら削除してください。");
    });
}

/**
 * 個人情報を含むため所有者のみ読み書き可能にする。mode は新規作成時にしか効かないので、
 * 既存ファイルを上書きするときも、書き込む前に権限を 0600 に変える。
 */
function writePrivateFile(path: string, content: string): void {
  const fd = openSync(path, "w", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}
