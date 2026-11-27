import { aws_dynamodb as dynamodb } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvConfig } from "./config.js";

/**
 * DynamoDB。業務データはシングルテーブル（docs/design.md §6）。
 * 監査ログは別のテーブルに分ける（§14.4）。業務データと一緒に読むことがなく、
 * 業務データの Scan に影響させず、API の Lambda に削除の権限を与えないため。
 */
export class Data extends Construct {
  readonly table: dynamodb.TableV2;
  readonly auditTable: dynamodb.TableV2;

  constructor(scope: Construct, id: string, config: EnvConfig) {
    super(scope, id);

    const key = (name: string) => ({ name, type: dynamodb.AttributeType.STRING });

    this.table = new dynamodb.TableV2(this, "Table", {
      tableName: `haccoli-${config.envName}`,
      partitionKey: key("PK"),
      sortKey: key("SK"),
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: config.envName === "prod",
      removalPolicy: config.removalPolicy,
      globalSecondaryIndexes: [
        { indexName: "GSI1", partitionKey: key("GSI1PK"), sortKey: key("GSI1SK") },
        { indexName: "GSI2", partitionKey: key("GSI2PK"), sortKey: key("GSI2SK") },
      ],
    });

    this.auditTable = new dynamodb.TableV2(this, "AuditTable", {
      tableName: `haccoli-${config.envName}-audit`,
      partitionKey: key("PK"),
      sortKey: key("SK"),
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: config.envName === "prod",
      removalPolicy: config.removalPolicy,
    });
  }
}
