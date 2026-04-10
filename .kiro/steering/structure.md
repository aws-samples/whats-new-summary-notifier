# プロジェクト構成

```
.
├── bin/                          # CDK アプリケーションエントリポイント
│   └── whats-new-summary-notifier.ts  # 外部設定ファイル読み込み・マルチテナント対応
├── lib/                          # CDK スタック定義
│   └── whats-new-summary-notifier-stack.ts
├── lambda/                       # Lambda 関数（Python）
│   ├── rss-crawler/              # RSS フィードのクロール → DynamoDB 書き込み
│   │   ├── index.py
│   │   └── requirements.txt
│   └── notify-to-app/            # DynamoDB Streams → Bedrock 要約 → DDB書き戻し → Webhook 通知
│       ├── index.py
│       ├── test_index.py         # pytest テスト
│       └── requirements.txt
├── test/                         # CDK スタックの Jest テスト
│   ├── stack.test.ts             # リソース構成テスト
│   └── config.test.ts            # マルチテナント・設定ファイルテスト
├── tenants/                      # テナント固有の設定ファイル
│   └── test.example.json         # テナント設定テンプレート
├── console/                      # Management Console（React + Express）
│   ├── src/                      # React フロントエンド
│   ├── server/                   # Express API サーバー（デプロイ管理含む）
│   ├── package.json
│   └── vite.config.ts
├── .github/workflows/ci.yml     # GitHub Actions CI（lint, test, ash）
├── deploy.sh                     # CloudShell ワンクリックデプロイスクリプト
├── buildspec.yml                 # CodeBuild ビルド仕様
├── doc/                          # ドキュメント用画像
├── cdk.json                      # CDK 設定・コンテキスト（モデル・通知先・要約設定）
├── jest.config.js                # Jest 設定（ts-jest）
├── package.json                  # Node.js 依存・スクリプト
├── tsconfig.json                 # TypeScript コンパイラ設定（ES2022）
├── eslint.config.mjs             # ESLint flat config
├── .prettierrc.json              # Prettier 設定
└── README.md / README_ja.md      # 英語・日本語ドキュメント
```

## 規約
- CDK スタック: `lib/` に配置、1 スタック構成
- Lambda 関数: `lambda/{機能名}/` に配置、各ディレクトリに `index.py` + `requirements.txt`
- Lambda テスト: 同ディレクトリに `test_index.py` を配置、pytest で実行
- CDK テスト: `test/` に配置、Jest + ts-jest で実行
- Lambda は `PythonFunction` コンストラクト（`@aws-cdk/aws-lambda-python-alpha`）でビルド
- 設定値は `cdk.json` の `context` で一元管理（ハードコードしない）
- テナント固有設定は `tenants/*.json` に分離し、`-c config=` で読み込み
- Webhook URL 等の機密情報は SSM Parameter Store（SecureString）に格納
- セキュリティ: `nosec` / `nosemgrep` コメントで意図的な除外を明示
- `console/` は独立した npm プロジェクト（Management Console、tsconfig.json の exclude に含まれる）
