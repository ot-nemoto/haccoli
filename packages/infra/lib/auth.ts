import { aws_cognito as cognito, Duration, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvConfig } from "./config.js";

export const USER_GROUPS = ["candidate", "grader"] as const;

/**
 * Cognito User Pool（Email OTP によるパスワードレス認証）。docs/design.md §4
 */
export class Auth extends Construct {
  readonly userPool: cognito.UserPool;
  readonly webClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, config: EnvConfig) {
    super(scope, id);

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `haccoli-${config.envName}`,
      // Email OTP（パスワードレス）は Essentials 以上の機能プランが必要
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: false },
        fullname: { required: true, mutable: true },
      },
      // パスワード要素は Cognito の仕様上無効化できない。登録時に誰にも知らせない
      // ランダム値を設定し（core/users.ts）、アプリクライアントは USER_AUTH フローのみ許可する
      signInPolicy: {
        allowedFirstAuthFactors: { password: true, emailOtp: true },
      },
      accountRecovery: cognito.AccountRecovery.NONE,
      mfa: cognito.Mfa.OFF,
      // Email OTP には SES 経由の送信（DEVELOPER）が必須
      email: cognito.UserPoolEmail.withSES({
        fromEmail: config.fromEmail,
        fromName: config.fromName,
        sesRegion: Stack.of(this).region,
        sesVerifiedDomain: config.sesVerifiedDomain,
      }),
      deletionProtection: config.envName === "prod",
      removalPolicy: config.removalPolicy,
    });

    for (const group of USER_GROUPS) {
      new cognito.CfnUserPoolGroup(this, `Group-${group}`, {
        userPoolId: this.userPool.userPoolId,
        groupName: group,
      });
    }

    this.webClient = this.userPool.addClient("WebClient", {
      userPoolClientName: "web",
      generateSecret: false,
      // 選択型認証（USER_AUTH）のみ。USER_PASSWORD_AUTH / SRP は許可しない
      authFlows: { user: true },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
      // 「再ログインの度に OTP」を担保するため最短に。SPA はリフレッシュしない
      refreshTokenValidity: Duration.minutes(60),
      readAttributes: new cognito.ClientAttributes().withStandardAttributes({
        email: true,
        emailVerified: true,
        fullname: true,
      }),
      writeAttributes: new cognito.ClientAttributes(),
    });
  }
}
