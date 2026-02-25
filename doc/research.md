# whats-new-summary-notifier コードベース調査レポート

## 1. プロジェクト概要

このプロジェクトは、RSSフィードを定期的に監視し、新着記事の内容をAmazon Bedrockで要約してSlackへ通知するサーバーレスアプリケーションです。AWS CDKでインフラをコード化しており、TypeScriptとPython 3.12を使っています。

### 主な機能

- AWSのWhats New、ML Blog、生成AIブログなど複数のRSSフィードを自動巡回する
- F1ニュースも同様に監視・要約できる（ペルソナ切り替えで対応）
- Bedrock（Strands Agent SDK経由）でテクニカルな観点から記事を要約する
- Slack Webhook経由で整形済みの通知を送る
- 「Share on X」のリンクも自動生成し、Twitterへのシェアを促す

### 技術スタック

| 分野 | 技術 | バージョン |
|------|------|-----------|
| IaCフレームワーク | AWS CDK v2 | ^2.233.0 |
| IaC言語 | TypeScript | ^5.9.3 |
| Lambdaランタイム | Python | 3.12 |
| AIエージェントフレームワーク | Strands Agent SDK | ^1.25.0 |
| LLM | Amazon Bedrock | amazon.nova-pro-v1:0 |
| データストア | Amazon DynamoDB | サーバーレス |
| イベントスケジューラ | Amazon EventBridge | Cronルール |
| シークレット管理 | AWS SSM Parameter Store | SecureString |
| 通知先 | Slack Webhook | - |
| テスト | Jest | ^30.2.0 |
| Linter/Formatter | ESLint, Ruff | - |
| コンプライアンスチェック | cdk-nag | ^2.37.47 |

---

## 2. ディレクトリ構造

```
whats-new-summary-notifier/
├── bin/
│   ├── whats-new-summary-notifier.ts   # CDKアプリのエントリーポイント
│   └── cdk_test.ts                      # cdk-nagによるコンプライアンスチェック用テストアプリ
├── lib/
│   └── whats-new-summary-notifier-stack.ts  # インフラスタック定義
├── lambda/
│   ├── rss-crawler/
│   │   ├── index.py                     # RSS取得・DynamoDB書き込みLambda
│   │   └── requirements.txt             # feedparser, python-dateutil
│   └── notify-to-app/
│       ├── index.py                     # Bedrock要約・Slack通知Lambda
│       └── requirements.txt             # beautifulsoup4, cloudscraper, strands-agents等
├── .github/workflows/
│   └── deps-audit.yml                   # 依存関係のセキュリティ監査CI
├── doc/
│   └── research.md                      # 本ファイル
├── cdk.json                             # CDKコンテキスト設定（モデル・ペルソナ・Notifier）
├── package.json                         # Node.js依存関係とスクリプト
├── tsconfig.json                        # TypeScriptコンパイル設定
├── eslint.config.mjs                    # ESLint設定（Flat Config形式）
├── mise.toml                            # ツールバージョン管理
├── .env.example                         # 環境変数テンプレート
├── README.md / README_ja.md             # ドキュメント（英語・日本語）
├── DEPLOY.md / DEPLOY_ja.md             # デプロイ設定ガイド（英語・日本語）
└── CONTRIBUTING.md                      # コントリビューションガイドライン
```

---

## 3. アーキテクチャ

### 全体構成図

```
EventBridge (Cron)
    |
    | 毎時:20 / 毎時:50
    v
[RSS Crawler Lambda]
    |
    | feedparser でRSSフィード取得
    | 過去7日以内の記事のみフィルタリング
    |
    v
[DynamoDB: WhatsNewRSSHistory]
    PK: url
    SK: notifier_name
    Stream: NEW_IMAGE
    |
    | INSERT イベント検知
    v
[Notify-to-App Lambda] (最大同時実行数: 1)
    |
    | cloudscraper で記事本文スクレイピング
    | Strands Agent SDK + Bedrock で要約
    | SSM Parameter Store から Webhook URL 取得
    |
    v
[Slack]
    |（Twitterシェアリンク付き）
    v
[X (Twitter) Intent URL]
```

