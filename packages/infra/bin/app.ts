import { fileURLToPath } from "node:url";
import { App, Tags } from "aws-cdk-lib";
import { CiStack } from "../lib/ci-stack.js";
import { loadConfig, loadEnvName } from "../lib/config.js";
import { HaccoliStack } from "../lib/haccoli-stack.js";

const app = new App();
const ctx = (key: string) => app.node.tryGetContext(key);
const envName = loadEnvName(ctx);

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  // CDK CLI が注入する既定リージョン（未設定時は us-east-1）に左右されないよう明示する
  region: process.env.HACCOLI_REGION ?? "ap-northeast-1",
};

let stack: HaccoliStack | CiStack;
if (ctx("ci") === "true" || ctx("ci") === true) {
  // GitHub Actions 用デプロイロール（-c ci=true のときのみ。初回に管理者が手動デプロイ）
  stack = new CiStack(app, `Haccoli-ci-${envName}`, {
    env,
    envName,
    // 従来形式と immutable subject 形式（リポジトリ設定で有効）の両方を許可する
    subjectPrefixes: [
      `repo:${(ctx("githubRepo") as string | undefined) ?? "ot-nemoto/haccoli"}`,
      (ctx("githubSubjectPrefix") as string | undefined) ??
        "repo:ot-nemoto@41175383/haccoli@1464083865",
    ],
    existingOidcProviderArn: ctx("oidcProviderArn") as string | undefined,
  });
} else {
  const config = loadConfig(ctx);
  stack = new HaccoliStack(app, `Haccoli-${config.envName}`, {
    env,
    config,
    webDistDir: fileURLToPath(new URL("../../web/dist", import.meta.url)),
  });
}

Tags.of(stack).add("app", "haccoli");
Tags.of(stack).add("env", envName);
