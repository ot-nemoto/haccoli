import {
  aws_cloudwatch_actions as actions,
  type aws_apigatewayv2 as apigw,
  aws_cloudwatch as cloudwatch,
  Duration,
  type aws_lambda as lambda,
  aws_sns as sns,
  aws_sns_subscriptions as subscriptions,
} from "aws-cdk-lib";
import { Construct } from "constructs";

export interface MonitoringProps {
  envName: string;
  /** アラームの通知先（SNS のメール購読。初回は確認メールのリンクを承認する） */
  alarmEmail: string;
  httpApi: apigw.HttpApi;
  apiFunction: lambda.IFunction;
}

/**
 * SES の評価指標のしきい値。AWS は送信停止の前に「審査」状態にする
 * （バウンス率 5%・苦情率 0.1% が目安）ので、その手前で気づけるようにする。
 */
export const SES_BOUNCE_RATE_THRESHOLD = 0.04;
export const SES_COMPLAINT_RATE_THRESHOLD = 0.0008;

/**
 * 最小構成の監視（docs/design.md §10）。prod のみ作成する。
 * ① API 5xx / Lambda エラー：候補者が受験・提出できない障害の検知
 * ② SES バウンス率・苦情率：送信停止（全員ログイン不可）の予防
 * 期限処理バッチの失敗は監視しない（期限判定は書き込み時の条件で担保される。§1）
 */
export class Monitoring extends Construct {
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);

    this.topic = new sns.Topic(this, "AlarmTopic", {
      displayName: `haccoli-${props.envName} alarms`,
      enforceSSL: true,
    });
    this.topic.addSubscription(new subscriptions.EmailSubscription(props.alarmEmail));
    const notify = new actions.SnsAction(this.topic);

    const alarms = [
      new cloudwatch.Alarm(this, "Api5xx", {
        alarmName: `haccoli-${props.envName}-api-5xx`,
        alarmDescription: "API が 5xx を返しました。候補者が受験・提出できない可能性があります",
        metric: props.httpApi.metricServerError({ period: Duration.minutes(5), statistic: "Sum" }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, "ApiLambdaErrors", {
        alarmName: `haccoli-${props.envName}-api-lambda-errors`,
        alarmDescription: "API の Lambda でエラー（例外・タイムアウト）が発生しました",
        metric: props.apiFunction.metricErrors({ period: Duration.minutes(5), statistic: "Sum" }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      sesAlarm(this, "SesBounceRate", {
        alarmName: `haccoli-${props.envName}-ses-bounce-rate`,
        alarmDescription:
          "SES のバウンス率が上がっています（5% で審査、10% で送信停止の目安）。宛先の誤りを確認してください",
        metricName: "Reputation.BounceRate",
        threshold: SES_BOUNCE_RATE_THRESHOLD,
      }),
      sesAlarm(this, "SesComplaintRate", {
        alarmName: `haccoli-${props.envName}-ses-complaint-rate`,
        alarmDescription: "SES の苦情率が上がっています（0.1% で審査、0.5% で送信停止の目安）",
        metricName: "Reputation.ComplaintRate",
        threshold: SES_COMPLAINT_RATE_THRESHOLD,
      }),
    ];
    for (const alarm of alarms) {
      alarm.addAlarmAction(notify);
      alarm.addOkAction(notify);
    }
  }
}

/** SES の評価指標はアカウント単位（ディメンションなし）。送信がない時間は欠損になる */
function sesAlarm(
  scope: Construct,
  id: string,
  props: { alarmName: string; alarmDescription: string; metricName: string; threshold: number },
): cloudwatch.Alarm {
  return new cloudwatch.Alarm(scope, id, {
    alarmName: props.alarmName,
    alarmDescription: props.alarmDescription,
    metric: new cloudwatch.Metric({
      namespace: "AWS/SES",
      metricName: props.metricName,
      statistic: "Maximum",
      period: Duration.hours(1),
    }),
    threshold: props.threshold,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
}
