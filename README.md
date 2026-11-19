# haccoli — 採用課題試験管理システム

候補者がメールアドレス + ワンタイムパスコードでログインして採用課題に回答し、採点者が採点するシステム（AWS サーバーレス）。

- 設計書: [docs/design.md](docs/design.md)

## 構成

| パッケージ           | 内容                                                        |
| -------------------- | ----------------------------------------------------------- |
| `packages/core`      | ドメインロジック（ユーザー登録など）。API と管理 CLI で共有 |
| `packages/infra`     | AWS CDK（Cognito / DynamoDB / S3 + CloudFront）             |
| `packages/web`       | React + Vite SPA（候補者・採点者画面）                      |
| `packages/admin-cli` | 管理者用 CLI                                                |

## 開発コマンド

```bash
npm install
npm run typecheck   # 型チェック
npm test            # ユニットテスト
npm run lint        # Biome
```

## dev 環境の構築手順

### 1. 前提

- AWS 認証情報（`aws configure sso` → `aws sso login --profile <profile>`、`export AWS_PROFILE=<profile>`）
- リージョンは既定で `ap-northeast-1`（変更する場合は CDK・CLI とも `HACCOLI_REGION` を設定）

### 2. SES の送信元アドレスを検証する

Cognito の Email OTP は SES 経由の送信が必須。送信元ドメインは未決定のため、dev では個人などのメールアドレスを送信元として検証する。

```bash
aws sesv2 create-email-identity --email-identity sender@example.com
# 届いた確認メールのリンクをクリック
```

SES がサンドボックスの間は **受信者のアドレスも検証が必要**。テストで使う候補者・採点者のアドレスも同様に `create-email-identity` で検証する。

### 3. デプロイ

```bash
npm run cdk -- bootstrap            # 初回のみ（アカウント/リージョンごと）
export HACCOLI_FROM_EMAIL=sender@example.com
npm run deploy -- -c env=dev
```

出力の `WebUrl` が画面の URL。

### 4. ユーザー登録とログイン確認

```bash
npm run admin -- -e dev candidate:add --email cand@example.com --name "候補 太郎"
npm run admin -- -e dev grader:add    --email grader@example.com --name "採点 花子"
npm run admin -- -e dev candidate:list
```

- 候補者: `<WebUrl>/login`
- 採点者: `<WebUrl>/grader/login`

### ローカルで SPA を動かす

```bash
npm run admin -- -e dev web:config   # packages/web/public/config.json を生成
npm run web:dev                      # http://localhost:5173
```

## 管理 CLI

```bash
npm run admin -- -e <dev|prod> <command> [options]
npm run admin -- --help
```

| コマンド                                                     | 内容                            |
| ------------------------------------------------------------ | ------------------------------- |
| `candidate:add --email --name` / `grader:add --email --name` | 登録                            |
| `candidate:list` / `grader:list`                             | 一覧                            |
| `candidate:disable --email` / `grader:disable --email`       | 無効化                          |
| `web:config`                                                 | ローカル開発用の SPA 設定を生成 |

prod に対する変更操作は確認プロンプトが出る（`-y` で省略）。
