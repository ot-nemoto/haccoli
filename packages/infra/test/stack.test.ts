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

describe("Cognito", () => {
  it("グループは candidate・grader・admin の 3 つ（admin は Phase 2。docs/design.md §14）", () => {
    const groups = Object.values(template.findResources("AWS::Cognito::UserPoolGroup"))
      .map((g) => g.Properties.GroupName)
      .sort();
    expect(groups).toEqual(["admin", "candidate", "grader"]);
  });
});

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

describe("DynamoDB", () => {
  it("監査ログは業務データと別のテーブルで、PITR を有効にする（docs/design.md §14.4）", () => {
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      TableName: "haccoli-dev-audit",
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      Replicas: [
        Match.objectLike({
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        }),
      ],
    });
    template.hasOutput("AuditTableName", {});
  });

  it("API・期限処理の Lambda の DynamoDB 権限は業務データのテーブルだけ（監査ログは管理者 API のみ）", () => {
    const resources = Object.values(
      template.findResources("AWS::IAM::Policy", {
        Properties: { PolicyName: Match.stringLikeRegexp("^Api(Handler|Expire)") },
      }),
    ).flatMap((p) =>
      p.Properties.PolicyDocument.Statement.filter((s: { Action: string | string[] }) =>
        [s.Action].flat().some((a) => a.startsWith("dynamodb:")),
      ).flatMap((s: { Resource: unknown }) => [s.Resource].flat()),
    );
    expect(resources.length).toBeGreaterThan(0);
    for (const r of resources) {
      // テーブル名の文字列やワイルドカードではなく、業務データのテーブルの ARN（と GSI）を参照する
      expect(typeof r).not.toBe("string");
      expect(JSON.stringify(r)).toMatch(/"DataTable[0-9A-F]{8}"/);
      expect(JSON.stringify(r)).not.toContain("AuditTable");
    }
  });
});

/** Lambda の実行ロールのポリシーの Statement（PolicyName の先頭で選ぶ） */
function statementsOf(policyPrefix: string) {
  const policies = template.findResources("AWS::IAM::Policy", {
    Properties: { PolicyName: Match.stringLikeRegexp(`^${policyPrefix}`) },
  });
  expect(Object.keys(policies).length).toBeGreaterThan(0);
  return Object.values(policies).flatMap(
    (p) =>
      p.Properties.PolicyDocument.Statement as { Action: string | string[]; Resource: unknown }[],
  );
}
const actionsOf = (statements: { Action: string | string[] }[]) =>
  statements.flatMap((s) => [s.Action].flat()).sort();

describe("管理者 API（docs/design.md §14.3）", () => {
  it("/api/admin/{proxy+} は管理者 API の Lambda に、それ以外は候補者・採点者の API の Lambda に送る", () => {
    const routes = Object.values(template.findResources("AWS::ApiGatewayV2::Route"));
    const keys = routes.map((r) => r.Properties.RouteKey).sort();
    expect(keys).toEqual(["ANY /api/admin/{proxy+}", "ANY /api/{proxy+}"]);
    const integrations = template.findResources("AWS::ApiGatewayV2::Integration");
    const targetOf = (routeKey: string) => {
      const route = routes.find((r) => r.Properties.RouteKey === routeKey);
      const integrationId = JSON.stringify(route?.Properties.Target).match(
        /"(ApiHttpApi[A-Za-z0-9]+)"/,
      )?.[1];
      return JSON.stringify(integrations[integrationId ?? ""]?.Properties.IntegrationUri);
    };
    expect(targetOf("ANY /api/admin/{proxy+}")).toMatch(/"ApiAdminHandler[0-9A-F]{8}"/);
    expect(targetOf("ANY /api/{proxy+}")).toMatch(/"ApiHandler[0-9A-F]{8}"/);
  });

  it("候補者・採点者の API の Lambda には Scan・Cognito・監査ログの権限がない", () => {
    const statements = statementsOf("ApiHandler");
    const actions = actionsOf(statements);
    expect(actions.filter((a) => a === "dynamodb:Scan" || a.startsWith("cognito-idp:"))).toEqual(
      [],
    );
    expect(JSON.stringify(statements)).not.toContain("AuditTable");
  });

  it("管理者 API の Lambda の権限は、使う操作だけ（業務データ・監査ログとも削除なし）", () => {
    const statements = statementsOf("ApiAdminHandler");
    const on = (logicalId: RegExp) =>
      actionsOf(statements.filter((s) => logicalId.test(JSON.stringify(s.Resource))));
    expect(on(/"DataTable[0-9A-F]{8}"/)).toEqual([
      "dynamodb:ConditionCheckItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:UpdateItem",
    ]);
    // 監査ログ: 記録と一覧だけ。DeleteItem・BatchWriteItem などは与えない
    expect(on(/"DataAuditTable[0-9A-F]{8}"/)).toEqual([
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]);
    // 状態ごとの受験の一覧（GSI2）と、メールアドレスでの検索（GSI1）
    const data = statements.filter((s) =>
      /"DataTable[0-9A-F]{8}"/.test(JSON.stringify(s.Resource)),
    );
    expect(JSON.stringify(data)).toContain("/index/GSI1");
    expect(JSON.stringify(data)).toContain("/index/GSI2");
    // 提出ファイル: ダウンロード用 URL の発行（GetObject）だけ。アップロード・削除はさせない
    const s3 = statements.filter((s) => actionsOf([s]).some((a) => a.startsWith("s3:")));
    expect(actionsOf(s3)).toEqual(["s3:GetObject"]);
    expect(JSON.stringify(s3.map((s) => s.Resource))).toMatch(/\/attempts\/\*/);
    expect(on(/"AuthUserPool[0-9A-F]{8}"/)).toEqual([
      "cognito-idp:AdminAddUserToGroup",
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminDeleteUser",
      "cognito-idp:AdminDisableUser",
      "cognito-idp:AdminRemoveUserFromGroup",
      "cognito-idp:AdminSetUserPassword",
    ]);
    // ワイルドカードの操作・リソースを使わない
    expect(actionsOf(statements).some((a) => a.includes("*"))).toBe(false);
    for (const s of statements) {
      for (const r of [s.Resource].flat()) expect(r).not.toBe("*");
    }
  });

  it("管理者 API の Lambda に、テーブル名・監査ログのテーブル名・User Pool ID・提出ファイルのバケットを渡す", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          TABLE_NAME: Match.anyValue(),
          AUDIT_TABLE_NAME: Match.anyValue(),
          USER_POOL_ID: Match.anyValue(),
          SUBMISSIONS_BUCKET: Match.anyValue(),
        }),
      },
      Timeout: 25,
    });
  });
});

