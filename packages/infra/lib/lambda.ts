import { fileURLToPath } from "node:url";
import {
  type Duration,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_lambda_nodejs as nodejs,
  RemovalPolicy,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * packages/api の Lambda 関数を作る共通設定。
 * AWS SDK もバンドルに含める（ランタイム同梱の版ではなくロックファイルの版で動かす。
 * s3-presigned-post 等、ランタイムに含まれない可能性のあるパッケージにも対応するため）。
 */
export function apiFunction(
  scope: Construct,
  id: string,
  props: {
    entry: string;
    environment: Record<string, string>;
    memorySize: number;
    timeout: Duration;
  },
): nodejs.NodejsFunction {
  const logGroup = new logs.LogGroup(scope, `${id}Logs`, {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY,
  });
  const fn = new nodejs.NodejsFunction(scope, id, {
    entry: `${repoRoot}packages/api/src/${props.entry}`,
    projectRoot: repoRoot,
    depsLockFilePath: `${repoRoot}package-lock.json`,
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize: props.memorySize,
    timeout: props.timeout,
    logGroup,
    loggingFormat: lambda.LoggingFormat.JSON,
    environment: { ...props.environment, NODE_OPTIONS: "--enable-source-maps" },
    bundling: {
      format: nodejs.OutputFormat.ESM,
      target: "node24",
      minify: true,
      sourceMap: true,
      externalModules: [],
      // ESM バンドル内で require を使う依存に備える
      banner:
        "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    },
  });
  return fn;
}
