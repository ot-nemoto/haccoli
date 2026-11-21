import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { FileStore } from "@haccoli/core";

export interface ApiDeps {
  ddb: DynamoDBDocumentClient;
  tableName: string;
  now?: () => Date;
  files?: FileStore;
}
