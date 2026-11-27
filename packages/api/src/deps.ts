import type { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { FileStore } from "@haccoli/core";

/** 候補者・採点者の API の依存 */
export interface ApiDeps {
  ddb: DynamoDBDocumentClient;
  tableName: string;
  now?: () => Date;
  files?: FileStore;
}

/**
 * 管理者 API の依存（docs/design.md §14.3）。Cognito のユーザー管理と監査ログのテーブルは、
 * 管理者 API の Lambda だけが使う。実行者（actor）はリクエストごとに、認可済みの管理者から作る。
 */
export interface AdminApiDeps extends ApiDeps {
  cognito: CognitoIdentityProviderClient;
  userPoolId: string;
  auditTableName: string;
}
