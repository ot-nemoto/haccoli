import { CfnOutput, aws_iam as iam, Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { EnvName } from "./config.js";

const GITHUB_OIDC_URL = "https://token.actions.githubusercontent.com";

export interface CiStackProps extends StackProps {
  envName: EnvName;
  /** owner/repo */
  githubRepo: string;
  /** 既にアカウントに GitHub の OIDC プロバイダがある場合はその ARN（1 アカウントに 1 つしか作れない） */
  existingOidcProviderArn?: string;
}

/**
 * GitHub Actions からのデプロイ用 IAM ロール（OIDC）。アクセスキーを GitHub に置かない。
 * 管理者がローカルから環境ごとに 1 回だけデプロイする。
 */
export class CiStack extends Stack {
  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, props);

    const provider = props.existingOidcProviderArn
      ? iam.OidcProviderNative.fromOidcProviderArn(
          this,
          "GithubOidc",
          props.existingOidcProviderArn,
        )
      : new iam.OidcProviderNative(this, "GithubOidc", {
          url: GITHUB_OIDC_URL,
          clientIds: ["sts.amazonaws.com"],
        });

    const role = new iam.Role(this, "DeployRole", {
      roleName: `haccoli-github-deploy-${props.envName}`,
      description: `GitHub Actions deploy role for haccoli ${props.envName}`,
      // GitHub の Environment（dev / prod）単位で信頼する。ブランチ制限は GitHub 側の Environment 設定で行う
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": `repo:${props.githubRepo}:environment:${props.envName}`,
        },
      }),
    });

    // 実際のリソース操作は cdk bootstrap が作成したロールに委譲する（最小権限）
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-*`],
      }),
    );

    new CfnOutput(this, "DeployRoleArn", { value: role.roleArn });
  }
}