### イベント駆動設計のポイント

RSSクローラーとSlack通知は完全に分離されており、DynamoDB Streamsでつながっています。クローラーがDynamoDBに新規レコードを書き込むと、自動でStreamイベントが発火し、通知Lambdaが起動します。この設計により、クローラーはSlackのことを知る必要がなく、疎結合が保たれています。

---

## 4. インフラストラクチャ詳細（CDK）

### エントリーポイント: `bin/whats-new-summary-notifier.ts`

```typescript
import 'dotenv/config';          // .envファイルから環境変数を読み込む
import 'source-map-support/register';  // デバッグ用スタックトレース改善

new WhatsNewSummaryNotifierStack(app, 'WhatsNewSummaryNotifierStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
});
```

デプロイ先のアカウント・リージョンは `CDK_DEFAULT_ACCOUNT` と `CDK_DEFAULT_REGION` 環境変数から自動取得します。未設定の場合はデフォルトで `us-east-1` が使われます。

### スタック定義: `lib/whats-new-summary-notifier-stack.ts`

#### DynamoDBテーブル

```typescript
new Table(this, 'WhatsNewRSSHistory', {
  partitionKey: { name: 'url', type: AttributeType.STRING },
  sortKey: { name: 'notifier_name', type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  stream: StreamViewType.NEW_IMAGE,
});
```

- `url` と `notifier_name` の複合キーで重複を防ぐ
- `PAY_PER_REQUEST` でアイドル時のコストゼロを実現
- `NEW_IMAGE` ストリームで新規レコードのみをキャプチャ

#### IAMロール構成（最小権限）

通知Lambdaロール (`NotifyNewEntryRole`):
- `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents`（CloudWatch Logs書き込み）
- `bedrock:InvokeModel`（全リソースに対して許可）
- SSM Parameter Storeの特定パラメータへの読み取り権限（`grantRead`で動的付与）

RSS CrawlerロールDefault (`NewsCrawlerRole`):
- CloudWatch Logs書き込み権限
- DynamoDB書き込み権限（`grantWriteData`で特定テーブルのみ）

#### Lambda関数設定

| 設定項目 | RSS Crawler | Notify-to-App |
|---------|-------------|---------------|
| ランタイム | Python 3.12 | Python 3.12 |
| タイムアウト | 60秒 | 180秒 |
| 同時実行数 | 無制限 | 1（予約済み） |
| ログ保持期間 | 2週間 | 2週間 |
| バッチサイズ | - | 1 |

通知Lambdaの同時実行数を1に制限している理由は、Slack APIとBedrock APIのレート制限対策です。

#### EventBridgeスケジュール設定

`cdk.json` の `notifiers` セクションで各ノティファイアにスケジュールを個別に設定できます。スケジュール未定義の場合のデフォルトは毎時0分です。

```typescript
const schedule: CronOptions = notifier['schedule'] || {
  minute: '0', hour: '*', day: '*', month: '*', year: '*',
};
```

EventBridgeルールはNotifier数分だけ動的に作成されます。各ルールはRSS CrawlerをターゲットとしてNotifier名と設定情報をイベントデータとして渡し、リトライ回数は2回です。

#### SSM Parameter Store連携

Slack Webhook URLはSSM Parameter Storeの `SecureString` で管理します。CDKで `StringParameter.fromSecureStringParameterAttributes()` を使って既存パラメータを参照し、`grantRead()` でLambdaロールに読み取り権限を付与します。

---

## 5. Lambda関数詳細

### RSS Crawler (`lambda/rss-crawler/index.py`)

#### 処理フロー

