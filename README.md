# haccoli — 採用課題試験管理システム

候補者がメールアドレス + ワンタイムパスコードでログインして採用課題に回答し、採点者が採点するシステム（AWS サーバーレス）。

- 設計書: [docs/design.md](docs/design.md)
- 運用手順書: [docs/runbook.md](docs/runbook.md)（日々の運用・アラーム対応・prod の構築）

## 構成

| パッケージ           | 内容                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/core`      | ドメインロジック（ユーザー登録など）。API と管理 CLI で共有                                            |
| `packages/shared`    | API の型・課題定義の型。API と SPA で共有（zod スキーマは `@haccoli/shared/schemas` でサーバー側のみ） |
| `exams/`             | 課題定義（`exam.json` + Markdown）。`exam:publish` で投入                                              |
| `packages/api`       | API（Lambda + Hono）。CloudFront の `/api/*` から API Gateway 経由で呼ばれる                           |
| `packages/infra`     | AWS CDK（Cognito / DynamoDB / API Gateway + Lambda / S3 + CloudFront）                                 |
| `packages/web`       | React + Vite SPA（候補者・採点者画面）                                                                 |
| `packages/admin-cli` | 管理者用 CLI                                                                                           |
| `packages/e2e`       | dev 環境に対する E2E テスト（Playwright）                                                              |

## 開発コマンド

```bash
npm install
npm run typecheck   # 型チェック
npm test            # ユニットテスト
npm run lint        # Biome
```

### E2E テスト（dev 環境）

デプロイ済みの dev 環境に対して、受験の発行 → 候補者の回答・提出 → 採点者の割り当て → 採点・確定までと、管理画面（利用者・監査ログ）を Playwright で確かめる。

```bash
npx -w @haccoli/e2e playwright install chromium   # 初回のみ
npm run e2e

# デプロイ前の画面の変更を試す場合は、ローカルの SPA（「ローカルで SPA を動かす」）に向ける
HACCOLI_E2E_BASE_URL=http://localhost:5173 npm run e2e
```

- dev アカウントの AWS 認証情報が必要（管理 CLI と同じ）。対象は dev に固定しており、prod には実行できない
- ログインはメール OTP のため自動化できない。テスト用ユーザーに限り、実行ごとに生成したパスワードで Cognito のトークンを取り、画面の sessionStorage に入れて開く。**OTP を入力するログイン画面はテストの対象外**
- テスト用の候補者（`e2e-cand-…@example.com`）は実行ごとに作り、終了時に `user:purge` と同じ処理で削除する（途中で失敗しても、取消・採点の確定をしてから削除する）
- 採点者 `e2e-grader@example.com` は削除できないため使い回す。終了時にパスワードを再びランダムな値に戻し、リフレッシュトークンを失効させる（アクセストークンは発行から 60 分まで有効）
- 管理画面のテストは、dev に常設の管理者 `e2e-admin@example.com` を使う（なければ `npm run admin -- -e dev admin:add --email e2e-admin@example.com --name "E2E 管理者"` で登録する）。e2e-grader への管理者のロールの付与と削除を画面から行い、終了時に e2e-grader を採点者だけに戻す。パスワードの扱いは e2e-grader と同じ
- 受験の管理画面のテストは、実行ごとの候補者に画面から受験を発行し、e2e-grader の割り当て・期限の変更・取消と、採点結果の CSV の出力を行う。ダウンロードした CSV は Playwright の一時ファイルのまま読み、コピーしない。候補者は終了時に削除する
- 課題 `exams/sample-2026` を投入する（内容が同じなら何もしない）
- 通常の CI（`npm test`）には含めない。失敗時のスクリーンショットとトレースは `packages/e2e/test-results/` に出る。トレースにはトークンを含む通信が残るため、共有しない（確認後に削除する）

## デプロイ（GitHub Actions）

| ブランチ  | デプロイ先 | 備考                                                |
| --------- | ---------- | --------------------------------------------------- |
| `develop` | dev        | push で自動デプロイ                                 |
| `main`    | prod       | push で自動デプロイ（Environment の承認設定を推奨） |

- `.github/workflows/deploy.yml`: lint / 型チェック / テスト → SPA ビルド → `cdk deploy`。手動実行（workflow_dispatch）も可能
- `.github/workflows/ci.yml`: PR で lint / 型チェック / テスト / `cdk synth`
- AWS 認証は OIDC（GitHub にアクセスキーを置かない）
- 画面 URL は当面 CloudFront の既定ドメイン（`https://xxxx.cloudfront.net`）。デプロイジョブのサマリーに表示される

### 初回セットアップ（環境ごとに 1 回、管理者がローカルで実施）

前提: AWS 認証情報（`aws configure sso` → `aws sso login --profile <profile>`、`export AWS_PROFILE=<profile>`）。
リージョンは既定で `ap-northeast-1`（変更する場合は CDK・CLI とも `HACCOLI_REGION` を設定）。

#### 1. SES の送信元アドレスを検証する

Cognito の Email OTP は SES 経由の送信が必須。送信元ドメインは未決定のため、dev では個人などのメールアドレスを送信元として検証する。

```bash
aws sesv2 create-email-identity --email-identity sender@example.com
# 届いた確認メールのリンクをクリック
```

SES がサンドボックスの間は **受信者のアドレスも検証が必要**。テストで使う候補者・採点者のアドレスも同様に検証する。

#### 2. CDK ブートストラップと GitHub 用デプロイロールの作成

```bash
npm ci
npm run cdk -- bootstrap aws://<ACCOUNT_ID>/ap-northeast-1
npm run cdk -- deploy Haccoli-ci-dev -c env=dev -c ci=true
# 出力 DeployRoleArn を控える
```

同じ AWS アカウントに GitHub の OIDC プロバイダが既にある場合（例: prod を同一アカウントに作る 2 回目）は
`-c oidcProviderArn=arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com` を付ける。

#### 3. GitHub の Environment を設定する

リポジトリの Settings → Environments で `dev`（prod の場合は `prod`）を作成し、以下を設定する。

| 種別                  | 名前                          | 値                                                                                                                                                  |
| --------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Variable              | `AWS_ROLE_ARN`                | 手順 2 の `DeployRoleArn`                                                                                                                           |
| Variable              | `HACCOLI_FROM_EMAIL`          | 手順 1 で検証した送信元アドレス                                                                                                                     |
| Variable（prod のみ） | `HACCOLI_ALARM_EMAIL`         | アラームの通知先（prod は必須。未設定だとデプロイが失敗する）                                                                                       |
| Variable（任意）      | `HACCOLI_SES_VERIFIED_DOMAIN` | 送信元をドメイン単位で SES に認証した場合のドメイン。`HACCOLI_FROM_EMAIL` は @ 以降がこのドメインと完全に一致するアドレスにする（サブドメイン不可） |
| Variable（任意）      | `HACCOLI_REGION`              | 既定 `ap-northeast-1`                                                                                                                               |
| Deployment branches   | —                             | dev: `develop`、prod: `main` のみに制限                                                                                                             |
| Required reviewers    | —                             | prod は設定を推奨                                                                                                                                   |

#### 4. デプロイ

`develop` に push するとデプロイされる。

#### 5. ユーザー登録とログイン確認

```bash
npm run admin -- -e dev candidate:add --email cand@example.com --name "候補 太郎"
npm run admin -- -e dev grader:add    --email grader@example.com --name "採点 花子"
npm run admin -- -e dev candidate:list
```

- 候補者: `<WebUrl>/login`
- 採点者: `<WebUrl>/grader/login`

### ローカルからのデプロイ（緊急時など）

```bash
export HACCOLI_FROM_EMAIL=sender@example.com
npm run deploy -- Haccoli-dev -c env=dev

# prod はアラームの通知先も必須
export HACCOLI_ALARM_EMAIL=ops@example.com
# 送信元をドメイン単位で認証している場合は、ドメインも必ず指定する（指定しないとアドレスの ID に切り替わる）
export HACCOLI_SES_VERIFIED_DOMAIN=recruit.example.co.jp
npm run deploy -- Haccoli-prod -c env=prod
```

prod の初回デプロイ後、通知先に SNS の確認メールが届く。リンクを承認するまでアラームは通知されない。
通知先を変えるときは、新しい値で再デプロイし、新しいアドレスで確認メールを承認する。

### ローカルで SPA を動かす

```bash
npm run admin -- -e dev web:config   # packages/web/public/config.json を生成
# /api はデプロイ済み環境へプロキシする（WebUrl を指定）
HACCOLI_WEB_URL=https://xxxx.cloudfront.net npm run web:dev   # http://localhost:5173
```

## 管理 CLI

```bash
npm run admin -- -e <dev|prod> <command> [options]
npm run admin -- --help
```

| コマンド                                                                                      | 内容                                                                                                                                   |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `candidate:add --email --name` / `grader:add --email [--name]` / `admin:add --email [--name]` | 登録。登録済みの採点者・管理者に対する `grader:add` / `admin:add` はロールの付与（兼任。次のログインから有効）                         |
| `candidate:list` / `grader:list` / `admin:list`                                               | 一覧（ロールを表示）                                                                                                                   |
| `candidate:disable --email` / `grader:disable --email` / `admin:disable --email`              | 無効化（ほかのロールも含めてログインできなくなる）                                                                                     |
| `grader:remove --email` / `admin:remove --email`                                              | ロールを外す（最後のロールは外せない。即時に無効）                                                                                     |
| `user:migrate-roles`                                                                          | 利用者のロールを複数ロールの形式に移行する（Step 7 のデプロイ後に 1 回。何度実行してもよい）                                           |
| `exam:publish --dir exams/<examId> [--dry-run]`                                               | 課題定義を検証して投入（新しい版を作成。同じ内容なら何もしない）                                                                       |
| `exam:list`                                                                                   | 課題と最新版の一覧                                                                                                                     |
| `attempt:issue --email --exam --deadline YYYY-MM-DD [--force]`                                | 受験を発行（最新版、期限 = 指定日 23:59 JST。当日指定は `--force`）                                                                    |
| `attempt:extend --attempt --deadline YYYY-MM-DD [--force]`                                    | 受験期限を変更（期限切れ `EXPIRED` からの復帰を含む。提出済み・取消は不可）                                                            |
| `attempt:cancel --attempt`                                                                    | 受験を取消（未着手・受験中のみ。保存済みの回答は残す。元に戻せない）                                                                   |
| `attempt:list [--status]`                                                                     | 受験の一覧（期限切れはバッチ前でも `EXPIRED` と表示）                                                                                  |
| `attempt:assign --attempt --grader <email...>`                                                | 採点者を割り当て（複数可。EXPIRED / CANCELED は不可。割り当ての解除は未対応）                                                          |
| `result:export --exam [--out results.csv]`                                                    | 採点結果を CSV 出力（受験 × 採点者ごとに 1 行。候補者の個人情報を含む）                                                                |
| `user:purge --email`                                                                          | 候補者の個人データを削除（Cognito・DynamoDB・S3 の全バージョン）。採点が終わっていない受験があると拒否。dev でも確認あり。元に戻せない |
| `audit:list [--month YYYY-MM] [--action]`                                                     | 監査ログの一覧（JST の月ごと、新しい順。既定は今月）                                                                                   |
| `web:config`                                                                                  | ローカル開発用の SPA 設定を生成                                                                                                        |

prod に対する変更操作は確認プロンプトが出る（`-y` で省略）。

### 例: サンプル課題で受験を発行する

```bash
npm run admin -- -e dev exam:publish --dir exams/sample-2026
npm run admin -- -e dev attempt:issue --email cand@example.com --exam sample-2026 --deadline 2026-12-31
```
