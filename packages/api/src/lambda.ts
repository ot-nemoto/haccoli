import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { s3FileStore } from "@haccoli/core";
import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";
import { requiredEnv } from "./env.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const files = s3FileStore(new S3Client({}), requiredEnv("SUBMISSIONS_BUCKET"));

export const handler = handle(createApp({ ddb, tableName: requiredEnv("TABLE_NAME"), files }));