1. EventBridgeからNotifier名と設定情報を受け取る
2. `notifier["rssUrl"]` に定義された全RSSフィードURLを順に処理
3. `feedparser.parse()` でフィードを取得
4. フィード自体の更新日時を確認し、7日以上前なら処理スキップ
5. 各エントリーの公開日時を確認し、7日以内のみ `write_to_table()` でDynamoDBに書き込む
6. DynamoDBには `url` + `notifier_name` の条件付き書き込みで重複を防ぐ

#### 主な関数

```python
def recently_published(pubdate) -> bool:
    # 公開日時から現在までの経過日数が7日以内かチェック

def str2datetime(time_str) -> datetime:
    # RSSの日付文字列をdatetimeオブジェクトに変換（タイムゾーン無視）

def write_to_table(link, title, category, pubtime, notifier_name):
    # DynamoDBへの書き込み。ConditionalCheckFailedException は重複として無視

def handler(event, context):
    # EventBridgeから起動。notifier_name と notifier 設定を展開してRSS処理を開始
```

#### DynamoDBに書き込まれるデータ構造

```python
{
    "url": "https://...",          # PK: 記事URL
    "notifier_name": "AwsWhatsNew",  # SK: Notifier名
    "title": "記事タイトル",
    "category": "What's new",      # RSSフィードの名前
    "pubtime": "2024-01-01T12:00:00",  # ISO形式の公開日時
}
```

#### 依存ライブラリ

- `feedparser>=6.0.12` — RSSフィードのパース
- `python-dateutil>=2.9.0` — 日付文字列のパース

### Notify-to-App (`lambda/notify-to-app/index.py`)

#### 処理フロー

1. DynamoDB StreamからINSERTイベントのみを抽出（REMOVE/UPDATEはスキップ）
2. 各新着記事に対して以下を実行:
   a. SSM Parameter StoreからSlack Webhook URLを取得
   b. `cloudscraper` で記事本文をスクレイピング（`<main>` タグ内のテキストを抽出）
   c. Strands Agent SDK + Bedrockで要約を生成
   d. Slackメッセージを組み立てて送信
   e. 0.5秒スリープ（レート制限対策）

#### 主な関数

```python
def get_blog_content(url) -> Optional[str]:
    # cloudscraper + BeautifulSoupで記事本文を取得
    # タイムアウト5秒。Cloudflare対策済み

def get_bedrock_client(assumed_role, region, runtime) -> boto3.client:
    # Bedrockクライアント作成。リトライ最大10回、standard モード
    # BEDROCK_ASSUME_ROLEが設定されていればSTS AssumeRoleを実行

def summarize_blog(blog_body, language, persona, summarizer_name) -> (str, str, str):
    # Strands Agent SDKで要約実行
    # 戻り値: (summary, detail/thinking, twitter)

def push_notification(item_list):
    # アイテムごとにWebhook URL取得→コンテンツ取得→要約→Slack送信

def get_new_entries(blog_entries) -> list:
    # DynamoDB StreamレコードからINSERTのみフィルタリング

def create_slack_message(item) -> dict:
    # Slackメッセージを組み立て。TwitterのIntent URLも生成
```

#### 依存ライブラリ

- `beautifulsoup4>=4.14.3` — HTML解析
- `boto3>=1.42.46,<2` — AWS SDK
- `cloudscraper>=1.2.71` — Cloudflare対策込みのHTTPクライアント
- `strands-agents>=1.25.0` — AIエージェントフレームワーク
- `strands-agents-builder>=0.1.10` — エージェントビルダー

---

## 6. AI/ML統合詳細

### Strands Agent SDKの使い方

直接Bedrock APIを叩く代わりに、Strands Agent SDKを使っています。コード内にはかつてのBedrockの `converse()` API直接呼び出しがコメントアウトで残っており、移行の経緯が見て取れます。

```python
model = BedrockModel(
    params={
        "temperature": 0.1,      # 出力の確実性を高める（ランダム性低）
        "top_p": 0.1,            # 同上
        "max_tokens": 4096
    },
    model_id=MODEL_ID,           # 環境変数から取得
    region_name=MODEL_REGION,    # 環境変数から取得
    streaming=False,
)

agent = Agent(
    model=model,
    system_prompt=prompt_data,   # ペルソナ・指示をここで渡す
    callback_handler=None,       # コールバック無効
)

response = agent(blog_body)  # 記事本文を入力として渡す
```

