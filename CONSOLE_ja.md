# Management Console

Management Console は、Whats New Summary Notifier のデプロイを管理するためのローカル Web アプリケーションです。新規テナントのデプロイ、設定の更新、ビルドジョブの監視、DynamoDB データの確認をブラウザから行えます。

## 前提条件

- Node.js 22+
- AWS CLI が 1 つ以上の名前付きプロファイルで設定済み
- プロファイルに CloudFormation, Lambda, DynamoDB, SSM, CodeBuild, IAM, S3, Bedrock の権限が必要

## 起動方法

```bash
npm run dev:console
```

ブラウザで [http://localhost:5173](http://localhost:5173) を開きます。Express API サーバーはポート 3456 で動作し、Vite 開発サーバーが API リクエストをプロキシします。

## 機能一覧

### 1. プロファイル選択とスタック検出

ドロップダウンから AWS CLI プロファイルを選択すると:
- AWS アカウント ID が表示されます
- キャッシュされたスタックデータがあれば自動ロードされます
- **🔍 Scan Regions** をクリックすると、全 AWS リージョンからデプロイ済みの `WhatsNewSummaryNotifier*` スタックを検索します

### 2. スタック一覧

検出された各スタックには以下が表示されます:
- リージョン、テナント名、スタック名、ステータス、最終更新日時
- アクションボタン: **▼ Details**, **📊 DDB**, **📤 Export**, **🔄 Update**, **▶️ Test**, **🗑️ Destroy**

### 3. 新規テナントのデプロイ

ヘッダーの **+ Deploy New Tenant** をクリックしてデプロイモーダルを開きます。

**基本フィールド:**
- **Tenant Name** — 空欄でデフォルトスタック
- **Deploy Region** — ドロップダウンから選択、またはプロファイルのデフォルトリージョンを使用

**Webhook URL の登録:**
- Webhook URL を入力し、任意で SSM パラメータ名をカスタム指定
- または **Use existing SSM parameter** にチェックを入れて、対象リージョンの既存 `/WhatsNew/*` パラメータをドロップダウンから選択

**設定エディタ（GUI / JSON タブ）:**

**🛠️ GUI Editor** タブでは構造化フォームで設定を編集できます:

| セクション | フィールド |
|---|---|
| 🤖 Model Configuration | Model Region（ドロップダウン）、Model IDs（Bedrock + CRIS モデルのサジェスト付き） |
| 📝 Summarizers | 名前、出力言語、ペルソナ（Notifiers より先に定義） |
| 🔔 Notifiers | 名前、通知先（Slack/Teams）、Summarizer（定義済み Summarizer のドロップダウン）、SSM パラメータ名（既存のドロップダウン + 手入力）、RSS URL |

**📝 JSON** タブでは設定 JSON を直接編集できます。タブ間で双方向に同期されます。

その他:
- **📁 Load file** — テナント JSON ファイルを参照して読み込み
- **ドラッグ＆ドロップ** — JSON ファイルをエディタにドロップ

### 4. 既存テナントの更新

スタック行の **🔄 Update** をクリックします。モーダルには Lambda 環境変数から復元された現在の設定がプリロードされます。任意のフィールドを編集してデプロイします。

### 5. テナントの削除

スタック行の **🗑️ Destroy** をクリックします。確認ダイアログでテナント名を正確に入力する必要があります。削除ビルド成功後、CodeBuild プロジェクト、IAM ロール、SSM パラメータが自動的にクリーンアップされます。

### 6. ビルドコンソール

デプロイ/更新/削除がトリガーされると、画面下部にビルドコンソールパネルが表示されます:
- CloudWatch Logs からのリアルタイムログストリーミング（3 秒間隔ポーリング）
- ステータスバッジ: 🔵 IN_PROGRESS / 🟢 SUCCEEDED / 🔴 FAILED
- **最小化可能** — ヘッダーバーまたは ▼/▲ ボタンをクリック
- **永続化** — ビルド状態は localStorage に保存され、ページリロード後も復元されます
- 成功時: スタック一覧が自動リフレッシュ。削除成功時: リソースが自動クリーンアップ

### 7. テスト（クローラー実行）

スタック行の **▶️ Test** をクリックすると、RSS クローラー Lambda を手動実行します。ブラウザの確認ダイアログが表示されます。クローラーは EventBridge と同じペイロードで各 Notifier ごとに呼び出され、RSS 取得 → DynamoDB 書き込み → Bedrock 要約 → Webhook 通知のフルパイプラインが実行されます。

### 8. DynamoDB プレビュー

スタック行の **📊 DDB** をクリックして RSS 履歴テーブルを閲覧します。各アイテムには以下が表示されます:
- タイトル（リンク付き）、公開日時、カテゴリ、Notifier 名
- 要約ステータスバッジ（completed / pending）
- モデル ID、レイテンシー、入力/出力トークン数
- 要約テキスト（緑ハイライト）
- 詳細テキスト（折りたたみ表示）

### 9. スタック詳細

**▼ Details** をクリックして展開:
- モデル設定（リージョン、モデル ID）
- Summarizers / Notifiers 設定（JSON）
- SSM パラメータ（**Load** をクリックして復号・表示）
- CloudFormation パラメータとアウトプット（生データ）

### 10. テナント設定のエクスポート

**📤 Export** をクリックすると、スタックの設定を JSON ファイルとして `tenants/exported/` に保存します。エクスポートされたファイルは `deploy.sh --config` で使用したり、Management Console に再読み込みできます。

## 仕組み

Management Console はすべてローカルマシン上で動作します:

1. **Express API サーバー**（ポート 3456）が `fromIni()` で AWS CLI 認証情報を使用して AWS API を呼び出します
2. **React フロントエンド**（ポート 5173）が API リクエストを Express サーバーにプロキシします
3. **デプロイフロー**: ローカルのソースコードを zip 化（`.git`, `node_modules` 等を除外）→ S3 にアップロード → CodeBuild プロジェクトを作成/更新 → CDK コンテキストを環境変数としてビルド開始
4. AWS API 呼び出し以外に**データがマシン外に出ることはありません**

## 設定の優先順位

Management Console からデプロイする場合:

1. GUI/JSON エディタの値が一時設定ファイルに書き出されます
2. CDK に `-c config=/tmp/cdk-context-config.json` として渡されます
3. 設定ファイルの値は `cdk.json` のデフォルト値を**上書き**します
