import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { disableUser, listUsers, type Role, registerUser } from "@haccoli/core";
import { Command } from "commander";
import { confirmIfProd } from "./confirm.js";
import { createContext } from "./context.js";
import { addExamCommands } from "./exams.js";

const program = new Command()
  .name("haccoli-admin")
  .description("採用課題システム 管理 CLI")
  .requiredOption("-e, --env <env>", "対象環境 (dev | prod)")
  .option("-y, --yes", "prod 環境での確認を省略する", false);

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
