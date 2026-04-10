# プロダクト概要

Whats New Summary Notifier は、AWS What's New などの Web 記事の RSS フィードを定期的にクロールし、Amazon Bedrock で記事内容を要約して Slack または Microsoft Teams に通知する生成 AI アプリケーション。

## 主要機能
- RSS フィードの定期クロール（EventBridge スケジュール）
- 新着記事の DynamoDB への記録（重複排除付き）
- DynamoDB Streams トリガーによる記事本文の取得・要約・通知
- 要約結果の DynamoDB への書き戻し（summary, detail, summary_status）
- Slack / Microsoft Teams 両対応（Webhook 経由）
- 要約言語・ペルソナのカスタマイズ（cdk.json の summarizers で設定）
- モデルフォールバック: 複数モデル ID を順に試行し、失敗時は次のモデルへ自動切替
- マルチテナントデプロイ: `--tenant` で完全分離されたスタックを複数展開可能
- deploy.sh による CloudShell ワンクリックデプロイ（CodeBuild 経由）
- ローカル Management Console（React + Express）でスタックの閲覧・デプロイ・更新・削除

## アーキテクチャ
EventBridge → Lambda (rss-crawler) → DynamoDB → DynamoDB Streams → Lambda (notify-to-app) → Bedrock (フォールバック付き) → DynamoDB 書き戻し + Webhook (Slack/Teams)

## 設定
- Webhook URL は AWS Systems Manager Parameter Store（SecureString）に格納
- モデルリージョン・モデル ID リスト・通知先・要約設定は `cdk.json` の `context` で管理
- テナント固有設定は `tenants/*.json` で管理し、`-c config=tenants/xxx.json` で読み込み
- 設定優先順位: CLI `-c key=value` > 設定ファイル > `cdk.json` デフォルト値
