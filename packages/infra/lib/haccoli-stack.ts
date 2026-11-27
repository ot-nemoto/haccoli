import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { Api } from "./api.js";
import { Auth } from "./auth.js";
import type { EnvConfig } from "./config.js";
import { Data } from "./data.js";
import { Monitoring } from "./monitoring.js";
import { Storage, submissionsBucketName } from "./storage.js";
import { Web } from "./web.js";

export interface HaccoliStackProps extends StackProps {
  config: EnvConfig;
  webDistDir: string;
}

/**
 * MVP は 1 環境 1 スタック（スタック間参照の煩雑さを避ける）。
 * 出力名は admin-cli が参照するため変更しないこと。
 */
export class HaccoliStack extends Stack {
  constructor(scope: Construct, id: string, props: HaccoliStackProps) {
    super(scope, id, props);

    const auth = new Auth(this, "Auth", props.config);
    const data = new Data(this, "Data", props.config);
    const api = new Api(this, "Api", {
      config: props.config,
      userPool: auth.userPool,
      webClient: auth.webClient,
      table: data.table,
      auditTable: data.auditTable,
      submissionsBucketName: submissionsBucketName(this, props.config.envName),
    });
    const web = new Web(this, "Web", {
      distDir: props.webDistDir,
      connectSources: [
        `https://cognito-idp.${this.region}.amazonaws.com`,
        // 提出ファイルはブラウザから S3 へ直接アップロードする
        Storage.endpoint(this, props.config.envName),
      ],
      apiOriginDomain: api.originDomain,
      runtimeConfig: {
        region: this.region,
        userPoolId: auth.userPool.userPoolId,
        userPoolClientId: auth.webClient.userPoolClientId,
      },
    });

    const webOrigin = `https://${web.distribution.distributionDomainName}`;
    const storage = new Storage(this, "Storage", {
      config: props.config,
      // dev はローカル開発（vite）からのアップロードも許可する
      allowedOrigins:
        props.config.envName === "dev" ? [webOrigin, "http://localhost:5173"] : [webOrigin],
    });

    // 監視は prod のみ（dev は CloudWatch Logs で確認する。docs/design.md §10）
    if (props.config.envName === "prod") {
      if (!props.config.alarmEmail) throw new Error("prod には alarmEmail が必要です");
      new Monitoring(this, "Monitoring", {
        envName: props.config.envName,
        alarmEmail: props.config.alarmEmail,
        httpApi: api.httpApi,
        apiFunction: api.handler,
        adminFunction: api.adminHandler,
      });
    }

    new CfnOutput(this, "UserPoolId", { value: auth.userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: auth.webClient.userPoolClientId });
    new CfnOutput(this, "TableName", { value: data.table.tableName });
    new CfnOutput(this, "AuditTableName", { value: data.auditTable.tableName });
    new CfnOutput(this, "ApiFunctionName", { value: api.handler.functionName });
    new CfnOutput(this, "AdminApiFunctionName", { value: api.adminHandler.functionName });
    new CfnOutput(this, "ExpireFunctionName", { value: api.expireFunction.functionName });
    new CfnOutput(this, "SubmissionsBucket", { value: storage.submissions.bucketName });
    new CfnOutput(this, "WebUrl", { value: webOrigin });
  }
}
