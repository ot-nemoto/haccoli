import { fileURLToPath } from "node:url";
import {
  aws_apigatewayv2 as apigw,
  aws_apigatewayv2_authorizers as authorizers,
  type aws_cognito as cognito,
  Duration,
  type aws_dynamodb as dynamodb,
  aws_apigatewayv2_integrations as integrations,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_lambda_nodejs as nodejs,
  RemovalPolicy,
  Stack,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvConfig } from "./config.js";

export interface ApiProps {
  config: EnvConfig;
  userPool: cognito.IUserPool;
  webClient: cognito.IUserPoolClient;
  table: dynamodb.ITableV2;
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * API Gateway HTTP API + Lambda（Hono）。docs/design.md §3 / §7
 * CloudFront の /api/* から転送する（SPA と同一オリジンにして CORS を不要にする）。
 */
export class Api extends Construct {
  readonly httpApi: apigw.HttpApi;
  readonly handler: nodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, "HandlerLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.handler = new nodejs.NodejsFunction(this, "Handler", {
      entry: `${repoRoot}packages/api/src/lambda.ts`,
      projectRoot: repoRoot,
      depsLockFilePath: `${repoRoot}package-lock.json`,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(10),
      logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      environment: { TABLE_NAME: props.table.tableName },
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: "node24",
        minify: true,
        sourceMap: true,
        // ESM バンドル内で require を使う依存に備える
        banner:
          "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    });
    this.handler.addEnvironment("NODE_OPTIONS", "--enable-source-maps");
    // Step 2 は参照のみ。書き込みが必要になった時点で grantReadWriteData に切り替える
    props.table.grantReadData(this.handler);

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

    // 想定トラフィック（数十〜数百名）に対して十分な上限。暴走・濫用時のコスト上限を兼ねる
    const stage = this.httpApi.defaultStage?.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 20, throttlingBurstLimit: 40 };
  }

  /** CloudFront のオリジンに指定するドメイン */
  get originDomain(): string {
    // apiEndpoint はトークンのため文字列操作できない。ドメインを組み立てる
    const stack = Stack.of(this);
    return `${this.httpApi.apiId}.execute-api.${stack.region}.${stack.urlSuffix}`;
  }
}
