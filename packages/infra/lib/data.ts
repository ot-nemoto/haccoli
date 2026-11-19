import { aws_dynamodb as dynamodb } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvConfig } from "./config.js";

/** DynamoDB シングルテーブル。docs/design.md §6 */
export class Data extends Construct {
  readonly table: dynamodb.TableV2;

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
  }
}
