import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addRole,
  disableUser,
  executePurge,
  findUserByEmail,
  listUsers,
  migrateRoles,
  planPurge,
  type Role,
  registerUser,
  removeRole,
  s3FileVersionStore,
} from "@haccoli/core";
import { Command } from "commander";
import { addAuditCommands } from "./audit.js";
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

/** 画面のあるロールのログイン URL。管理画面は Step 8 で追加する（docs/design.md §14.7） */
const LOGIN_PATHS: Partial<Record<Role, string>> = {
  candidate: "/login",
  grader: "/grader/login",
};

function addUserCommands(role: Role, label: string) {
  const staff = role !== "candidate";
  program
    .command(`${role}:add`)
    .description(
      staff
        ? `${label}を登録する。登録済みの採点者・管理者なら${label}のロールを付与する`
        : `${label}を登録する（Cognito ユーザー作成 + グループ付与）`,
    )
    .requiredOption("--email <email>", "メールアドレス")
    .option("--name <name>", "氏名（新規登録のとき必須）")
    .action(async (opts: { email: string; name?: string }) => {
      const ctx = await createContext(globals().env);
      const existing = staff ? await findUserByEmail(ctx.deps, opts.email) : undefined;
      if (existing) {
        if (existing.disabled) {
          throw new Error(`無効化された利用者です: ${existing.email}`);
        }
        if (opts.name) console.log("登録済みのため --name は使いません（氏名は変わりません）。");
        await confirmIfProd(
          ctx,
          `${existing.name} <${existing.email}>（${existing.roles.join(", ")}）に${label}のロールを付与します。`,
          globals().yes,
        );
        const user = await addRole(ctx.deps, { email: existing.email, role });
        console.log(`付与しました: ${user.name} <${user.email}>（${user.roles.join(", ")}）`);
        console.log("次にログインしたときから有効になります。");
      } else {
        if (!opts.name) throw new Error("新規登録には --name が必要です");
        await confirmIfProd(ctx, `${label} ${opts.email} を登録します。`, globals().yes);
        const user = await registerUser(ctx.deps, {
          email: opts.email,
          name: opts.name,
          roles: [role],
        });
        console.log(`登録しました: ${user.name} <${user.email}> (sub: ${user.sub})`);
      }
      const loginPath = LOGIN_PATHS[role];
      if (loginPath) console.log(`ログイン URL: ${ctx.outputs.WebUrl}${loginPath}`);
      else console.log("管理画面は準備中です（Step 8）。");
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
          roles: u.roles.join(", "),
          disabled: u.disabled,
          createdAt: u.createdAt,
        })),
      );
    });

  program
    .command(`${role}:disable`)
    .description(`${label}を無効化する（ログイン不可にする。ほかのロールも含めて使えなくなる）`)
    .requiredOption("--email <email>", "メールアドレス")
    .action(async (opts: { email: string }) => {
      const ctx = await createContext(globals().env);
      await confirmIfProd(ctx, `${opts.email} を無効化します。`, globals().yes);
      const user = await disableUser(ctx.deps, { email: opts.email });
      console.log(`無効化しました: ${user.name} <${user.email}>`);
    });

  if (staff) {
    program
      .command(`${role}:remove`)
      .description(`${label}のロールを外す（最後のロールは外せない。利用を止めるなら無効化する）`)
      .requiredOption("--email <email>", "メールアドレス")
      .action(async (opts: { email: string }) => {
        const ctx = await createContext(globals().env);
        await confirmIfProd(ctx, `${opts.email} から${label}のロールを外します。`, globals().yes);
        const user = await removeRole(ctx.deps, { email: opts.email, role });
        console.log(`外しました: ${user.name} <${user.email}>（${user.roles.join(", ")}）`);
      });
  }
}

addUserCommands("candidate", "候補者");
addUserCommands("grader", "採点者");
addUserCommands("admin", "管理者");

program
  .command("user:migrate-roles")
  .description(
    "利用者のロールを複数ロールの形式（roles）に移行する（Step 7 で 1 回。何度実行してもよい）",
  )
  .action(async () => {
    const ctx = await createContext(globals().env);
    await confirmIfProd(ctx, "利用者のロールを roles に移行します。", globals().yes);
    const res = await migrateRoles(ctx.deps);
    console.log(`移行しました: ${res.migrated} 件（対象外・変更済み: ${res.skipped} 件）`);
  });

addExamCommands(program, globals);
addGradingCommands(program, globals);
addAuditCommands(program, globals);

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
