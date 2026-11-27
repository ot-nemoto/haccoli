import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { UserDeps } from "@haccoli/core";

export type EnvName = "dev" | "prod";

export interface StackOutputs {
  UserPoolId: string;
  UserPoolClientId: string;
  TableName: string;
  WebUrl: string;
  SubmissionsBucket: string;
}

export interface Context {
  env: EnvName;
  region: string;
  outputs: StackOutputs;
  deps: UserDeps;
  s3: S3Client;
}

/**
 * デプロイ済みスタックの出力（User Pool ID 等）を取得して AWS クライアントを組み立てる。
 * 認証情報は通常の AWS SDK の解決順（AWS_PROFILE / SSO / 環境変数）に従う。
 */
export async function createContext(env: string): Promise<Context> {
  if (env !== "dev" && env !== "prod") {
    throw new Error(`--env は dev または prod を指定してください: ${env}`);
  }
  // CDK 側（packages/infra/bin/app.ts）と同じ解決方法にそろえる
  const region = process.env.HACCOLI_REGION ?? "ap-northeast-1";
  const stackName = `Haccoli-${env}`;

  const cfn = new CloudFormationClient({ region });
  const res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const raw = Object.fromEntries(
    (res.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey ?? "", o.OutputValue ?? ""]),
  );
  for (const key of [
    "UserPoolId",
    "UserPoolClientId",
    "TableName",
    "WebUrl",
    "SubmissionsBucket",
  ] as const) {
    if (!raw[key]) throw new Error(`スタック ${stackName} に出力 ${key} がありません`);
  }
  const outputs = raw as unknown as StackOutputs;

  return {
    env,
    region,
    outputs,
    deps: {
      cognito: new CognitoIdentityProviderClient({ region }),
      ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region })),
      userPoolId: outputs.UserPoolId,
      tableName: outputs.TableName,
    },
    s3: new S3Client({ region }),
  };
}
