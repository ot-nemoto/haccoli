import { fileURLToPath } from "node:url";
import { App, Tags } from "aws-cdk-lib";
import { loadConfig } from "../lib/config.js";
import { HaccoliStack } from "../lib/haccoli-stack.js";

const app = new App();
const config = loadConfig((key) => app.node.tryGetContext(key));

const stack = new HaccoliStack(app, `Haccoli-${config.envName}`, {
  config,
  webDistDir: fileURLToPath(new URL("../../web/dist", import.meta.url)),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // CDK CLI が注入する既定リージョン（未設定時は us-east-1）に左右されないよう明示する
    region: process.env.HACCOLI_REGION ?? "ap-northeast-1",
  },
});

Tags.of(stack).add("app", "haccoli");
Tags.of(stack).add("env", config.envName);
