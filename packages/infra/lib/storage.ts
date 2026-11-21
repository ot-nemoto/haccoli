import { Duration, RemovalPolicy, Stack, aws_s3 as s3 } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvConfig } from "./config.js";

/**
 * 提出ファイルのバケット名。CloudFront の CSP と API の権限から参照するため、
 * リソースに依存しない固定の名前にする（循環参照の回避）。
 */
export function submissionsBucketName(scope: Construct, envName: string): string {
  return `haccoli-${envName}-submissions-${Stack.of(scope).account}`;
}

export interface StorageProps {
  config: EnvConfig;
  /** ブラウザから直接アップロードを許可するオリジン（CORS） */
  allowedOrigins: string[];
}

/** 提出ファイル（S3）。docs/design.md §6.2 */
export class Storage extends Construct {
  readonly submissions: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);
    const isProd = props.config.envName === "prod";

    this.submissions = new s3.Bucket(this, "Submissions", {
      bucketName: submissionsBucketName(this, props.config.envName),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      cors: [
        {
          allowedOrigins: props.allowedOrigins,
          allowedMethods: [s3.HttpMethods.POST],
          allowedHeaders: ["*"],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          // 差し替え・削除された旧ファイルは一定期間後に削除する
          noncurrentVersionExpiration: Duration.days(30),
          expiredObjectDeleteMarker: true,
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });
  }

  /** ブラウザがアップロード先として接続するエンドポイント（CSP の connect-src） */
  static endpoint(scope: Construct, envName: string): string {
    // CSP をトークンを含まない文字列にするため、Cognito と同様に amazonaws.com を直接書く
    return `https://${submissionsBucketName(scope, envName)}.s3.${Stack.of(scope).region}.amazonaws.com`;
  }
}
