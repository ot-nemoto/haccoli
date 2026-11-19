import { RemovalPolicy } from "aws-cdk-lib";

export type EnvName = "dev" | "prod";

export interface EnvConfig {
  envName: EnvName;
  /** Cognito の OTP メール送信元。SES で検証済みのアドレス（またはドメイン配下のアドレス）であること */
  fromEmail: string;
  fromName: string;
  /** fromEmail がドメイン認証済み SES ID の配下である場合に指定（例: recruit.example.co.jp） */
  sesVerifiedDomain?: string;
  /** 永続データ（User Pool / テーブル）の削除ポリシー */
  removalPolicy: RemovalPolicy;
}

/**
 * 環境ごとの設定。送信元アドレスはまだ決まっていないため、
 * cdk のコンテキスト（-c fromEmail=...）または環境変数 HACCOLI_FROM_EMAIL で与える。
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
  const fromEmail = (get("fromEmail") as string | undefined) ?? process.env.HACCOLI_FROM_EMAIL;
  if (!fromEmail) {
    throw new Error(
      "OTP メールの送信元が未指定です。-c fromEmail=... または HACCOLI_FROM_EMAIL を設定してください",
    );
  }
  return {
    envName,
    fromEmail,
    fromName: (get("fromName") as string | undefined) ?? "採用課題システム",
    sesVerifiedDomain: get("sesVerifiedDomain") as string | undefined,
    removalPolicy: envName === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
  };
}
