import { RemovalPolicy } from "aws-cdk-lib";

export type EnvName = "dev" | "prod";

export interface EnvConfig {
  envName: EnvName;
  /** Cognito の OTP メール送信元。SES で検証済みのアドレス（またはドメイン配下のアドレス）であること */
  fromEmail: string;
  fromName: string;
  /** fromEmail がドメイン認証済み SES ID の配下である場合に指定（例: recruit.example.co.jp） */
  sesVerifiedDomain?: string;
  /** アラームの通知先メールアドレス（prod のみ必須。dev はアラームを作らない） */
  alarmEmail?: string;
  /** 永続データ（User Pool / テーブル）の削除ポリシー */
  removalPolicy: RemovalPolicy;
}

/**
 * 環境ごとの設定。送信元アドレスはまだ決まっていないため、
 * cdk のコンテキスト（-c fromEmail=...）または環境変数 HACCOLI_FROM_EMAIL で与える。
 * アラームの通知先も同様に -c alarmEmail=... または HACCOLI_ALARM_EMAIL で与える（コードに書かない）。
 * 送信元をドメイン単位で SES に認証した場合は、-c sesVerifiedDomain=... または HACCOLI_SES_VERIFIED_DOMAIN で与える。
 */
export function loadEnvName(get: (key: string) => unknown): EnvName {
  const envName = (get("env") ?? "dev") as string;
  if (envName !== "dev" && envName !== "prod") {
    throw new Error(`env は dev または prod を指定してください: ${envName}`);
  }
  return envName;
}

export function loadConfig(get: (key: string) => unknown): EnvConfig {
  const envName = loadEnvName(get);
  // 空文字（-c fromEmail= など）は未指定として環境変数に切り替える
  const fromEmail = (get("fromEmail") as string | undefined) || process.env.HACCOLI_FROM_EMAIL;
  if (!fromEmail) {
    throw new Error(
      "OTP メールの送信元が未指定です。-c fromEmail=... または HACCOLI_FROM_EMAIL を設定してください",
    );
  }
  const alarmEmail = (get("alarmEmail") as string | undefined) || process.env.HACCOLI_ALARM_EMAIL;
  if (envName === "prod" && !alarmEmail) {
    throw new Error(
      "アラームの通知先が未指定です。-c alarmEmail=... または HACCOLI_ALARM_EMAIL を設定してください",
    );
  }
  const sesVerifiedDomain = verifiedDomainOf(
    fromEmail,
    (get("sesVerifiedDomain") as string | undefined) || process.env.HACCOLI_SES_VERIFIED_DOMAIN,
  );
  return {
    envName,
    fromEmail,
    fromName: (get("fromName") as string | undefined) ?? "採用課題システム",
    ...(sesVerifiedDomain ? { sesVerifiedDomain } : {}),
    ...(alarmEmail ? { alarmEmail } : {}),
    removalPolicy: envName === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
  };
}

/**
 * 送信元のドメイン認証。CDK は fromEmail の @ 以降との完全一致を求めるため、
 * 空白・大文字小文字の違いは吸収し、それ以外の不一致（サブドメインを含む）はここでわかりやすく止める。
 */
function verifiedDomainOf(fromEmail: string, raw: string | undefined): string | undefined {
  const domain = raw?.trim();
  if (!domain) return undefined;
  const fromDomain = fromEmail.split("@").pop() ?? "";
  if (fromDomain.toLowerCase() !== domain.toLowerCase()) {
    throw new Error(
      `送信元アドレス（${fromEmail}）の @ 以降が sesVerifiedDomain（${domain}）と一致しません。サブドメインのアドレスは使えません`,
    );
  }
  return fromDomain;
}