describe("API", () => {
  it("Lambda の DynamoDB 権限は必要な操作のみ（Scan・削除・一括取得なし）", () => {
    const policies = template.findResources("AWS::IAM::Policy", {
      Properties: { PolicyName: Match.stringLikeRegexp("ApiHandler") },
    });
    const actions = Object.values(policies).flatMap((p) =>
      p.Properties.PolicyDocument.Statement.flatMap((s: { Action: string | string[] }) =>
        Array.isArray(s.Action) ? s.Action : [s.Action],
      ),
    );
    expect(actions.filter((a: string) => a.startsWith("dynamodb:")).sort()).toEqual([
      "dynamodb:ConditionCheckItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]);
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

describe("提出ファイル（S3）", () => {
  it("非公開・暗号化・バージョニング・SSL 必須で、CORS は CloudFront（と dev のローカル）からの POST のみ", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "haccoli-dev-submissions-123456789012",
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: "Enabled" },
      BucketEncryption: Match.objectLike({}),
      CorsConfiguration: {
        CorsRules: [
          Match.objectLike({
            AllowedMethods: ["POST"],
            AllowedOrigins: [Match.objectLike({}), "http://localhost:5173"],
          }),
        ],
      },
      LifecycleConfiguration: {
        Rules: [Match.objectLike({ NoncurrentVersionExpiration: { NoncurrentDays: 30 } })],
      },
    });
  });

  it("API の S3 権限は attempts/ 配下の Put / Get / Delete のみ", () => {
    const policies = template.findResources("AWS::IAM::Policy", {
      Properties: { PolicyName: Match.stringLikeRegexp("ApiHandler") },
    });
    const statements = Object.values(policies).flatMap(
      (p) => p.Properties.PolicyDocument.Statement as { Action: string[]; Resource: unknown }[],
    );
    const s3 = statements.filter((s) => [s.Action].flat().some((a) => a.startsWith("s3:")));
    expect(s3).toHaveLength(1);
    expect([s3[0]?.Action].flat().sort()).toEqual([
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:PutObject",
    ]);
    expect(JSON.stringify(s3[0]?.Resource)).toContain(
      ":s3:::haccoli-dev-submissions-123456789012/attempts/*",
    );
  });

  it("CSP の connect-src にアップロード先のバケットを含める", () => {
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: {
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: {
            ContentSecurityPolicy: Match.stringLikeRegexp(
              "connect-src 'self' .*https://haccoli-dev-submissions-123456789012\\.s3\\.ap-northeast-1\\.amazonaws\\.com",
            ),
            Override: true,
          },
        }),
      },
    });
  });
});

describe("期限処理", () => {
  it("1 時間毎に期限処理 Lambda を起動する", () => {
    template.hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "rate(1 hour)",
      Target: Match.objectLike({ RetryPolicy: Match.objectLike({ MaximumRetryAttempts: 2 }) }),
    });
  });

  it("期限処理 Lambda の権限は GSI2 の Query と UpdateItem のみ", () => {
    const policies = template.findResources("AWS::IAM::Policy", {
      Properties: { PolicyName: Match.stringLikeRegexp("ApiExpire") },
    });
    const actions = Object.values(policies).flatMap((p) =>
      p.Properties.PolicyDocument.Statement.flatMap((s: { Action: string | string[] }) =>
        [s.Action].flat(),
      ),
    );
    expect(actions.sort()).toEqual(["dynamodb:Query", "dynamodb:UpdateItem"]);
  });

  it("API の Lambda タイムアウトは HTTP API の統合タイムアウト（30 秒）未満", () => {
    const fns = template.findResources("AWS::Lambda::Function", {
      Properties: { Runtime: "nodejs24.x" },
    });
    const timeouts = Object.entries(fns).map(([id, f]) => [id, f.Properties.Timeout]);
    const handler = timeouts.find(([id]) => String(id).startsWith("ApiHandler"));
    expect(handler?.[1]).toBeLessThan(30);
  });
});
