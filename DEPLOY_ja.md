# デプロイガイド

## クイックデプロイ（推奨）

[AWS CloudShell](https://console.aws.amazon.com/cloudshell/home) を使用してデプロイします。ローカル環境のセットアップは不要です。

### 1. Webhook URL の取得

#### Slack の場合
[Slack ワークフロードキュメント](https://slack.com/intl/ja-jp/help/articles/360041352714)を参考に Webhook URL を取得してください。テキスト型の変数を 5 つ作成します: `rss_time`, `rss_link`, `rss_title`, `summary`, `detail`

#### Microsoft Teams の場合
[Teams Incoming Webhook ドキュメント](https://learn.microsoft.com/ja-jp/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook?tabs=newteams%2Cdotnet)を参考に Webhook URL を取得してください。

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
通知 Lambda は RSS の各記事の URL を開き、`<main>`、なければ `<article>`、なければ `<body>` の文字（ナビゲーション、ヘッダー、フッター、スクリプトは除く）を 50,000 字まで要約します。ページを取得できないときや本文が 200 字に満たないときは、RSS の説明文（description）を要約します。どちらも無いときだけ記事を飛ばします。DynamoDB の項目の `summary_source` に、どちらを使ったかが入ります。

リクエストは `whats-new-summary-notifier` の User-Agent を付け、公開の `http`/`https` のアドレスにだけ送ります（リダイレクトのたびに確認し、5 回まで）。タイムアウトは 10 秒、ダウンロード全体の上限は 20 秒、大きさの上限は 5 MB です。

## スタックの削除

```bash
bash deploy.sh --destroy                # デフォルトスタック
bash deploy.sh --destroy --tenant test  # 特定テナント
```

スクリプトは CodeBuild のビルドで CDK スタックを削除し、そのビルドの終了を待ちます。ビルドが成功すると、CodeBuild プロジェクト、IAM ロール、SSM パラメータを削除します。ビルドが失敗した場合はこれらを残してエラーで終了するので、ビルドログを確認してから同じコマンドをもう一度実行してください。

手動削除: `cdk destroy` または `cdk destroy -c tenant=test`
