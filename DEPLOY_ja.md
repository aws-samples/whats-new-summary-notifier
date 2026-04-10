# デプロイガイド

## クイックデプロイ（推奨）

[AWS CloudShell](https://console.aws.amazon.com/cloudshell/home) を使用してデプロイします。ローカル環境のセットアップは不要です。

### 1. Webhook URL の取得

#### Slack の場合
[Slack ワークフロードキュメント](https://slack.com/intl/ja-jp/help/articles/360041352714)を参考に Webhook URL を取得してください。テキスト型の変数を 5 つ作成します: `rss_time`, `rss_link`, `rss_title`, `summary`, `detail`

#### Microsoft Teams の場合
[Teams Incoming Webhook ドキュメント](https://learn.microsoft.com/ja-jp/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook?tabs=newteams%2Cdotnet)を参考に Webhook URL を取得してください。

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
| `destination` | `slack` または `teams` |
| `summarizerName` | 使用する summarizer の名前 |
| `webhookUrlParameterName` | Webhook URL を格納する SSM Parameter Store 名 |
| `rssUrl` | RSS フィード URL（複数指定可） |
| `schedule` | （オプション）RSS 取得の CRON スケジュール |

**スケジュール例**（15 分ごと）:
```json
"schedule": { "minute": "0/15", "hour": "*", "day": "*", "month": "*", "year": "*" }
```

## スタックの削除

```bash
bash deploy.sh --destroy                # デフォルトスタック
bash deploy.sh --destroy --tenant test  # 特定テナント
```

CDK スタック、CodeBuild プロジェクト、IAM ロール、SSM パラメータが自動的にクリーンアップされます。

手動削除: `cdk destroy` または `cdk destroy -c tenant=test`
