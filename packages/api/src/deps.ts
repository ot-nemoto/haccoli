import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export interface ApiDeps {
  ddb: DynamoDBDocumentClient;
  tableName: string;
}
