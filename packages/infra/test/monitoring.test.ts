import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, RemovalPolicy } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { type EnvConfig, loadConfig } from "../lib/config.js";
import { HaccoliStack } from "../lib/haccoli-stack.js";
import { SES_BOUNCE_RATE_THRESHOLD, SES_COMPLAINT_RATE_THRESHOLD } from "../lib/monitoring.js";

function synth(config: EnvConfig): Template {
  const distDir = mkdtempSync(join(tmpdir(), "haccoli-web-"));
  writeFileSync(join(distDir, "index.html"), "<!doctype html>");
  const stack = new HaccoliStack(new App(), `Haccoli-${config.envName}`, {
    env: { account: "123456789012", region: "ap-northeast-1" },
    webDistDir: distDir,
    config,
  });
  return Template.fromStack(stack);
}

const base = { fromEmail: "ci@example.com", fromName: "test" };
let prod: Template;
let dev: Template;

beforeAll(() => {
  prod = synth({
    ...base,
    envName: "prod",
    alarmEmail: "ops@example.com",
    removalPolicy: RemovalPolicy.RETAIN,
  });
  dev = synth({ ...base, envName: "dev", removalPolicy: RemovalPolicy.DESTROY });
}, 120_000);

describe("監視（prod）", () => {
  it("アラームは API 5xx・Lambda エラー・SES バウンス率・苦情率の 4 つ", () => {
    const names = Object.values(prod.findResources("AWS::CloudWatch::Alarm"))
      .map((a) => a.Properties.AlarmName)
      .sort();
    expect(names).toEqual([
      "haccoli-prod-api-5xx",
      "haccoli-prod-api-lambda-errors",
      "haccoli-prod-ses-bounce-rate",
      "haccoli-prod-ses-complaint-rate",
    ]);
  });

  it("API の 5xx と Lambda のエラーは 5 分間に 1 件以上で鳴る", () => {
    for (const [namespace, metricName] of [
      ["AWS/ApiGateway", "5xx"],
      ["AWS/Lambda", "Errors"],
    ]) {
      prod.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Namespace: namespace,
        MetricName: metricName,
        Statistic: "Sum",
        Period: 300,
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        TreatMissingData: "notBreaching",
      });
    }
  });

  it("SES の評価指標は AWS の審査の目安（5%・0.1%）より手前で鳴る", () => {
    expect(SES_BOUNCE_RATE_THRESHOLD).toBeLessThan(0.05);
    expect(SES_COMPLAINT_RATE_THRESHOLD).toBeLessThan(0.001);
    for (const [metricName, threshold] of [
      ["Reputation.BounceRate", SES_BOUNCE_RATE_THRESHOLD],
      ["Reputation.ComplaintRate", SES_COMPLAINT_RATE_THRESHOLD],
    ] as const) {
      prod.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Namespace: "AWS/SES",
        MetricName: metricName,
        Statistic: "Maximum",
        Threshold: threshold,
        // 送信がない時間に「復旧」を通知しない
        TreatMissingData: "ignore",
      });
    }
  });

  it("全アラームが、発生時と復旧時に SNS 経由でメール通知する", () => {
    const topics = Object.keys(prod.findResources("AWS::SNS::Topic"));
    expect(topics).toHaveLength(1);
    const ref = [{ Ref: topics[0] }];
    for (const alarm of Object.values(prod.findResources("AWS::CloudWatch::Alarm"))) {
      expect(alarm.Properties.AlarmActions).toEqual(ref);
      expect(alarm.Properties.OKActions).toEqual(ref);
    }
    prod.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "email",
      Endpoint: "ops@example.com",
      TopicArn: Match.objectLike({ Ref: topics[0] }),
    });
  });
});

describe("監視（SNS のポリシー）", () => {
  it("SSL 必須にしつつ、自アカウントの CloudWatch アラームからの発行を許可する", () => {
    prod.hasResourceProperties("AWS::SNS::TopicPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
          Match.objectLike({
            Effect: "Allow",
            Principal: { Service: "cloudwatch.amazonaws.com" },
            Action: "sns:Publish",
            Condition: Match.objectLike({
              StringEquals: { "aws:SourceAccount": "123456789012" },
            }),
          }),
        ]),
      },
    });
  });
});

describe("監視（dev）", () => {
  it("アラームと通知用の SNS は作らない", () => {
    dev.resourceCountIs("AWS::CloudWatch::Alarm", 0);
    dev.resourceCountIs("AWS::SNS::Topic", 0);
  });
});

describe("loadConfig", () => {
  const ctx = (values: Record<string, string>) => (key: string) => values[key];

  it("prod で通知先がなければエラー、dev は不要。空文字は未指定として扱う", () => {
    const prev = process.env.HACCOLI_ALARM_EMAIL;
    delete process.env.HACCOLI_ALARM_EMAIL;
    try {
      expect(() => loadConfig(ctx({ env: "prod", fromEmail: "a@example.com" }))).toThrow(
        /alarmEmail/,
      );
      expect(
        loadConfig(ctx({ env: "dev", fromEmail: "a@example.com" })).alarmEmail,
      ).toBeUndefined();
      expect(
        loadConfig(ctx({ env: "prod", fromEmail: "a@example.com", alarmEmail: "o@example.com" }))
          .alarmEmail,
      ).toBe("o@example.com");
      process.env.HACCOLI_ALARM_EMAIL = "env@example.com";
      expect(
        loadConfig(ctx({ env: "prod", fromEmail: "a@example.com", alarmEmail: "" })).alarmEmail,
      ).toBe("env@example.com");
      delete process.env.HACCOLI_ALARM_EMAIL;
    } finally {
      if (prev !== undefined) process.env.HACCOLI_ALARM_EMAIL = prev;
    }
  });
});
