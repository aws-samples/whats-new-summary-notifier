# デプロイオプション
本アセットは、AWS CDK の context で設定を変更します。

[cdk.json](cdk.json) の `context` 以下の値を変更することで設定します。各設定項目についての説明は下記の通りです。

## 共通設定
* `modelRegion`: Amazon Bedrock を利用するリージョン。Amazon Bedrock を利用可能なリージョンの中から、利用したいリージョンのリージョンコードを入力してください。
* `modelId`: Amazon Bedrock で利用する基盤モデルの model ID。Anthropic Claude 3 およびそれ以前のバージョンに対応をしています。各モデルの model ID はドキュメントを参照ください。

## summarizers
生成 AI に入力する要約用プロンプトの設定を行います。

* `outputLanguage`: モデル出力の言語。
* `persona`: モデルに与える役割 (ペルソナ)。

## notifiers
アプリケーションへの配信設定を行います。

* `destination`: 投稿先のアプリケーション名。`slack` か `teams` のいずれかを設定してください。
* `summarizerName`: 配信に使用する summarizer の名前。
* `webhookUrlParameterName`: Webhook URL を格納している AWS Systems Manager Parameter Store のパラメータ名。
* `rssUrl`: 最新情報を取得したい Web サイトの RSS フィード URL。URL は複数指定する事が可能です。
* `schedule` (オプション): CRON 形式の RSS フィード取得間隔。本パラメータの指定がない場合は、毎時 00 分にフィードを取得します。下記の例の場合は、15 分に一度フィード取得が行われます。

```json
...
"schedule": {
  "minute": "0/15",
  "hour": "*",
  "day": "*",
  "month": "*",
  "year": "*"
}
```

# 操作環境の準備 (AWS Cloud9)
本手順では、AWS 上に必要なツールがインストールされた開発環境を作成します。環境構築には、AWS Cloud9 を使用します。
AWS Cloud9 についての詳細は、[AWS Cloud9 とは?](https://docs.aws.amazon.com/ja_jp/cloud9/latest/user-guide/welcome.html)を参照してください。

1. [CloudShell](https://console.aws.amazon.com/cloudshell/home) を開いてください。
2. 以下のコマンドでリポジトリをクローンしてください。
```bash
git clone https://github.com/aws-samples/cloud9-setup-for-prototyping
```
3. ディレクトリに移動してください。
```bash
cd cloud9-setup-for-prototyping
```
4. コスト最適化のため必要に応じてボリュームの容量を変更します。
```bash
cat <<< $(jq  '.volume_size = 20'  params.json )  > params.json
```
5. スクリプトを実行してください。
```bash
./bin/bootstrap
```
1. [Cloud9](https://console.aws.amazon.com/cloud9/home) に移動し、"Open IDE" をクリックします。

> [!NOTE]
> 本手順で作成した AWS Cloud9 環境は、利用時間に応じて EC2 料金が従量課金で発生します。
> 30 分未操作の場合は自動停止する設定になっていますが、インスタンスボリューム (Amazon EBS) の課金は継続して発生するため、
> 料金発生を最小限にしたい場合は、アセットのデプロイ後に [AWS Cloud9 で環境を削除する](https://docs.aws.amazon.com/ja_jp/cloud9/latest/user-guide/delete-environment.html)に従って環境の削除を行ってください。