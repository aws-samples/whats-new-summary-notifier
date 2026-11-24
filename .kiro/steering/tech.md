# 技術スタック

## IaC / インフラ
- AWS CDK v2（TypeScript）— aws-cdk-lib ^2.278.0
- `@aws-cdk/aws-lambda-python-alpha` で Python Lambda をビルド（Docker 必須）
- CodeBuild によるリモートデプロイ（deploy.sh と Management Console 経由、イメージ `aws/codebuild/amazonlinux-x86_64-standard:6.0`、CDK CLI は package.json の `aws-cdk` を `npx cdk` で使用）。既存の CodeBuild プロジェクトも、再デプロイ（Console の update を含む）でこのイメージに更新し、destroy のビルドは `imageOverride` でこのイメージを使う。Console のイメージと環境の設定は `console/server/codebuild.ts` にある

## Lambda ランタイム
- Python 3.15（Lambda）/ Python 3.15（CodeBuild）
- 依存管理: 各 Lambda ディレクトリの `requirements.txt`

## 主要 AWS サービス
- Amazon Bedrock（モデルフォールバックプール — `modelIds` 配列で複数指定）
- Amazon DynamoDB（RSS 履歴 + 要約結果の書き戻し、Streams で変更検知）
- Amazon SQS（通知 Lambda のイベントソースの失敗の送り先）
- Amazon CloudWatch（IteratorAge と失敗キューのアラーム）
- Amazon EventBridge（定期スケジュール）
- AWS Lambda（RSS クロール、通知処理）
- AWS Systems Manager Parameter Store（Webhook URL の安全な格納）
- AWS CodeBuild（deploy.sh からのリモートデプロイ）

## 開発ツール
- TypeScript ~5.9 / Node.js 22+（target: ES2022。CI の test は Node.js 22・24・26、その他の CI ジョブと CodeBuild は Node.js 26）
- ESLint 9（flat config） + Prettier
- Jest 29 + ts-jest（TypeScript テスト）
- pytest（Python テスト）— `uv run` 経由で実行
- ruff（Python lint / format）— `uv run` 経由で実行
- ASH（Automated Security Helper）— CI でセキュリティスキャン

## Management Console（ローカル管理ツール）
- React 19 + Tailwind CSS 4 + Vite 8（フロントエンド）
- Node.js 22.12+（Vite 8 と @vitejs/plugin-react 6 の要件）
- Express 5 + tsx（バックエンド API サーバー）
- AWS SDK v3 でローカルの AWS CLI プロファイルを使用

## コードスタイル
- Prettier: printWidth 120, singleQuote, trailingComma es5, tabWidth 2
- ESLint: typescript-eslint recommended + prettier 連携
- Prettier 対象外: JSON, Markdown, Python, YAML（`.prettierignore` 参照）
- Python: ruff でフォーマット・lint

## よく使うコマンド
```bash
# 依存インストール
npm install

# TypeScript ビルド
npm run build

# テスト（TS + Python 両方）
npm test
npm run test:ts    # TypeScript のみ
npm run test:py    # Python のみ

# Lint（TS + Python 両方）
npm run lint
npm run lint:ts    # TypeScript のみ
npm run lint:py    # Python のみ

# フォーマット（TS + Python 両方）
npm run format

# CDK 初期化（初回のみ）
cdk bootstrap

# テンプレート合成（検証）
cdk synth

# デプロイ
cdk deploy
cdk deploy -c tenant=test              # テナント指定
cdk deploy -c config=tenants/test.json  # 設定ファイル指定

# CloudShell デプロイ（推奨）
bash deploy.sh
bash deploy.sh --tenant test --non-interactive --webhook-url "..." --destination slack --language japanese

# スタック削除
cdk destroy
bash deploy.sh --destroy --tenant test

# Management Console 起動（ローカル管理ツール）
npm run dev:console
```

## CI（GitHub Actions）
- lint: ESLint + ruff
- test: Jest + pytest
- ash: Automated Security Helper によるセキュリティスキャン
