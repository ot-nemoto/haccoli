import { resolve } from "node:path";
import {
  effectiveStatus,
  issueAttempt,
  listAttempts,
  listExams,
  loadExamDir,
  publishExam,
} from "@haccoli/core";
import { ATTEMPT_STATUS_LABELS, ATTEMPT_STATUSES, type AttemptStatus } from "@haccoli/shared";
import type { Command } from "commander";
import { confirmIfProd } from "./confirm.js";
import { createContext } from "./context.js";

type Globals = () => { env: string; yes: boolean };

/** npm run は各ワークスペースで実行されるため、相対パスは呼び出し元のディレクトリ基準で解決する */
const fromInvocationDir = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path);

/** JST で表示する */
const jst = (iso: string | undefined) =>
  iso ? new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false }) : "";

export function addExamCommands(program: Command, globals: Globals) {
  program
    .command("exam:publish")
    .description("課題定義を検証して投入する（新しい版を作成。内容が同じなら何もしない）")
    .requiredOption("--dir <dir>", "課題ディレクトリ（exams/<examId>）")
    .option("--dry-run", "検証のみ行い、投入しない", false)
    .action(async (opts: { dir: string; dryRun: boolean }) => {
      const def = await loadExamDir(fromInvocationDir(opts.dir));
      console.log(`検証 OK: ${def.examId}「${def.title}」 問題 ${def.questions.length} 問`);
      if (opts.dryRun) return;
      const ctx = await createContext(globals().env);
      await confirmIfProd(ctx, `課題 ${def.examId} を投入します。`, globals().yes);
      const result = await publishExam(ctx.deps, def);
      console.log(
        result.kind === "published"
          ? `投入しました: ${result.examId} v${result.version}`
          : `最新版（v${result.version}）と同じ内容のため、投入しませんでした`,
      );
    });

  program
    .command("exam:list")
    .description("課題と最新版の一覧")
    .action(async () => {
      const ctx = await createContext(globals().env);
      const exams = await listExams(ctx.deps);
      console.table(
        exams.map((e) => ({
          examId: e.examId,
          title: e.title,
          latestVersion: e.latestVersion,
          updatedAt: jst(e.updatedAt),
        })),
      );
    });

  program
    .command("attempt:issue")
    .description("候補者に受験を発行する（最新版の課題、期限 = 指定日 23:59 JST）")
    .requiredOption("--email <email>", "候補者のメールアドレス")
    .requiredOption("--exam <examId>", "課題 ID")
    .requiredOption("--deadline <YYYY-MM-DD>", "受験期限日")
    .option("--force", "当日を期限にすることを許可する", false)
    .action(async (opts: { email: string; exam: string; deadline: string; force: boolean }) => {
      const ctx = await createContext(globals().env);
      await confirmIfProd(
        ctx,
        `${opts.email} に ${opts.exam} を発行します（期限 ${opts.deadline}）。`,
        globals().yes,
      );
      const a = await issueAttempt(ctx.deps, {
        email: opts.email,
        examId: opts.exam,
        deadline: opts.deadline,
        force: opts.force,
      });
      console.log(`発行しました: ${a.attemptId}`);
      console.log(`  候補者: ${a.candidateName}`);
      console.log(`  課題:   ${a.examTitle}（${a.examId} v${a.examVersion}）`);
      console.log(`  期限:   ${jst(a.deadlineAt)}`);
      console.log(`ログイン URL: ${ctx.outputs.WebUrl}/login`);
    });

  program
    .command("attempt:list")
    .description("受験の一覧（期限切れはバッチ処理前でも EXPIRED と表示）")
    .option("--status <status>", `ステータスで絞り込む（${ATTEMPT_STATUSES.join(" / ")}）`)
    .action(async (opts: { status?: string }) => {
      if (opts.status && !(ATTEMPT_STATUSES as readonly string[]).includes(opts.status)) {
        throw new Error(`--status は ${ATTEMPT_STATUSES.join(" / ")} のいずれかです`);
      }
      const ctx = await createContext(globals().env);
      const now = new Date();
      const attempts = await listAttempts(ctx.deps, {
        status: opts.status as AttemptStatus | undefined,
      });
      console.table(
        attempts.map((a) => {
          const status = effectiveStatus(a, now);
          return {
            attemptId: a.attemptId,
            candidate: a.candidateName,
            exam: `${a.examId} v${a.examVersion}`,
            status: `${status}（${ATTEMPT_STATUS_LABELS[status]}）`,
            deadline: jst(a.deadlineAt),
            submittedAt: jst(a.submittedAt),
          };
        }),
      );
    });
}
