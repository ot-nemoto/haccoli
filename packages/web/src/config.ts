export interface RuntimeConfig {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
}

/** デプロイ時に CDK が配置する /config.json を読み込む（ビルド成果物を環境非依存にするため） */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const res = await fetch("/config.json", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(
      "config.json を読み込めませんでした。ローカル開発時は npm run admin -- -e dev web:config を実行してください",
    );
  }
  return (await res.json()) as RuntimeConfig;
}
