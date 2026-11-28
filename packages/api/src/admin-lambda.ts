import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { s3FileStore } from "@haccoli/core";
import { handle } from "hono/aws-lambda";
import { createAdminApp } from "./admin-app.js";
import { requiredEnv } from "./env.js";

/** 管理者 API の Lambda（docs/design.md §14.3） */
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const handler = handle(
  createAdminApp({
    ddb,
    tableName: requiredEnv("TABLE_NAME"),
    auditTableName: requiredEnv("AUDIT_TABLE_NAME"),
    cognito: new CognitoIdentityProviderClient({}),
    userPoolId: requiredEnv("USER_POOL_ID"),
    // 提出ファイルのダウンロード用 URL の発行（GetObject）のみ
    files: s3FileStore(new S3Client({}), requiredEnv("SUBMISSIONS_BUCKET")),
  }),
);