### Bedrockモデル設定

- モデルID: `amazon.nova-pro-v1:0`（`cdk.json` で変更可能）
- リージョン: `us-west-2`（`cdk.json` で変更可能）
- `temperature: 0.1`, `top_p: 0.1` は意図的に低く設定し、事実に基づく正確な要約を優先

### 構造化出力

モデルには以下のXMLタグ形式で出力するよう指示しており、それをregexで抽出します:

```xml
<thinking>
- 分析の詳細（箇条書き）
- ...
</thinking>
<summary>
2〜3文の簡潔なまとめ
</summary>
<twitter>
200文字以内のTwitter用テキスト
</twitter>
```

```python
summary = re.findall(r"<summary>([\s\S]*?)</summary>", outputText)[0]
detail  = re.findall(r"<thinking>([\s\S]*?)</thinking>", outputText)[0]
twitter = re.findall(r"<twitter>([\s\S]*?)</twitter>", outputText)[0]
```

### ペルソナ設計

#### AwsSolutionsArchitectJapanese

AWSソリューションアーキテクトのペルソナで、以下の観点で分析します:
- 何が新しい機能・サービス・改善なのか
- 関係するAWSサービス
- 技術的なメリット（パフォーマンス・コスト・スケーラビリティ・セキュリティ）
- 主なターゲットユーザー
- 技術的な要件・制限・前提条件

出力は「です・ます」調の丁寧な日本語。Twitter要約は感嘆符・ハッシュタグ禁止、200文字以内。

#### Formula1ProfessionalJapanese

F1ジャーナリスト兼ファンのペルソナ。日本語出力時は必ず指定の日本語表記を使うよう厳命されています。

グロッサリー（抜粋）:
- ドライバー名: `Max Verstappen` → `マックス・フェルスタッペン`、`Yuki Tsunoda` → `角田裕毅`
- チーム名: `Red Bull Racing` → `レッドブル・レーシング`、`Ferrari` → `フェラーリ`
- 技術用語: `Qualifying` → `予選`、`Safety Car` → `セーフティカー`

グロッサリーへの準拠はプロンプト内で複数回強調されており、最終出力前に英語固有名詞が残っていないか自己チェックするよう指示されています。これは一般的なハルシネーション対策であり、LLMが独自のカタカナ表記を生成することを防ぐ設計です。

---

## 7. 設定システム

### `cdk.json` の構造

```json
{
  "context": {
    "modelRegion": "us-west-2",
    "modelId": "amazon.nova-pro-v1:0",
    "summarizers": { ... },
    "notifiers": { ... }
  }
}
```

### Summarizersスキーマ

```json
"SummarizerName": {
  "outputLanguage": "Japanese...",  // 出力言語と文体の指定
  "persona": "..."                   // AIのペルソナ説明
}
```

### Notifiersスキーマ

```json
"NotifierName": {
  "destination": "slack",
  "summarizerName": "SummarizerName",          // 使用するSummarizer
  "webhookUrlParameterName": "/SSM/Path",       // SSMパラメータパス
  "rssUrl": {
    "フィード名": "https://..."                  // 複数フィード対応
  },
  "schedule": {                                  // EventBridgeのCronオプション
    "minute": "20",
    "hour": "*",
    "day": "*",
    "month": "*",
    "year": "*"
  }
}
```

### 環境変数の受け渡し

CDKスタックで `JSON.stringify()` した設定をLambdaの環境変数として渡します:

```typescript
environment: {
  MODEL_ID: modelId,
  MODEL_REGION: modelRegion,
  NOTIFIERS: JSON.stringify(notifiers),
  SUMMARIZERS: JSON.stringify(summarizers),
}
```

