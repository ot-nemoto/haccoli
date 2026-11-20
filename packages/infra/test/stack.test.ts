import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, aws_cloudfront as cloudfront, RemovalPolicy } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { HaccoliStack } from "../lib/haccoli-stack.js";
import { SPA_REWRITE } from "../lib/web.js";

let template: Template;

beforeAll(() => {
  const distDir = mkdtempSync(join(tmpdir(), "haccoli-web-"));
  writeFileSync(join(distDir, "index.html"), "<!doctype html>");
  const app = new App();
  const stack = new HaccoliStack(app, "Haccoli-test", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    webDistDir: distDir,
    config: {
      envName: "dev",
      fromEmail: "ci@example.com",
      fromName: "test",
      removalPolicy: RemovalPolicy.DESTROY,
    },
  });
  template = Template.fromStack(stack);
}, 60_000);

describe("CloudFront", () => {
  it("/api/* はキャッシュせず、全ビューアーヘッダー（Authorization を含む）を転送する", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: [
          Match.objectLike({
            PathPattern: "/api/*",
            CachePolicyId: cloudfront.CachePolicy.CACHING_DISABLED.cachePolicyId,
            OriginRequestPolicyId:
              cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER.originRequestPolicyId,
          }),
        ],
      }),
    });
  });

  it("ディストリビューション全体のカスタムエラーレスポンスを使わない（API の 403/404 を HTML にしない）", () => {
    const dists = template.findResources("AWS::CloudFront::Distribution");
    for (const d of Object.values(dists)) {
      expect(d.Properties.DistributionConfig.CustomErrorResponses).toBeUndefined();
    }
  });
});

describe("SPA 書き換え関数", () => {
  const handler = new Function(`${SPA_REWRITE}; return handler;`)() as (e: {
    request: { uri: string };
  }) => { uri: string };
  const rewrite = (uri: string) => handler({ request: { uri } }).uri;

  it.each([
    ["/", "/index.html"],
    ["/exam", "/index.html"],
    ["/exam/abc", "/index.html"],
    ["/grader/login", "/index.html"],
    ["/assets/index-abc.js", "/assets/index-abc.js"],
    ["/config.json", "/config.json"],
    ["/favicon.ico", "/favicon.ico"],
  ])("%s → %s", (uri, expected) => {
    expect(rewrite(uri)).toBe(expected);
  });
});

describe("API", () => {
  it("Lambda には DynamoDB の GetItem のみ付与する", () => {
    const policies = template.findResources("AWS::IAM::Policy", {
      Properties: { PolicyName: Match.stringLikeRegexp("ApiHandler") },
    });
    const actions = Object.values(policies).flatMap((p) =>
      p.Properties.PolicyDocument.Statement.flatMap((s: { Action: string | string[] }) =>
        Array.isArray(s.Action) ? s.Action : [s.Action],
      ),
    );
    expect(actions.filter((a: string) => a.startsWith("dynamodb:"))).toEqual(["dynamodb:GetItem"]);
  });

  it("ステージ全体のスロットリングはコスト上限として十分高い", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      DefaultRouteSettings: { ThrottlingRateLimit: 200, ThrottlingBurstLimit: 400 },
    });
  });

  it("全ルートに JWT オーソライザーを付ける", () => {
    const routes = template.findResources("AWS::ApiGatewayV2::Route");
    for (const r of Object.values(routes)) {
      expect(r.Properties.AuthorizationType).toBe("JWT");
    }
  });
});
