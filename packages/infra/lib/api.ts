import {
  aws_apigatewayv2 as apigw,
  aws_apigatewayv2_authorizers as authorizers,
  type aws_cognito as cognito,
  Duration,
  type aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_apigatewayv2_integrations as integrations,
  type aws_lambda_nodejs as nodejs,
  Stack,
  aws_scheduler as scheduler,
  aws_scheduler_targets as targets,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvConfig } from "./config.js";
import { apiFunction } from "./lambda.js";

export interface ApiProps {
  config: EnvConfig;
  userPool: cognito.IUserPool;
  webClient: cognito.IUserPoolClient;
  table: dynamodb.ITableV2;
  /** 監査ログのテーブル（管理者 API の Lambda だけが書き込む。docs/design.md §14.4） */
  auditTable: dynamodb.ITableV2;
  /** 提出ファイルのバケット名（CloudFront との循環参照を避けるため名前で受け取る） */
  submissionsBucketName: string;
}

/**
 * API Gateway HTTP API + Lambda（Hono）。docs/design.md §3 / §7
 * CloudFront の /api/* から転送する（SPA と同一オリジンにして CORS を不要にする）。
 */
export class Api extends Construct {
  readonly httpApi: apigw.HttpApi;
  readonly handler: nodejs.NodejsFunction;
  /** 管理者 API（/api/admin/*）の Lambda（docs/design.md §14.3） */
  readonly adminHandler: nodejs.NodejsFunction;
  readonly expireFunction: nodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

    this.handler = apiFunction(this, "Handler", {
      entry: "lambda.ts",
      environment: {
        TABLE_NAME: props.table.tableName,
        SUBMISSIONS_BUCKET: props.submissionsBucketName,
      },
      // 提出ファイル（最大 20MB）の SHA-256 計算のため、CPU・ネットワーク帯域に余裕を持たせる
      memorySize: 1024,
      // HTTP API の統合タイムアウト（30 秒）未満にする
      timeout: Duration.seconds(25),
    });
    // 最小権限: 使う操作だけを付与し、機能追加に合わせて増やす。
    // Scan・DeleteItem・BatchGet は付与しない（API から全件を読めないようにする）。
    // Cognito のユーザー管理・監査ログのテーブルの権限も与えない（管理者 API の Lambda だけが持つ）
    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:ConditionCheckItem",
        ],
        resources: [props.table.tableArn, `${props.table.tableArn}/index/GSI1`],
      }),
    );
    // 提出ファイル: 署名付き POST の発行（PutObject）、検証（GetObject）、差し替え時の削除
    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
        resources: [
          `arn:${Stack.of(this).partition}:s3:::${props.submissionsBucketName}/attempts/*`,
        ],
      }),
    );

    // 管理者 API（§14.3・§14.6）。候補者・採点者の API とは別の Lambda にし、
    // 管理の権限（Cognito のユーザー管理・Scan・監査ログの書き込み）はこの Lambda だけに与える
    this.adminHandler = apiFunction(this, "AdminHandler", {
      entry: "admin-lambda.ts",
      environment: {
        TABLE_NAME: props.table.tableName,
        AUDIT_TABLE_NAME: props.auditTable.tableName,
        USER_POOL_ID: props.userPool.userPoolId,
      },
      memorySize: 512,
      timeout: Duration.seconds(25),
    });
    // 業務データ: 利用者の一覧（Scan）・登録（PutItem）・ロールと無効化の更新（UpdateItem）、
    // 最後の管理者の確認（ConditionCheckItem。トランザクション）、メールアドレスでの検索（GSI1）。
    // 状態ごとの受験の一覧（GSI2）は Step 8 で追加する。DeleteItem は与えない
    this.adminHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:ConditionCheckItem",
        ],
        resources: [props.table.tableArn, `${props.table.tableArn}/index/GSI1`],
      }),
    );
    // 監査ログ: 記録（PutItem・UpdateItem）と一覧（Query）のみ。削除させない（§14.4）
    this.adminHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
        resources: [props.auditTable.tableArn],
      }),
    );
    // Cognito: 登録（作成・パスワード設定・作成の巻き戻し）、ロールのグループ、無効化
    this.adminHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminSetUserPassword",
          "cognito-idp:AdminDeleteUser",
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminRemoveUserFromGroup",
          "cognito-idp:AdminDisableUser",
        ],
        resources: [props.userPool.userPoolArn],
      }),
    );

    // 期限処理バッチ（§6.4）。1 時間毎に期限切れの受験を EXPIRED にする
    const expire = apiFunction(this, "Expire", {
      entry: "expire.ts",
      environment: { TABLE_NAME: props.table.tableName },
      memorySize: 256,
      timeout: Duration.minutes(5),
    });
    expire.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query", "dynamodb:UpdateItem"],
        resources: [props.table.tableArn, `${props.table.tableArn}/index/GSI2`],
      }),
    );
    this.expireFunction = expire;
    new scheduler.Schedule(this, "ExpireSchedule", {
      description: "haccoli: expire attempts past deadline",
      schedule: scheduler.ScheduleExpression.rate(Duration.hours(1)),
      target: new targets.LambdaInvoke(expire, { retryAttempts: 2 }),
    });

    // 署名・有効期限・client_id（アクセストークン）/ aud（ID トークン）を検証する。
    // トークン種別（アクセストークンのみ許可）は Lambda 側で確認する
    const authorizer = new authorizers.HttpUserPoolAuthorizer("Authorizer", props.userPool, {
      userPoolClients: [props.webClient],
    });

    this.httpApi = new apigw.HttpApi(this, "HttpApi", {
      apiName: `haccoli-${props.config.envName}`,
      description: "haccoli API (called via CloudFront /api/*)",
    });
    this.httpApi.addRoutes({
      path: "/api/{proxy+}",
      methods: [apigw.HttpMethod.ANY],
      integration: new integrations.HttpLambdaIntegration("Lambda", this.handler),
      authorizer,
    });
    // より具体的なルートが優先されるため、/api/admin/* だけが管理者 API の Lambda に来る
    this.httpApi.addRoutes({
      path: "/api/admin/{proxy+}",
      methods: [apigw.HttpMethod.ANY],
      integration: new integrations.HttpLambdaIntegration("AdminLambda", this.adminHandler),
      authorizer,
    });

    // ステージ全体（全利用者共有）の上限。低すぎると未認証リクエストの連打だけで正規利用者まで
    // 429 になる（DoS の増幅）ため、暴走時のコスト上限として十分高くする。
    // 送信元 IP 単位の制限は WAF のレートベースルールで行う（docs/design.md §10）
    const stage = this.httpApi.defaultStage?.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 200, throttlingBurstLimit: 400 };
  }

  /** CloudFront のオリジンに指定するドメイン */
  get originDomain(): string {
    // apiEndpoint はトークンのため文字列操作できない。ドメインを組み立てる
    const stack = Stack.of(this);
    return `${this.httpApi.apiId}.execute-api.${stack.region}.${stack.urlSuffix}`;
  }
}