Lambda側では `json.loads(os.environ["NOTIFIERS"])` で復元します。設定変更はコードの変更なしに `cdk.json` だけで完結する設計です。

### 現在設定されているNotifier

| Notifier名 | 監視対象 | スケジュール | Summarizer |
|-----------|---------|------------|-----------|
| AwsWhatsNew | AWS Whats New, ML Blog, 生成AIブログ（JP/EN）計5フィード | 毎時:20 | AwsSolutionsArchitectJapanese |
| F1WhatsNew | RaceFans.net, RacingNews365 計2フィード | 毎時:50 | Formula1ProfessionalJapanese |

---

## 8. セキュリティ設計

### Slack Webhook URLの管理

Webhook URLはコードにハードコードせず、SSM Parameter Storeの `SecureString` で管理します。Lambda実行時にSSM APIで都度取得するため、設定値がコードやログに漏洩しません。

```python
ssm_response = ssm.get_parameter(
    Name=webhook_url_parameter_name,
    WithDecryption=True  # KMSで復号
)
app_webhook_url = ssm_response["Parameter"]["Value"]
```

### IAM最小権限

- RSS CrawlerはBedrock・SSMへの権限を持たない
- 通知LambdaはDynamoDB書き込み権限を持たない
- `bedrock:InvokeModel` のリソースはワイルドカード（`*`）だが、他の権限は特定リソースに限定

### URL検証

`get_blog_content()` ではURLが `http://` または `https://` で始まらない場合は処理をスキップします:

```python
if not url.lower().startswith(("http://", "https://")):
    print(f"Invalid URL: {url}")
    return None
```

### Cloudflare対策

`cloudscraper` ライブラリとChrome偽装の `User-Agent` ヘッダーを組み合わせてCloudflare Botチェックを回避します。スクレイピング対象サイトの利用規約に依存する点には注意が必要です。

---

## 9. 運用設計

### ログ管理

- 両Lambda関数のCloudWatch Logsグループは2週間保持に設定
- `RemovalPolicy.DESTROY` でスタック削除時にロググループも削除
- Lambdaコード内の `print()` がCloudWatch Logsに出力される

### エラーハンドリング戦略

| 状況 | 対処 |
|------|------|
| DynamoDB重複書き込み | `ConditionalCheckFailedException` をキャッチしてスキップ |
| 記事スクレイピング失敗 | `None` を返して処理継続（要約はスキップ） |
| Bedrock アクセス拒否 | `AccessDeniedException` をキャッチしてトラブルシューティングリンクを出力 |
| 一般例外（通知Lambda） | `traceback.print_exc()` でCloudWatch Logsに出力 |

`get_blog_content()` が `None` を返す場合、`summarize_blog()` には `None` が渡されます。これはモデルへの入力として問題になる可能性があり、改善の余地があります。

### CI/CDパイプライン

`.github/workflows/deps-audit.yml` でpushとPRのたびに自動実行:
- `npm audit --audit-level=moderate`（Node.js依存関係）
- `pip-audit`（rss-crawlerとnotify-to-appそれぞれの仮想環境を作って実行）

---

## 10. データフロー詳細（エンドツーエンド）

```
1. EventBridge Cron (毎時:20)
   └─ RSS Crawler Lambda を起動
      イベントデータ: { "AwsWhatsNew": { "rssUrl": {...}, ... } }

2. RSS Crawler Lambda
   ├─ feedparser で 5つのRSSフィードを順番に取得
   ├─ フィード更新日 > 7日前 → スキップ
   ├─ エントリー公開日 > 7日前 → スキップ
   └─ DynamoDB に put_item（url + notifier_name で重複排除）

3. DynamoDB Stream (NEW_IMAGE)
   └─ INSERT イベント検知 → Notify-to-App Lambda を起動（batchSize: 1）

4. Notify-to-App Lambda
   ├─ SSM から Slack Webhook URL を取得（復号あり）
   ├─ cloudscraper で記事URLをフェッチ（<main>タグ内テキスト抽出）
   ├─ Strands Agent SDK + Bedrock で要約生成
   │   ├─ system_prompt: ペルソナ + 指示 + 出力フォーマット定義
   │   └─ user_input: 記事本文
   │   ─── モデルが <thinking><summary><twitter> 形式で返答
   ├─ regex で各タグの内容を抽出
   ├─ Slack メッセージを組み立て
   │   ├─ 公開日時
   │   ├─ 記事リンク（クリッカブル）
   │   ├─ AI要約（summary）
   │   ├─ 詳細分析（thinking/detail）
   │   └─ Share on X（Twitter Intent URL）
   └─ Slack Webhook に HTTP POST

5. Slack チャンネルに通知表示
   └─ ユーザーが「Share on X」クリック → Twitter投稿画面へ
```

