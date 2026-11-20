import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { Api } from "./api.js";
import { Auth } from "./auth.js";
import type { EnvConfig } from "./config.js";
import { Data } from "./data.js";
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
    });
    const web = new Web(this, "Web", {
      distDir: props.webDistDir,
      connectSources: [`https://cognito-idp.${this.region}.amazonaws.com`],
      apiOriginDomain: api.originDomain,
      runtimeConfig: {
        region: this.region,
        userPoolId: auth.userPool.userPoolId,
        userPoolClientId: auth.webClient.userPoolClientId,
      },
    });

    new CfnOutput(this, "UserPoolId", { value: auth.userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: auth.webClient.userPoolClientId });
    new CfnOutput(this, "TableName", { value: data.table.tableName });
    new CfnOutput(this, "ApiFunctionName", { value: api.handler.functionName });
    new CfnOutput(this, "WebUrl", { value: `https://${web.distribution.distributionDomainName}` });
  }
}
