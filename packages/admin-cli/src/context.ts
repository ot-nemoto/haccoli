import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { AuditedUserDeps } from "@haccoli/core";

export type EnvName = "dev" | "prod";

export interface StackOutputs {
  UserPoolId: string;
  UserPoolClientId: string;
  TableName: string;
  AuditTableName: string;
  WebUrl: string;
  SubmissionsBucket: string;
}

export interface Context {
  env: EnvName;
  region: string;
  outputs: StackOutputs;
  /** 変更操作は監査ログに記録する。実行者は CLI を実行した IAM のプリンシパル（docs/design.md §14.4） */
  deps: AuditedUserDeps;
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
    "AuditTableName",
    "WebUrl",
    "SubmissionsBucket",
  ] as const) {
    if (!raw[key]) {
      // 新しい出力（例: Step 7-2 の AuditTableName）を CLI が先に使うと起きる
      throw new Error(
        `スタック ${stackName} に出力 ${key} がありません。CLI より古いスタックの可能性があります。先に ${env} にデプロイしてください`,
      );
    }
  }
  const outputs = raw as unknown as StackOutputs;

  const identity = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
  if (!identity.Arn) throw new Error("実行者（IAM のプリンシパル）を取得できませんでした");

  return {
    env,
    region,
    outputs,
    deps: {
      cognito: new CognitoIdentityProviderClient({ region }),
      ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region })),
      userPoolId: outputs.UserPoolId,
      tableName: outputs.TableName,
      auditTableName: outputs.AuditTableName,
      actor: { type: "iam", arn: identity.Arn },
    },
    s3: new S3Client({ region }),
  };
}
