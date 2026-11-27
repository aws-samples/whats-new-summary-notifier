# プロダクト概要

Whats New Summary Notifier は、AWS What's New などの Web 記事の RSS フィードを定期的にクロールし、Amazon Bedrock で記事内容を要約して Slack、Microsoft Teams、Google Chat（preview）に通知する生成 AI アプリケーション。

## 主要機能
- RSS フィードの定期クロール（EventBridge スケジュール）
- 新着記事の DynamoDB への記録（重複排除付き）
- DynamoDB Streams トリガーによる記事本文の取得・要約・通知（`<main>` → `<article>` → `<body>` の順に本文を探し、取れないときは RSS の説明文で要約。取得先は公開の http(s) のアドレスだけで、タイムアウトとサイズの上限付き）
- 要約結果の DynamoDB への書き戻し（summary, detail, summary_status）
- Slack / Microsoft Teams / Google Chat（preview、実機未確認）対応（Webhook 経由。Teams は Workflows アプリの Webhook に Adaptive Card を送る。Office 365 コネクタの Incoming Webhook は 2026 年 5 月に廃止）
- 任意の記事の絞り込み（notifier の `filter`。`categories` はクローラーがタグで判定、`topics` は要約前に Bedrock で判定。書かなければ全記事を通知）
- 要約言語・ペルソナのカスタマイズ（cdk.json の summarizers で設定）
- モデルフォールバック: 複数モデル ID を順に試行し、失敗時は次のモデルへ自動切替
- 失敗の扱い: `summary_status` は投稿のあとに `completed`、絞り込みで外すと `filtered`、再試行しても直らない失敗（本文も RSS の説明文も無い、Webhook の 4xx、Bedrock の権限なしなど）は `failed` と `failure_reason`。投稿の前の一時的な失敗（Bedrock のスロットリングと 5xx、Webhook の 429 と 5xx、接続できない、タイムアウト）だけを例外にし、イベントソースが 2 回まで再試行する（記録の最大の古さ 6 時間。回数はスタックの定数 `NOTIFY_RETRY_ATTEMPTS` から、イベントソースと通知 Lambda の環境変数 `NOTIFY_MAX_ATTEMPTS` の両方に渡す）。通知 Lambda は起動のたびに `notify_attempts` を 1 足す UpdateItem（`attribute_exists` 付き、`ReturnValues=ALL_NEW`）で項目を読み、項目が無いか `summary_status` があれば何もしない（重複配信で 2 回投稿しない）。要約は投稿の前に Map 型の `pending` 属性（summary、detail、summary_source、model_id、latency_sec、input_tokens、output_tokens。条件 `attribute_exists(url) AND attribute_not_exists(summary_status)`、失敗しても投稿は続ける）に保存し、`pending` のある記録は本文の取得・判定・要約を飛ばしてその要約で投稿する。`completed` の書き込みで `pending` を REMOVE する。最後の試行の一時的な失敗は `failed` と `retries exhausted:` で始まる `failure_reason` を書いてから例外にする。通知 Lambda の書き込みはすべて `attribute_exists(url)` 付きで、消えた項目を作り直さない。それでも失敗した記録はメタデータが SQS の失敗キュー（14 日保持）に入る。Webhook に要求を送ったあとの失敗は 2 回投稿しないよう再試行しない。Webhook の投稿は 10 秒でタイムアウト
- イベントソースのフィルタで INSERT だけを通知 Lambda に渡し、クローラーは「まだ無いときだけ」書く（既存の記事の要約と summary_status を上書きしない）。CloudWatch アラーム 2 つ（IteratorAge が 30 分超、失敗キューにメッセージ）。通知先は任意の `alarms`（`email` ならスタックが TLS 必須・保存時暗号化なしの SNS トピックとメール購読を作る、`topicArn` なら既存トピック）で、全アラームに ALARM と OK のアクションを付ける。書かなければアクションなし
- マルチテナントデプロイ: `--tenant` で完全分離されたスタックを複数展開可能
- deploy.sh による CloudShell ワンクリックデプロイ（CodeBuild 経由）。`--destroy` のあとも DynamoDB テーブル、ロググループ、CDKToolkit とその資産バケットは残る（DEPLOY.md の Destroy の節）。待ちの途中で止まったら同じコマンドを再実行すると片付けまで進む
- ローカル Management Console（React + Express）でスタックの閲覧・デプロイ・更新・削除

## アーキテクチャ
EventBridge → Lambda (rss-crawler) → DynamoDB → DynamoDB Streams → Lambda (notify-to-app) → Bedrock (フォールバック付き) → DynamoDB 書き戻し + Webhook (Slack/Teams/Google Chat)

## 設定
- Webhook URL は AWS Systems Manager Parameter Store（SecureString）に格納
- モデルリージョン・モデル ID リスト・通知先・要約設定は `cdk.json` の `context` で管理
- テナント固有設定は `tenants/*.json` で管理し、`-c config=tenants/xxx.json` で読み込み
- 設定優先順位: CLI `-c key=value` > 設定ファイル > `cdk.json` デフォルト値