---

## 11. 設計上の考察

### 優れている点

**疎結合なイベント駆動設計**: RSS取得と通知が完全に分離されており、DynamoDB Streamsが中継役を担います。将来的に通知先をSlack以外に追加する際も、新しいLambdaをDynamoDB Streamにアタッチするだけで対応できます。

**設定の外部化**: `cdk.json` でNotifier・Summarizer・モデル設定を一元管理しており、新しいRSSフィードや通知先の追加がコード変更なしにできます。

**重複処理防止**: DynamoDBの複合キー（url + notifier_name）による自然な重複排除。同じ記事が複数回配信されることを防ぎます。

**グロッサリー強制**: F1ジャーナリストペルソナのプロンプトに詳細な日本語対訳表を埋め込み、LLMが勝手な表記を使うことを防止しています。この手法は固有名詞の一貫性が求められるユースケースで有効です。

**同時実行数制限**: 通知Lambdaの同時実行を1に制限することで、Slackへのメッセージ投稿とBedrockの呼び出しレート制限をシンプルに回避しています。

### 潜在的な改善点・課題

**`get_blog_content()` が `None` を返す場合の扱い**: スクレイピング失敗時に `None` が `summarize_blog()` に渡されます。モデルへの入力として不適切な可能性があり、エラーになるか空の要約が返るかはモデル次第です。スクレイピング失敗時に早期リターンする処理の追加が望ましいです。

**DynamoDB書き込みの例外処理の誤り**: `rss-crawler/index.py` の `write_to_table()` で `e.response` にアクセスしていますが、汎用の `Exception` に `.response` 属性がないためAttributeErrorが起きる可能性があります。`ClientError` を明示的にキャッチすべきです。

**`bedrock:InvokeModel` のリソースがワイルドカード**: CDK Nagコンプライアンスチェックで指摘対象になりえます。使用するモデルARNを明示的に指定することで最小権限を徹底できます。

**記事コンテンツの切り捨て**: 長い記事をそのままモデルに渡す場合、コンテキスト長制限に引っかかる可能性があります。記事の先頭N文字に制限するか、チャンク分割処理があると安全です。

**`notifier_name, notifier = event.values()` の脆弱性**: RSS Crawlerの `handler()` でイベントの辞書に2つのキーしかないことを前提にしています。EventBridgeのメタデータが混入した場合に `ValueError` が起きます。明示的なキー指定が安全です。

**テストカバレッジ**: TypeScript側はJestが設定されていますが `--passWithNoTests` フラグがあり、実質テストが存在しません。Python Lambda関数のユニットテストも確認できませんでした。本番運用の安全性向上にはテストの拡充が有効です。

---

## 12. 関連ドキュメント

- [README.md](../README.md) — プロジェクト概要・デプロイ手順（英語）
- [README_ja.md](../README_ja.md) — プロジェクト概要・デプロイ手順（日本語）
- [DEPLOY.md](../DEPLOY.md) — 詳細な設定ガイド（英語）
- [DEPLOY_ja.md](../DEPLOY_ja.md) — 詳細な設定ガイド（日本語）
- [CONTRIBUTING.md](../CONTRIBUTING.md) — コントリビューションガイドライン
