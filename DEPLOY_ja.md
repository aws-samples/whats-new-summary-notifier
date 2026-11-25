# デプロイガイド

## クイックデプロイ（推奨）

[AWS CloudShell](https://console.aws.amazon.com/cloudshell/home) を使用してデプロイします。ローカル環境のセットアップは不要です。

### 1. Webhook URL の取得

#### Slack の場合
[Slack ワークフロードキュメント](https://slack.com/intl/ja-jp/help/articles/360041352714)を参考に Webhook URL を取得してください。テキスト型の変数を 5 つ作成します: `rss_time`, `rss_link`, `rss_title`, `summary`, `detail`

#### Microsoft Teams の場合
Microsoft は 2026 年 5 月に Teams の Office 365 コネクタ（コネクタで作る Incoming Webhook を含む）を廃止しました。代わりに Workflows アプリで Webhook を作ります（[Create an Incoming Webhook](https://learn.microsoft.com/ja-jp/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook)、[Send messages in Teams using incoming webhooks](https://support.microsoft.com/en-us/office/send-messages-in-teams-using-incoming-webhooks-323660ec-12ca-40b1-a1d3-a3df47e808c4)）。

1. Teams で通知先のチャネルを開き、チャネル名の横の **その他のオプション（...）** から **ワークフロー** を選びます。
2. テンプレート **Send webhook alerts to a channel** を選びます（日本語の画面では訳された名前で表示されます）。通知の Lambda はサインインのトークンを送らないので、「from specific people」「from people in an org」のテンプレートでは動きません。
3. チームとチャネルを選んで **保存** し、ワークフローの詳細ページに出る Webhook URL をコピーします。

投稿は Workflows のボットの名前で表示されます。URL を知っていれば誰でもチャネルに投稿できるので、URL は共有しないでください。ワークフローは作った人のものになるので、その人が退職や異動をしても動き続けるように共同所有者を足しておくと安心です。

以前にコネクタの URL でデプロイした場合、その URL はもう使えません。上の手順でワークフローを作り、その URL を同じ SSM パラメータ（`/WhatsNew/URL` または `/WhatsNew/URL/<テナント名>`）に入れてください。Systems Manager の Parameter Store でパラメータを編集するか、`bash deploy.sh` をもう一度実行します。通知の Lambda は記事ごとにパラメータを読むので、再デプロイしなくても新しい URL が使われます。

#### Google Chat の場合（preview）
Google Chat への通知は preview の機能で、実際の Google Chat スペースでの動作はまだ確認していません。[Google Chat の受信 Webhook のドキュメント](https://developers.google.com/workspace/chat/quickstart/webhooks)を参考に、スペースで Webhook を登録し（アプリと統合 > Webhook を追加）、URL をコピーしてください。Google Workspace の組織で受信 Webhook が許可されている必要があります。URL にはトークンが含まれるので共有しないでください。

### 2. デプロイ

[CloudShell](https://console.aws.amazon.com/cloudshell/home) を開き、以下を実行します:

```bash
git clone https://github.com/aws-samples/whats-new-summary-notifier.git
cd whats-new-summary-notifier
bash deploy.sh
```

対話ウィザードが通知先、言語、Webhook URL を順に質問します。デプロイは AWS CodeBuild 経由で実行されるため、Docker や Node.js のセットアップは自動で行われます。

#### 非対話モード

```bash
bash deploy.sh --non-interactive \
  --webhook-url "https://hooks.slack.com/..." \
  --destination slack \
  --language japanese
```

## マルチテナントデプロイ

`--tenant` オプションで完全に分離されたスタックをデプロイできます。本番環境に影響を与えずにテスト環境を構築する際に便利です。

```bash
bash deploy.sh --tenant test \
  --webhook-url "https://hooks.slack.com/..." \
  --destination slack \
  --language japanese \
  --non-interactive
```

### 設定ファイルの利用

テナントごとの設定を `tenants/` ディレクトリに JSON ファイルとして管理できます。

```bash
cp tenants/test.example.json tenants/myteam.json
```

```json
{
  "tenant": "myteam",
  "notifiers": {
    "AwsWhatsNew": {
      "destination": "slack",
      "summarizerName": "AwsSolutionsArchitectJapanese",
      "webhookUrlParameterName": "/WhatsNew/URL/myteam",
      "rssUrl": { "What's new": "https://aws.amazon.com/about-aws/whats-new/recent/feed/" }
    }
  }
}
```

設定ファイルを指定してデプロイ:

```bash
bash deploy.sh --config tenants/myteam.json --webhook-url "https://..."
```

CDK を直接使う場合:

```bash
cdk deploy -c config=tenants/myteam.json
```

**設定の優先順位**: 設定ファイルの値は `cdk.json` のデフォルト値を**上書き**します。設定ファイルにはテナント固有の差分のみ記載すれば OK です。

| リソース | 本番 | テスト (`--tenant test`) |
|---|---|---|
| スタック名 | `WhatsNewSummaryNotifierStack` | `WhatsNewSummaryNotifier-test` |
| DynamoDB テーブル | 別テーブル | 別テーブル |
| Lambda 関数 | 別関数 | 別関数 |
| EventBridge ルール | 別ルール | 別ルール |
| SSM パラメータ | `/WhatsNew/URL` | `/WhatsNew/URL/test` |

## Management Console からのデプロイ

GUI ベースのデプロイには [Management Console](CONSOLE_ja.md) を使用できます:

```bash
npm run dev:console
```

Management Console では、ビジュアル設定エディタ、Bedrock モデルのサジェスト、リアルタイムビルド監視を備えたテナントのデプロイ・更新・削除が可能です。ローカルのソースコードからデプロイするため、GitHub への push は不要です。

## 手動デプロイ（上級者向け）

CodeBuild を使わずローカル環境からデプロイする場合。

**前提条件:** Node.js 22+, Docker, [AWS CDK CLI](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html)

```bash
npm install
cdk bootstrap   # 初回のみ
cdk synth        # 検証
cdk deploy
```

マルチテナント: `cdk deploy -c tenant=test`

## 設定リファレンス

設定は `cdk.json` の `context` で管理します。

### 共通設定
| キー | 説明 |
|---|---|
| `modelRegion` | Bedrock API 呼び出しのソースリージョン（デフォルト: `us-east-1`） |
| `modelIds` | フォールバック順に試行されるモデル ID の配列 |

### summarizers
| キー | 説明 |
|---|---|
| `outputLanguage` | 要約の出力言語 |
| `persona` | モデルに与える役割（ペルソナ） |

### notifiers
| キー | 説明 |
|---|---|
| `destination` | `slack`、`teams`、`googlechat` のいずれか（Google Chat は preview で、実際のスペースでは未確認） |
| `summarizerName` | 使用する summarizer の名前 |
| `webhookUrlParameterName` | Webhook URL を格納する SSM Parameter Store 名 |
| `rssUrl` | RSS フィード URL（複数指定可） |
| `schedule` | （オプション）RSS 取得の CRON スケジュール |
| `filter` | （オプション）通知する記事の絞り込み。下を参照 |

**スケジュール例**（15 分ごと）:
```json
"schedule": { "minute": "0/15", "hour": "*", "day": "*", "month": "*", "year": "*" }
```

### 記事の絞り込み（オプション）
`filter` を書かなければ、これまでどおり新着記事をすべて要約して通知します。notifier に `filter` を足すと、通知する記事を絞り込めます。

```json
"filter": {
  "categories": ["general:products/amazon-bedrock", "marketing:marchitecture/artificial-intelligence"],
  "topics": ["生成 AI を使ったアプリケーション開発"],
  "modelIds": ["global.anthropic.claude-haiku-5-5"]
}
```

| キー | 説明 |
|---|---|
| `categories` | （オプション）RSS のカテゴリタグ。記事のタグのどれかが値と同じか、値に `/` を続けた文字列で始まるときに残します（`general:products` なら製品のタグすべて）。大文字と小文字は区別しません。タグの無い記事は残します。クローラーが判定し、Bedrock は呼びません |
| `topics` | （オプション）話題を文で書いた一覧。要約の前に、要約する文（記事の本文、または RSS の説明文。「記事本文の取得」を参照）がどれかの話題に関係するかをモデルに判定させ、はっきり「関係しない」と答えた記事だけを飛ばします（`summary_status` は `filtered`）。判定に失敗したときや答えがはっきりしないときは通知します |
| `modelIds` | （オプション）`topics` の判定に使うモデル（順に試します）。省略すると `modelIds` を使います。小さいモデルにすると追加の費用を抑えられます |

`topics` の判定は、`categories` を通った記事 1 件につき Bedrock の呼び出しが 1 回増えます。あとで `filter` を変えたり外したりしても、それまでに外した記事がまとめて通知されることはありません。`filter` の形が誤っているときや、設定が Lambda の環境変数（4 KB）や EventBridge のターゲット入力（8,192 文字）に収まらないときは、`cdk synth` がメッセージを出して止まります。

### 記事本文の取得
通知 Lambda は RSS の各記事の URL を開き、`<main>`、なければ `<article>`、なければ `<body>` の文字（ナビゲーション、ヘッダー、フッター、スクリプトは除く）を 50,000 字まで要約します。ページを取得できないときや本文が 200 字に満たないときは、RSS の説明文（description）を要約します。どちらも無いときは投稿せず、項目の `summary_status` を `failed` にします。DynamoDB の項目の `summary_source` に、どちらを使ったかが入ります。

リクエストは `whats-new-summary-notifier` の User-Agent を付け、公開の `http`/`https` のアドレスにだけ送ります（リダイレクトのたびに確認し、5 回まで）。タイムアウトは 10 秒、ダウンロード全体の上限は 20 秒、大きさの上限は 5 MB です。

### 通知できなかったとき
投稿の前の失敗のうち、次の回には起きないかもしれないもの（Bedrock のスロットリングや 5xx エラー、Webhook が 429 や 5xx を返す、接続できない、タイムアウト）では、通知 Lambda はエラーで終わり、Lambda がその記事を 2 回まで再試行します。ストリームで 6 時間を超えて待った記事は再試行しません。

それ以外の失敗（要約する文が無い、Webhook の 4xx、モデルを使う権限が無い）は、DynamoDB の項目に `summary_status` = `failed` と `failure_reason` を書き、再試行しません。Webhook に要求を送ったのに 10 秒以内に答えが返らなかったときも、すでに投稿されているかもしれないので `failed` にします。再試行で同じ記事を 2 回投稿することはありません。

再試行しても失敗したときは、失敗したストリームの記録についてのメッセージ（記事そのものは含まない）を名前に `NotifyFailureQueue` を含む SQS キューに送ります。キューはメッセージを 14 日間保持します。スタックは CloudWatch アラームを 2 つ作ります。1 つはこのキューにメッセージがあるとき、もう 1 つは通知 Lambda がストリームから 30 分を超えて遅れたとき（`IteratorAge`）に鳴ります。`alarms` を設定しない限り、アラームにアクションはありません（「アラームの通知」を参照）。投稿されなかった記事は、`summary_status` が `failed` の項目と、`filter_result` の無い項目のうち `summary_status` が無いものです。

### アラームの通知（オプション）
`alarms` を書かなければ、スタックの CloudWatch アラームにアクションは無く、ALARM になっても誰にも知らされません。`cdk.json`（またはテナントの設定ファイル）に `alarms` を足すと、スタックのどのアラームが ALARM になったときも、OK に戻ったときも、メールか自分の SNS トピックに知らせます。

```json
"alarms": { "email": "ops@example.com" }
```

```json
"alarms": { "topicArn": "arn:aws:sns:us-east-1:<アカウント ID>:my-alarm-topic" }
```

| キー | 説明 |
|---|---|
| `email` | スタックが SNS トピックと、そのトピックへのメールの購読を作ります。トピックは TLS での要求だけを受け付け、このアカウントの CloudWatch アラームだけが発行できます。保存時の暗号化はしません。CloudWatch アラームは AWS 管理キー `alias/aws/sns` で暗号化したトピックに発行できず、通知の中身はアラーム名、状態、しきい値だけです |
| `topicArn` | スタックと同じリージョンにある既存の SNS 標準トピック（Amazon Q Developer in chat applications で Slack に流すトピックなど）。スタックはアラームのアクションに足すだけで、トピックとそのポリシーは変えないので、トピックポリシーで `cloudwatch.amazonaws.com` に発行を許してください。カスタマー管理キーで暗号化したトピックはこちらを使います。キーポリシーで `cloudwatch.amazonaws.com` に `kms:Decrypt` と `kms:GenerateDataKey*` も許してください |

どちらか 1 つだけを書きます。値の形が違うとき、トピックが別のリージョンにあるときは、`cdk synth` がメッセージを出して止まります。`alarms` が効くのは自分で `cdk deploy` を実行したときで、`deploy.sh` と Management Console はこの値を渡しません。

- **購読を確認する。** デプロイのあと、SNS がそのアドレスに確認のメールを送ります。メールのリンクを押すまで何も届きません（迷惑メールのフォルダも見てください）。48 時間以内に確認されない購読は SNS が消します。同じアドレスのまま再デプロイしても、スタックの購読のリソースは変わらないので確認のメールは送り直されません。`email` を一度別の値にして（または消して）デプロイし、戻してもう一度デプロイするか、SNS のコンソールで同じアドレスを購読し直してください（その購読はスタックの外のものになります）。
- **試す。** 確認のあと、`aws cloudwatch set-alarm-state --alarm-name <アラーム名> --state-value ALARM --state-reason test` で通知が 1 通届きます。アラームは次の評価で本来の状態に戻ります。
- **手で付けたアクション。** `alarms` を書かなければ、更新で既存のアラームは変わらないので、CloudWatch のコンソールで手で付けたアクションは残ります。`alarms` を書くと、CloudFormation がアラームをスタックのアクションだけで書き直すので、手で付けたアクションは消えます。そのトピックを `topicArn` に書いてください。
- **公開した fork にメールアドレスをコミットしない。** `alarms` はコミットしないテナントの設定ファイルに書くか（`cdk deploy -c config=tenants/myteam.json`）、コマンドラインで渡してください（`cdk deploy -c alarms='{"email":"ops@example.com"}'`）。

## スタックの削除

```bash
bash deploy.sh --destroy                # デフォルトスタック
bash deploy.sh --destroy --tenant test  # 特定テナント
```

スクリプトは CodeBuild のビルドで CDK スタックを削除し、そのビルドの終了を待ちます。ビルドが成功すると、CodeBuild プロジェクト、IAM ロール、SSM パラメータを削除します。ビルドが失敗した場合はこれらを残してエラーで終了するので、ビルドログを確認してから同じコマンドをもう一度実行してください。

ビルドの終了を待っている間にスクリプトが止まると（Ctrl+C、ターミナルを閉じた、CloudShell のセッションが切れたなど）、ビルドは CodeBuild で動き続けますが、片付けは実行されないので、CodeBuild プロジェクト、IAM ロール、SSM パラメータが残ります。同じ `deploy.sh --destroy` のコマンドをもう一度実行してください。もう一度 destroy のビルドが動き（スタックがすでに消えていても成功します）、そのあとで 3 つを削除します。

手動削除: `cdk destroy` または `cdk destroy -c tenant=test`

### 削除のあとに残るもの

スタックを削除しても、次のリソースはアカウントとリージョンに残ります。

| リソース | 名前 | 残る理由 |
|---|---|---|
| DynamoDB テーブル（RSS の履歴） | `<スタック名>-WhatsNewRSSHistory...` | テーブルは CDK の既定の削除ポリシー `RETAIN` のままなので、CloudFormation が削除を飛ばします（`DELETE_SKIPPED`） |
| Lambda のロググループ（3 つ） | `/aws/lambda/<スタック名>-NotifyNewEntry...`、`-newsCrawler...`、`-LogRetention...` | 関数に `logRetention` を設定しているため、CDK はロググループをスタックの外で作ります。スタックと一緒には消えません |
| CodeBuild のロググループ | `/aws/codebuild/whats-new-summary-notifier[-<テナント名>]` | CodeBuild が作ります。`deploy.sh` はプロジェクトを消しますが、ログは消しません |
| CDKToolkit スタックとその資産バケット | `CDKToolkit`、`cdk-hnb659fds-assets-<アカウント ID>-<リージョン>` | `cdk bootstrap` が作り、同じアカウントとリージョンのすべての CDK アプリが共有します。CDKToolkit を削除してもバケットは残ります（`DELETE_SKIPPED`） |

`<スタック名>` は `WhatsNewSummaryNotifierStack`、テナントなら `WhatsNewSummaryNotifier-<テナント名>` です（ロググループの名前では長い名前が途中で切られます）。削除する場合は、destroy が終わってから次のように実行します。

```bash
# DynamoDB テーブル（保存した記事と要約が消えます）
aws dynamodb list-tables --query "TableNames[?contains(@, 'WhatsNewRSSHistory')]"
aws dynamodb delete-table --table-name <テーブル名>

# ロググループ
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/WhatsNewSummaryNotifier --query 'logGroups[].logGroupName'
aws logs describe-log-groups --log-group-name-prefix /aws/codebuild/whats-new-summary-notifier --query 'logGroups[].logGroupName'
aws logs delete-log-group --log-group-name <ロググループ名>
```

CDKToolkit は、同じアカウントとリージョンでほかの CDK アプリが使っていないときだけ削除してください。資産バケットはバージョニングが有効なので、オブジェクトのすべてのバージョンと削除マーカーを消してからバケットを削除します（S3 コンソールの「空にする」を使ってから削除するなど）。ほかのテナントやスタックのテーブルやロググループも同じ接頭辞に当たることがあるので、削除する前に名前を 1 つずつ確かめてください。
