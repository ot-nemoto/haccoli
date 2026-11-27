import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  disableUser,
  executePurge,
  listUsers,
  planPurge,
  type Role,
  registerUser,
  s3FileVersionStore,
} from "@haccoli/core";
import { Command } from "commander";
import { confirmAlways, confirmIfProd } from "./confirm.js";
import { createContext } from "./context.js";
import { addExamCommands } from "./exams.js";
import { addGradingCommands } from "./grading.js";

const program = new Command()
  .name("haccoli-admin")
  .description("採用課題システム 管理 CLI")
  .requiredOption("-e, --env <env>", "対象環境 (dev | prod)")
  .option("-y, --yes", "確認を省略する（prod の変更操作と user:purge）", false);

const globals = () => program.opts<{ env: string; yes: boolean }>();

function addUserCommands(role: Role, label: string) {
  program
    .command(`${role}:add`)
    .description(`${label}を登録する（Cognito ユーザー作成 + グループ付与）`)
    .requiredOption("--email <email>", "メールアドレス")
    .requiredOption("--name <name>", "氏名")
    .action(async (opts: { email: string; name: string }) => {
      const ctx = await createContext(globals().env);
      await confirmIfProd(ctx, `${label} ${opts.email} を登録します。`, globals().yes);
      const user = await registerUser(ctx.deps, { email: opts.email, name: opts.name, role });
      console.log(`登録しました: ${user.name} <${user.email}> (sub: ${user.sub})`);
      if (role === "candidate") {
        console.log(`ログイン URL: ${ctx.outputs.WebUrl}/login`);
      } else {
        console.log(`ログイン URL: ${ctx.outputs.WebUrl}/grader/login`);
      }
    });

  program
    .command(`${role}:list`)
    .description(`${label}の一覧`)
    .action(async () => {
      const ctx = await createContext(globals().env);
      const users = await listUsers(ctx.deps, role);
      console.table(
        users.map((u) => ({
          name: u.name,
          email: u.email,
          disabled: u.disabled,
          createdAt: u.createdAt,
        })),
      );
    });

  program
    .command(`${role}:disable`)
    .description(`${label}を無効化する（ログイン不可にする）`)
    .requiredOption("--email <email>", "メールアドレス")
    .action(async (opts: { email: string }) => {
      const ctx = await createContext(globals().env);
      await confirmIfProd(ctx, `${opts.email} を無効化します。`, globals().yes);
      const user = await disableUser(ctx.deps, opts.email);
      console.log(`無効化しました: ${user.name} <${user.email}>`);
    });
}

addUserCommands("candidate", "候補者");
addUserCommands("grader", "採点者");
addExamCommands(program, globals);
addGradingCommands(program, globals);

program
  .command("user:purge")
  .description(
    "候補者の個人データを削除する（Cognito・DynamoDB・S3 の提出ファイル全バージョン。元に戻せない）",
  )
  .requiredOption("--email <email>", "候補者のメールアドレス")
  .action(async (opts: { email: string }) => {
    const ctx = await createContext(globals().env);
    const deps = {
      ...ctx.deps,
      fileVersions: s3FileVersionStore(ctx.s3, ctx.outputs.SubmissionsBucket),
    };
    const plan = await planPurge(deps, opts.email);
    console.log(`削除対象: ${plan.user.name} <${plan.user.email}> (sub: ${plan.user.sub})`);
    if (plan.attempts.length === 0) {
      console.log("  受験: なし");
    } else {
      console.table(
        plan.attempts.map((t) => ({
          attemptId: t.attempt.attemptId,
          exam: `${t.attempt.examId} v${t.attempt.examVersion}`,
          status: t.status,
          items: t.itemCount,
          fileVersions: t.fileVersionCount,
        })),
      );
    }
    console.log("Cognito のユーザーと User プロフィールも削除します。");
    console.log("出力済みの CSV など、手元に保存したファイルは削除されません。");
    await confirmAlways(ctx, "上記を削除します。元に戻せません。", globals().yes);
    await executePurge(deps, plan);
    console.log(`削除しました: ${plan.user.email}（受験 ${plan.attempts.length} 件）`);
  });

program
  .command("web:config")
  .description("ローカル開発用に packages/web/public/config.json を生成する")
  .action(async () => {
    const ctx = await createContext(globals().env);
    const out = fileURLToPath(new URL("../../web/public/config.json", import.meta.url));
    mkdirSync(dirname(out), { recursive: true });
    const config = {
      region: ctx.region,
      userPoolId: ctx.outputs.UserPoolId,
      userPoolClientId: ctx.outputs.UserPoolClientId,
    };
    writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`書き出しました: ${out}`);
  });

program.parseAsync().catch((e: unknown) => {
  console.error(`エラー: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
