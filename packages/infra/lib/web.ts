import { existsSync } from "node:fs";
import {
  aws_cloudfront as cloudfront,
  Duration,
  aws_cloudfront_origins as origins,
  RemovalPolicy,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
} from "aws-cdk-lib";
import { Construct } from "constructs";

export interface WebProps {
  distDir: string;
  /** SPA が起動時に読み込む /config.json の内容 */
  runtimeConfig: Record<string, string>;
  /** CSP の connect-src に許可するオリジン（Cognito）。API は同一オリジン（/api/*） */
  connectSources: string[];
  /** /api/* の転送先（API Gateway HTTP API のドメイン） */
  apiOriginDomain: string;
}

/**
 * SPA のクライアントサイドルーティング（/exam 等）を index.html に書き換える。
 * カスタムエラーレスポンス（403/404 → index.html）はディストリビューション全体に効き、
 * API の 403/404 まで HTML に化けるため使わない。拡張子のないパスのみ書き換える。
 */
const SPA_REWRITE = `function handler(event) {
  var request = event.request;
  var last = request.uri.split("/").pop();
  if (last.indexOf(".") === -1) request.uri = "/index.html";
  return request;
}`;

/** SPA 配信（S3 + CloudFront, OAC）。docs/design.md §3 */
export class Web extends Construct {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: WebProps) {
    super(scope, id);

    if (!existsSync(props.distDir)) {
      throw new Error(
        `SPA のビルド成果物がありません: ${props.distDir}\n先に npm run web:build を実行してください`,
      );
    }

    const bucket = new s3.Bucket(this, "Bucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // 静的ファイルはデプロイで再生成できるため常に削除
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        contentSecurityPolicy: {
          contentSecurityPolicy: [
            "default-src 'self'",
            `connect-src 'self' ${props.connectSources.join(" ")}`,
            "img-src 'self' data:",
            "style-src 'self' 'unsafe-inline'",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
          ].join("; "),
          override: true,
        },
      },
    });

    const spaRewrite = new cloudfront.Function(this, "SpaRewrite", {
      code: cloudfront.FunctionCode.fromInline(SPA_REWRITE),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          { function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        "/api/*": {
          origin: new origins.HttpOrigin(props.apiOriginDomain, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          // API はキャッシュしない。全ビューアーヘッダー転送のポリシーなら Authorization も転送される
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: headers,
        },
      },
      // TODO: 独自ドメイン決定後に certificate / domainNames / minimumProtocolVersion(TLS1.2) を設定
    });

    new s3deploy.BucketDeployment(this, "Deploy", {
      destinationBucket: bucket,
      sources: [
        s3deploy.Source.asset(props.distDir),
        s3deploy.Source.jsonData("config.json", props.runtimeConfig),
      ],
      distribution: this.distribution,
      distributionPaths: ["/*"],
    });
  }
}
