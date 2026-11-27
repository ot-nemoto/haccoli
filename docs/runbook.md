# 運用手順書

管理者が日々の運用、アラームへの対応、prod の構築を行うための手順です。
設計の背景は [design.md](design.md)、コマンドの一覧は [README](../README.md#管理-cli) を参照してください。

- [1. 前提](#1-前提)
- [2. 日々の運用](#2-日々の運用)
- [3. アラームへの対応](#3-アラームへの対応)
- [4. prod の構築](#4-prod-の構築)
- [5. MVP で未対応の運用](#5-mvp-で未対応の運用)

---

## 1. 前提

- 管理 CLI はリポジトリのルートで実行します。`npm ci` を済ませておきます。
- AWS の認証情報は、AWS SDK の通常の解決順（`AWS_PROFILE`・SSO・環境変数）で読み込まれます。対象環境のアカウントにログインしてから実行します。
- 以下では環境を `<env>`（`dev` または `prod`）と書きます。
- リージョンは既定で `ap-northeast-1` です。変える場合は、CLI の実行時にも `HACCOLI_REGION` を設定します。

```bash
npm run admin -- -e <env> <command> [options]
```

- prod に対する変更操作では、実行前に確認を求められます。`-y` で省略できますが、通常は付けません。
- `user:purge` は dev でも必ず確認を求めます。
- 画面の URL（`WebUrl`）は、デプロイジョブのサマリーか、次のコマンドで確かめます。

```bash
aws cloudformation describe-stacks --stack-name Haccoli-<env> \
  --query "Stacks[0].Outputs[?OutputKey=='WebUrl'].OutputValue" --output text
```

---

## 2. 日々の運用

選考 1 件の流れは次のとおりです。

1. 候補者を登録する（2.1）
2. 課題を投入する（初回・変更時のみ。2.2）
3. 受験を発行し、候補者にログイン URL を連絡する（2.3）
4. 必要なら期限を延長する、または取り消す（2.4・2.5）
5. 提出後、採点者を割り当てる（2.6）
6. 採点結果を出力する（2.7）
7. 保持期間が過ぎたら個人データを削除する（2.8）

受験の状態は次のとおりです（詳細は [design.md §6.3](design.md#63-受験ステータス遷移)）。

| 状態          | 意味                             |
| ------------- | -------------------------------- |
| `NOT_STARTED` | 発行済み・未着手                 |
| `IN_PROGRESS` | 受験中（途中保存あり）           |
| `SUBMITTED`   | 提出済み・採点待ち               |
| `GRADING`     | 採点中（採点者が割り当て済み）   |
| `GRADED`      | 割り当てた採点者の全員が確定済み |
| `EXPIRED`     | 期限切れ（未提出）。採点の対象外 |
| `CANCELED`    | 管理者が取り消した。元に戻せない |

### 2.1 候補者・採点者を登録する

```bash
npm run admin -- -e <env> candidate:add --email cand@example.com --name "候補 太郎"
npm run admin -- -e <env> grader:add    --email grader@example.com --name "採点 花子"
npm run admin -- -e <env> candidate:list
npm run admin -- -e <env> grader:list
```

- メールアドレスの誤りに注意してください。存在しないアドレスに OTP を送るとバウンスになり、SES のバウンス率が上がります（3.3）。
- 採点者には、候補者の氏名は表示されますが、メールアドレスは表示されません。
- システムからは招待メールを送りません。ログイン URL は管理者が連絡します（2.3）。
- SES がサンドボックスの間（dev）は、受信者のアドレスも SES で検証しておく必要があります。

#### 無効化する

ログインできないようにします。データは残ります。

```bash
npm run admin -- -e <env> candidate:disable --email cand@example.com
npm run admin -- -e <env> grader:disable    --email grader@example.com
```

- 有効に戻すコマンドはありません。
- 無効化した採点者には、新しく割り当てられません。
- **採点者を無効化する前に、割り当て済みの採点がすべて確定していることを確かめます。** 受験が採点済み（`GRADED`）になるのは、割り当てた採点者の全員が確定したときです。割り当ての解除はできないため、未確定のまま無効化すると、別の採点者を追加しても受験は採点中（`GRADING`）のまま進みません。個人データの削除（2.8）もできなくなります。
- 未確定のまま無効化してしまった場合は、その採点者を一時的に有効に戻し（5 章）、確定してもらってから無効化し直します。

### 2.2 課題を投入する

課題は `exams/<examId>/` の `exam.json` と Markdown で管理します。変更はリポジトリで PR を通してから投入します。

```bash
# 検証だけ行う
npm run admin -- -e <env> exam:publish --dir exams/<examId> --dry-run
# 投入する（新しい版を作る。内容が同じなら何もしない）
npm run admin -- -e <env> exam:publish --dir exams/<examId>
npm run admin -- -e <env> exam:list
```

- 新しい版は、この後に発行する受験から使われます。発行済みの受験は、発行時の版のままです。
- prod に投入する前に、dev に投入して画面で確かめます。

### 2.3 受験を発行する

```bash
npm run admin -- -e <env> attempt:issue --email cand@example.com --exam <examId> --deadline 2026-12-31
```

- 期限は、指定した日の 23:59 JST です。
- 過去の日付は指定できません。当日を指定するときは `--force` を付けます。
- 発行したら、候補者に次の内容を連絡します。
  - ログイン URL: `<WebUrl>/login`
  - 登録したメールアドレスでログインし、届いたワンタイムパスコードを入力すること
  - 受験期限
- 採点者には `<WebUrl>/grader/login` を連絡します。

### 2.4 期限を延長する

```bash
npm run admin -- -e <env> attempt:list --status EXPIRED   # 受験 ID を調べる（期限前なら --status を付けずに探す）
npm run admin -- -e <env> attempt:extend --attempt <attemptId> --deadline 2027-01-10
```

- 期限切れ（`EXPIRED`）の受験も延長できます。着手していれば `IN_PROGRESS`、未着手なら `NOT_STARTED` に戻ります。保存済みの回答はそのまま残ります。
- 提出済み以降（`SUBMITTED`・`GRADING`・`GRADED`）と、取消済み（`CANCELED`）は延長できません。

### 2.5 受験を取り消す

辞退や、誤って発行した受験に使います。

```bash
npm run admin -- -e <env> attempt:cancel --attempt <attemptId>
```

- 取り消せるのは、期限前の `NOT_STARTED`・`IN_PROGRESS` だけです。期限切れの受験は、取り消さなくても採点の対象外です。
- 取り消すと、候補者の画面には「この受験は取り消されました。」と表示され、回答できなくなります。
- 元に戻せません。受験してもらう場合は、受験を発行し直します。
- 保存済みの回答は残ります。消すときは個人データの削除（2.8）を使います。

### 2.6 採点者を割り当てる

```bash
npm run admin -- -e <env> attempt:list --status SUBMITTED
npm run admin -- -e <env> attempt:assign --attempt <attemptId> --grader grader1@example.com grader2@example.com
```

- 複数の採点者を割り当てられます。割り当て済みの採点者は飛ばします。
- `EXPIRED`・`CANCELED` の受験には割り当てられません。
- 採点者の画面に表示されるのは、提出済みの受験だけです。
- 採点済み（`GRADED`）の受験に採点者を追加すると、採点中（`GRADING`）に戻ります。
- 割り当ての解除には対応していません。割り当てた採点者は全員が確定する必要があるため、割り当てる前に採点者の都合を確かめます。

#### 進み具合を確かめる

```bash
npm run admin -- -e <env> attempt:list
npm run admin -- -e <env> attempt:list --status GRADING
```

期限切れの受験は、期限処理のバッチ（1 時間ごと）の前でも `EXPIRED` と表示されます。

### 2.7 採点結果を出力する

```bash
npm run admin -- -e <env> result:export --exam <examId> --out results.csv
```

- 受験 × 採点者ごとに 1 行で、問題ごとの点数とコメントを出力します。
- 候補者の氏名・メールアドレスを含みます。ファイルは本人だけが読める権限（600）で作られます。
- 共有するときは社内の決められた場所に置き、手元のファイルは用が済んだら削除します。リポジトリには置きません（コミットしない）。

### 2.8 個人データを削除する

選考が終わり、保持期間（[design.md §11.2 Q7](design.md#112-要確認実装は仮置きで進行可能)）が過ぎた候補者のデータを削除します。

```bash
npm run admin -- -e <env> user:purge --email cand@example.com
```

- 削除するもの
  - 受験・回答・割り当て・採点（DynamoDB）
  - 提出ファイル（S3。旧版と削除マーカーを含む全バージョン）
  - Cognito のユーザーと、候補者のプロフィール
- 対象は候補者だけです。採点者は無効化（2.1）します。
- 採点が終わっていない受験（`NOT_STARTED`・`IN_PROGRESS`・`SUBMITTED`・`GRADING`）があると拒否します。先に取り消すか、採点を確定してもらいます。
- 削除の前に、受験ごとの件数を表示して確認を求めます。内容を確かめてから `yes` と答えます。
- 元に戻せません。必要な採点結果は、先に出力しておきます（2.7）。
- 途中で失敗した場合は、同じコマンドを再実行すると残りを削除できます。「削除の対象が変わりました」と出た場合も、状況を確かめてから再実行します。
- 削除の記録（誰の、いつ）は、社内の台帳に残します。CLI は監査ログを残しません（5 章）。

---

## 3. アラームへの対応

prod には次の 4 つのアラームがあります。発生時と復旧時に、`HACCOLI_ALARM_EMAIL` のアドレスへ SNS からメールが届きます。dev にはアラームがないので、CloudWatch Logs で確かめます。

| アラーム                          | 条件                                       | 影響                                          |
| --------------------------------- | ------------------------------------------ | --------------------------------------------- |
| `haccoli-prod-api-5xx`            | API の 5xx が 5 分間に 1 件以上            | 候補者が受験・提出できない可能性              |
| `haccoli-prod-api-lambda-errors`  | API の Lambda のエラーが 5 分間に 1 件以上 | 同上（例外・タイムアウト）                    |
| `haccoli-prod-ses-bounce-rate`    | SES のバウンス率が 4% 以上                 | 5% で審査、10% で送信停止（全員ログイン不可） |
| `haccoli-prod-ses-complaint-rate` | SES の苦情率が 0.08% 以上                  | 0.1% で審査、0.5% で送信停止                  |

### 3.1 共通

1. 通知メールのアラーム名と時刻を確かめます。
2. 同じ時間帯に受験中の候補者がいるか、`attempt:list --status IN_PROGRESS` で確かめます。期限が迫っている候補者がいれば、必要に応じて期限を延長します（2.4）。
3. 復旧（OK）の通知が届くまで、対応の経過を記録します。

### 3.2 API 5xx・Lambda エラー

API の 1 回の失敗で、2 つのアラームが同時に鳴ることがあります。まとめて 1 件として対応します。

1. API の Lambda のロググループを調べます。

   ```bash
   fn=$(aws cloudformation describe-stacks --stack-name Haccoli-prod \
     --query "Stacks[0].Outputs[?OutputKey=='ApiFunctionName'].OutputValue" --output text)
   aws lambda get-function-configuration --function-name "$fn" \
     --query LoggingConfig.LogGroup --output text
   ```

2. CloudWatch Logs Insights で、そのロググループに次のクエリを実行します（期間はアラームの前後 30 分）。

   ```
   fields @timestamp, level, message
   | filter level = "ERROR" or message like /"status":5\d\d/ or @message like /"status":"timeout"/
   | sort @timestamp desc
   | limit 100
   ```

   - `level` が `ERROR` の行（`"msg":"unhandled"`）に、例外の名前とメッセージがあります。
   - `"msg":"request"` の行で、失敗したルート（`route`）と利用者（`sub`）がわかります。
   - `"status":"timeout"` は Lambda のタイムアウトです（`platform.report` の行）。

3. 原因に応じて対応します。

   | 原因の例                                         | 対応                                                                                                                                                                                  |
   | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | 直前のデプロイで入った不具合                     | `develop` で該当のコミットを revert する PR を作ってマージし、`develop` → `main` の PR で prod に反映する（4.5）。急ぐ場合も `main` だけを戻さず、同じ revert を `develop` にも入れる |
   | DynamoDB・S3・Cognito のスロットリングや一時障害 | AWS Health Dashboard を確かめる。一時的なものなら復旧を待つ                                                                                                                           |
   | 特定のデータでだけ失敗する                       | 該当の受験 ID を控え、Issue（label `fix`）を作って調べる                                                                                                                              |

4. 候補者が提出できなかった場合は、復旧後に期限を延長して連絡します。

### 3.3 SES バウンス率

存在しないアドレスや、受信を拒否するアドレスに OTP を送ると上がります。

1. アカウントの状態を確かめます。`EnforcementStatus` が `HEALTHY` 以外なら、送信が制限されています。

   ```bash
   aws sesv2 get-account --query '{Sending:SendingEnabled,Status:EnforcementStatus,Production:ProductionAccessEnabled}'
   ```

2. バウンスしたアドレスを調べます。アカウントのサプレッションリストに載ります。

   ```bash
   aws sesv2 list-suppressed-destinations --reasons BOUNCE
   ```

3. 登録ミスのアドレスであれば、誤ったアドレスの受験を取り消し（2.5）、その候補者の個人データを削除します（2.8）。そのうえで、正しいアドレスで登録し直して受験を発行し直します。
   - 無効化だけでは、発行済みの受験が未着手のまま残ります。
4. バウンス率は過去の送信をもとに算出されるため、下がるまでに時間がかかります。新しい登録で同じ誤りを繰り返さないようにします。
5. 審査（`PROBATION`）や停止（`SHUTDOWN`）になった場合は、SES コンソールの「評価ダッシュボード」から原因と対策を AWS に連絡します。

### 3.4 SES 苦情率

受信者が OTP メールを迷惑メールとして報告すると上がります。

1. 3.3 の手順 1 でアカウントの状態を確かめます。
2. 苦情を出したアドレスを調べます。

   ```bash
   aws sesv2 list-suppressed-destinations --reasons COMPLAINT
   ```

3. 該当の候補者に心当たりがないか確かめます。不要になった候補者は無効化します。
4. 苦情が続く場合は、送信元の表示名（`fromName`）と件名がわかりやすいか見直します。

---

## 4. prod の構築

prod は dev とは別の AWS アカウントに作ります。初回に 1 回だけ、管理者がローカルで行います。

### 4.0 始める前に決めること

| 項目                   | 状況（2026-11-27 時点） |
| ---------------------- | ----------------------- |
| prod の AWS アカウント | 未確認                  |
| 送信元メールドメイン   | 未定                    |
| アラームの通知先       | 決定済み                |

送信元ドメインを使う場合は、`HACCOLI_FROM_EMAIL` をそのドメイン配下のアドレスにし、ドメインを `HACCOLI_SES_VERIFIED_DOMAIN` で渡します（4.4）。ドメインが一致しないとデプロイが失敗します。

### 4.1 SES の送信元ドメインを認証する

1. prod のアカウントで、ドメインを SES の ID として作ります（Easy DKIM）。

   ```bash
   aws sesv2 create-email-identity --email-identity recruit.example.co.jp
   aws sesv2 get-email-identity --email-identity recruit.example.co.jp \
     --query 'DkimAttributes.Tokens' --output text
   ```

2. 返ってきた 3 つのトークンごとに、ドメインの DNS に CNAME を登録します。

   | 名前                                       | 値                           |
   | ------------------------------------------ | ---------------------------- |
   | `<token>._domainkey.recruit.example.co.jp` | `<token>.dkim.amazonses.com` |

3. 認証の完了を確かめます（DNS の反映に最大 72 時間かかります）。

   ```bash
   aws sesv2 get-email-identity --email-identity recruit.example.co.jp \
     --query '{Verified:VerifiedForSendingStatus,Dkim:DkimAttributes.Status}'
   ```

   `Verified` が `true`、`Dkim` が `SUCCESS` になれば完了です。

4. 届きやすくするため、ドメインの SPF と DMARC のレコードも、ドメインの管理者と相談して設定します。

### 4.2 SES の本番利用を申請する

新しいアカウントの SES はサンドボックスで、検証したアドレスにしか送れません。

1. SES コンソールの「アカウントダッシュボード」から本番アクセスを申請します。
   - メールの種類: トランザクション
   - 用途: 採用候補者・採点者へのログイン用ワンタイムパスコード。送信先は管理者が事前登録した人だけ（セルフサインアップなし）
   - 想定の送信数: 月 1,000 通未満（[design.md §10.1](design.md#101-概算コスト月間候補者数十数百名想定)）
   - バウンス・苦情への対応: CloudWatch アラームで監視し、サプレッションリストを確かめる（3.3・3.4）
2. 承認を確かめます。`ProductionAccessEnabled` が `true` になれば完了です。

   ```bash
   aws sesv2 get-account --query ProductionAccessEnabled
   ```

### 4.3 CDK のブートストラップと GitHub 用のデプロイロール

```bash
npm ci
npm run cdk -- bootstrap aws://<PROD_ACCOUNT_ID>/ap-northeast-1   # 別のリージョンにする場合は、そのリージョンを指定し HACCOLI_REGION も設定する
npm run cdk -- deploy Haccoli-ci-prod -c env=prod -c ci=true
# 出力 DeployRoleArn を控える
```

### 4.4 GitHub の Environment を設定する

リポジトリの Settings → Environments に `prod` を作り、次を設定します。

| 種別                | 名前                          | 値                                                                               |
| ------------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| Variable            | `AWS_ROLE_ARN`                | 4.3 の `DeployRoleArn`                                                           |
| Variable            | `HACCOLI_FROM_EMAIL`          | 送信元アドレス（4.1 のドメイン配下。例: `no-reply@recruit.example.co.jp`）       |
| Variable            | `HACCOLI_SES_VERIFIED_DOMAIN` | 4.1 のドメイン（例: `recruit.example.co.jp`）                                    |
| Variable            | `HACCOLI_ALARM_EMAIL`         | アラームの通知先                                                                 |
| Variable（任意）    | `HACCOLI_REGION`              | 既定 `ap-northeast-1`。変える場合は 4.3 のブートストラップも同じリージョンで行う |
| Deployment branches | —                             | `main` のみ                                                                      |
| Required reviewers  | —                             | 管理者を設定する                                                                 |

### 4.5 デプロイする

`develop` から `main` への PR をマージすると、prod にデプロイされます。Required reviewers を設定した場合は、Actions の画面でデプロイを承認します。

### 4.6 アラームの通知先を承認する

1. 初回のデプロイ後、`HACCOLI_ALARM_EMAIL` に SNS の確認メール（AWS Notification - Subscription Confirmation）が届きます。本文のリンクを開いて承認します。承認するまで通知は届きません。
2. 承認を確かめます。`SubscriptionArn` が `PendingConfirmation` でなければ完了です。

   ```bash
   aws sns list-subscriptions --query "Subscriptions[?Protocol=='email']"
   ```

3. アラームを一時的に発生状態にして、通知が届くことを確かめます。数分後に実際の値で再評価され、OK に戻ります。

   ```bash
   aws cloudwatch set-alarm-state --alarm-name haccoli-prod-api-5xx \
     --state-value ALARM --state-reason "通知の確認"
   ```

   発生時のメールが届けば完了です。復旧時のメールも届くことを確かめます。

通知先を変えるときは、`HACCOLI_ALARM_EMAIL` を変えて再デプロイし、新しいアドレスで確認メールを承認します。

### 4.7 動作を確かめる

1. 採点者を 1 名、確認用の候補者を 1 名登録します（2.1）。
2. 課題を投入し、確認用の候補者に受験を発行します（2.2・2.3）。
3. 候補者として `<WebUrl>/login` からログインし、OTP メールが送信元ドメインから届くこと、回答・提出ができることを確かめます。
4. 採点者を割り当て、`<WebUrl>/grader/login` から採点・確定できることを確かめます（2.6）。
5. 確認用のデータを削除します。

   ```bash
   npm run admin -- -e prod user:purge --email <確認用の候補者>
   ```

   確認のためだけに登録した採点者は、`grader:disable` で無効化します。

---

## 5. MVP で未対応の運用

次の機能は後続フェーズで対応します（[design.md §8](design.md#8-管理-cli)）。

| 機能                               | 当面の運用                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `candidate:import`（CSV 一括登録） | `candidate:add` を 1 人ずつ実行する                                                                                                                                                        |
| CLI の監査ログ（DynamoDB）         | Cognito の操作（登録・無効化・削除）は CloudTrail のイベント履歴（90 日）に残る。DynamoDB・S3 のデータ操作は既定では残らないため、受験の発行・取消・個人データの削除などは社内の台帳に残す |
| 採点者の割り当ての解除             | 解除できない。割り当てた採点者に確定してもらう。採点者を無効化した後なら、一時的に有効に戻して確定してもらう（2.1）                                                                        |
| 無効化したユーザーを有効に戻す     | 有効に戻す必要がある場合は、AWS コンソールの Cognito でユーザーを有効化し、DynamoDB のプロフィールの `disabled` を `false` に戻す                                                          |
