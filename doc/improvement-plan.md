# 改善計画: 潜在的な問題の解決策

コードベースを精査した結果、6つの課題を特定しました。影響度・優先度の順に整理し、それぞれについて具体的な修正方針を示します。

---

## 優先度: 高（バグ・実行時エラー）

### 課題1: `write_to_table()` の例外処理に3つのバグがある

**ファイル**: `lambda/rss-crawler/index.py` (63〜69行目)

**現在のコード**:
```python
except Exception as e:
    # Intentional error handling for duplicates to continue
    if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
        print("Duplicate item put: " + title)
    else:
        # Continue for other errors
        print(e.message)
```

**バグ1: `e.response` 属性が存在しない**

汎用の `Exception` には `.response` 属性がなく、`ClientError` のみがこの属性を持ちます。DynamoDB以外の例外（ネットワークエラー、`TypeError` 等）が発生した場合、`e.response` へのアクセスで `AttributeError` が発生し、元のエラーが隠蔽されます。

**バグ2: `ConditionalCheckFailedException` は発生しえない**

現在の `table.put_item(Item=item)` には `ConditionExpression` が指定されていません。`ConditionalCheckFailedException` は条件付き書き込みが失敗したときのみ発生するため、このコードパスには到達しません。

実際のところ、DynamoDBの `put_item` はデフォルトで上書きを行うため、重複書き込みはエラーなく処理されています。このエラーハンドリング自体が不要な状態です。重複排除はDynamoDBの主キー制約（`url` + `notifier_name`）ではなく、上書き動作によって黙示的に処理されています。

**バグ3: `e.message` は Python 3 で存在しない**

Python 2 の書き方であり、Python 3 では `str(e)` または `e.args[0]` を使います。

**修正方針**:

```python
def write_to_table(link, title, category, pubtime, notifier_name):
    from botocore.exceptions import ClientError
    try:
        item = {
            "url": link,
            "notifier_name": notifier_name,
            "title": title,
            "category": category,
            "pubtime": pubtime,
        }
        print(item)
        table.put_item(Item=item)
    except ClientError as e:
        print(f"DynamoDB error writing {title}: {e}")
```

`put_item` は上書きをデフォルトとするため、重複は自然に処理されます。`ConditionalCheckFailedException` の処理コードは削除します。

---

### 課題2: `summarize_blog()` のエラーパスで変数が未定義のまま `return` に到達する

**ファイル**: `lambda/notify-to-app/index.py` (357〜383行目)

**現在のコード**:
```python
try:
    response = agent(blog_body)
    ...
    summary = re.findall(r"<summary>...", outputText)[0]
    detail = re.findall(r"<thinking>...", outputText)[0]
    twitter = re.findall(r"<twitter>...", outputText)[0]
except ClientError as error:
    if error.response["Error"]["Code"] == "AccessDeniedException":
        print(...)  # ← return がない
    else:
        raise error

return summary, detail, twitter  # ← AccessDeniedException 時は未定義
```

`AccessDeniedException` が発生した場合、`print()` のみで処理を続行しますが、`summary`・`detail`・`twitter` が未定義のまま `return` に到達し `UnboundLocalError` が発生します。

また、`re.findall()` が空リストを返した場合（モデルが指定形式で出力しなかった場合）にも `IndexError` が発生し、`return` 文の前で例外が起きます。

**修正方針**:

```python
try:
    response = agent(blog_body)
    ...
    summary_matches = re.findall(r"<summary>([\s\S]*?)</summary>", outputText)
    detail_matches = re.findall(r"<thinking>([\s\S]*?)</thinking>", outputText)
    twitter_matches = re.findall(r"<twitter>([\s\S]*?)</twitter>", outputText)

    if not summary_matches or not detail_matches or not twitter_matches:
        raise ValueError(f"Response missing required XML tags: {outputText[:200]}")

    summary = summary_matches[0]
    detail = detail_matches[0]
    twitter = twitter_matches[0]

except ClientError as error:
    if error.response["Error"]["Code"] == "AccessDeniedException":
        print(...)
        raise  # 上位に伝播させる。あるいは呼び出し元でNoneを返すように設計変更
    raise error

return summary, detail, twitter
```

---

### 課題3: `traceback.print_exc()` の誤った使い方

**ファイル**: `lambda/notify-to-app/index.py` (483〜484行目)

**現在のコード**:
```python
except Exception:
    print(traceback.print_exc())
```

`traceback.print_exc()` は戻り値として `None` を返しながら、スタックトレースを `stderr` に書き込みます。`print(None)` により CloudWatch Logs に `None` という文字列が出力されるだけで、エラー内容は記録されません。

**修正方針**:

```python
except Exception:
    traceback.print_exc()
```

または、より明示的にログ出力するなら:

```python
except Exception:
    print(traceback.format_exc())
```

---

## 優先度: 高（サイレントな動作不良）

### 課題4: スクレイピング失敗時に `None` が `summarize_blog()` に渡る

**ファイル**: `lambda/notify-to-app/index.py` (403〜407行目)

**現在のコード**:
```python
content = get_blog_content(item_url)

# Summarize the blog
summarizer = SUMMARIZERS[notifier["summarizerName"]]
summary, detail, twitter = summarize_blog(content, ...)
```

`get_blog_content()` が `None` を返す場合（スクレイピング失敗、`<main>` タグなし、URL無効）、`agent(None)` が呼び出されます。Strands SDK の内部実装次第でエラーになるか、空のコンテキストで不正確な要約が返るかが不定です。

発生するケース:
- URLがHTTP 4xx/5xx を返す
- Cloudflareのチャレンジをくぐり抜けられない
- `<main>` タグが存在しないHTML構造（一部F1ニュースサイト等）

**修正方針**:

スクレイピング失敗時は記事タイトルを代替テキストとして使う方法が現実的です:

```python
content = get_blog_content(item_url)

if content is None:
    print(f"Could not retrieve content for {item_url}. Falling back to title.")
    content = item["rss_title"]  # タイトルのみで要約

summary, detail, twitter = summarize_blog(content, ...)
```

あるいは、コンテンツ取得失敗を致命的エラーとして扱い、Slack通知をスキップする:

```python
content = get_blog_content(item_url)
if content is None:
    print(f"Skipping notification for {item_url}: content unavailable")
    continue
```

どちらを選ぶかはプロダクトの要件次第ですが、タイトルフォールバック方式の方がユーザーへの通知を欠落させない点で優れています。

---

## 優先度: 中（堅牢性・セキュリティ）

### 課題5: `handler()` の `event.values()` アンパッキングが壊れやすい

**ファイル**: `lambda/rss-crawler/index.py` (95行目)

**現在のコード**:
```python
def handler(event, context):
    notifier_name, notifier = event.values()
```

EventBridgeが渡すイベントの構造は `{ "notifierName": "AwsWhatsNew", "notifier": {...} }` であり、これを `dict.values()` で2要素アンパッキングしています。

問題点:
- Python の辞書は順序保証されていますが（Python 3.7+）、キーの順序が `notifierName` → `notifier` であることへの暗黙の依存があります
- 将来的にEventBridgeがメタデータを追加した場合（例えば `version`、`account` フィールドなど）、`ValueError: too many values to unpack` でクラッシュします
- テスト時にイベント構造を完全に再現しなければならず、テストの書きにくさにつながります

CDKのコード（`lib/whats-new-summary-notifier-stack.ts` 159行目）を見ると、イベントのキーは `notifierName` と `notifier` です:
```typescript
event: RuleTargetInput.fromObject({ notifierName, notifier }),
```

**修正方針**:

```python
def handler(event, context):
    notifier_name = event["notifierName"]
    notifier = event["notifier"]
    ...
```

明示的なキーアクセスにすることで、イベント構造への依存を明確にし、予期しないフィールドの追加に対して堅牢になります。

---

### 課題6: `bedrock:InvokeModel` の IAMポリシーリソースがワイルドカード

**ファイル**: `lib/whats-new-summary-notifier-stack.ts` (39〜43行目)

**現在のコード**:
```typescript
new PolicyStatement({
  actions: ['bedrock:InvokeModel'],
  effect: Effect.ALLOW,
  resources: ['*'],
}),
```

すべてのBedrockモデルへのInvokeModelを許可しています。最小権限の原則に反しており、cdk-nagのチェックでも指摘対象になります。

**修正方針**:

`modelId` と `modelRegion` はすでに `cdk.json` から取得可能なので、特定のモデルARNに絞れます:

```typescript
const modelArn = `arn:aws:bedrock:${modelRegion}::foundation-model/${modelId}`;

new PolicyStatement({
  actions: ['bedrock:InvokeModel'],
  effect: Effect.ALLOW,
  resources: [modelArn],
}),
```

ただし、cross-region inference（推論プロファイル）を使う場合は `arn:aws:bedrock:{region}:{accountId}:inference-profile/*` のような形式が必要になるため、使用するモデルの呼び出し方に合わせてARNを決定します。

---

## 優先度: 低（コード品質）

### 課題7: コメントアウトされたコードの除去

**ファイル**: `lambda/notify-to-app/index.py` (297〜335行目)

Bedrock の `converse()` API を直接呼び出していた旧実装のコードが297〜335行目に大量にコメントアウトされたまま残っています。

Strands Agent SDKへの移行は完了しており、これらのコードは不要です。コメントアウトコードはコードの可読性を下げ、「このコードは使うかもしれない」という誤解を招きます。コードの変更履歴はgitで追えるため、コメントアウトで残す必要はありません。

削除対象の範囲: 297〜335行目の全コメントアウトブロック、および `get_bedrock_client()` 関数（Strands SDK移行後は `boto3_bedrock` を `summarize_blog()` 内で生成しているが、実際には Strands SDK 内部でクライアントを管理しており `boto3_bedrock` 変数自体が `summarize_blog()` 内で未使用になっている点も確認が必要）。

---

## 実装の優先順位まとめ

| # | 課題 | 影響 | 工数 | 優先度 |
|---|------|------|------|-------|
| 1 | `write_to_table()` の例外処理バグ | 実行時エラーの隠蔽 | 小 | 高 |
| 2 | `summarize_blog()` の未定義変数参照 | `UnboundLocalError` クラッシュ | 小 | 高 |
| 3 | `traceback.print_exc()` の誤用 | ログにエラー内容が残らない | 極小 | 高 |
| 4 | `None` コンテンツのフォールバック | サイレントな動作不良 | 小 | 高 |
| 5 | `event.values()` の脆弱性 | イベント構造変更時のクラッシュ | 極小 | 中 |
| 6 | IAMポリシーのワイルドカード | セキュリティ・コンプライアンス | 小 | 中 |
| 7 | コメントアウトコードの除去 | 可読性 | 小 | 低 |

---

## 追記: `boto3_bedrock` が未使用になっている件

`summarize_blog()` 内で `boto3_bedrock = get_bedrock_client(...)` を呼び出していますが（149〜152行目）、その後 Strands SDK が独自に Bedrock クライアントを管理するため、この変数は実際には使われていません。`get_bedrock_client()` のコールとその戻り値の使用は、Strands SDK移行後に不要になった残骸です。

これは課題7のコメントアウトコード除去と合わせて対処する形が自然です。ただし、`get_bedrock_client()` は `BEDROCK_ASSUME_ROLE` 環境変数を使った AssumeRole をサポートしており、Strands SDK でもクロスアカウントのロールを使う必要がある場合は別の方法での実装が必要です。削除前に AssumeRole の要件を確認することが必要です。

---

## 詳細ToDoリスト

### フェーズ1: バグ修正（高優先度）✅ 完了

バグはすべて独立しているため任意の順序で対応できますが、同一ファイルへの修正はまとめて行う方が効率的です。

---

#### Phase 1-A: `lambda/rss-crawler/index.py` のバグ修正 ✅

#### タスク 1-A-1: `write_to_table()` の例外処理を全面書き直す

- 対象ファイル: `lambda/rss-crawler/index.py`
- 対象行: 1〜9行目（importブロック）および 63〜69行目（exceptブロック）
- 作業内容:
  - ファイル先頭に `from botocore.exceptions import ClientError` を追加する（現在 `boto3` のみインポート済みで `ClientError` がない）
  - `except Exception as e:` を `except ClientError as e:` に変更する
  - `e.response["Error"]["Code"] == "ConditionalCheckFailedException"` の分岐を削除する（`ConditionExpression` なしでは発生しない）
  - `print(e.message)` を `print(f"DynamoDB error writing {title}: {e}")` に変更する
- 検証方法:
  - 修正後のコードで `ruff check lambda/rss-crawler/index.py` を実行してLintエラーがないことを確認する
  - 静的に読んで `Exception` 型のまま `.response` にアクセスする箇所がないことを確認する

#### タスク 1-A-2: `handler()` の `event.values()` を明示的キーアクセスに変更する

- 対象ファイル: `lambda/rss-crawler/index.py`
- 対象行: 95行目
- 作業内容:
  - `notifier_name, notifier = event.values()` を以下の2行に置き換える
  - `notifier_name = event["notifierName"]`
  - `notifier = event["notifier"]`
- 確認ポイント: CDKスタック（`lib/whats-new-summary-notifier-stack.ts` 159行目）の `RuleTargetInput.fromObject({ notifierName, notifier })` が生成するキー名と一致していること
- 検証方法:
  - `ruff check lambda/rss-crawler/index.py` を実行する
  - 変更後のコードを読み、キー名が `notifierName`（camelCase）であることを確認する

---

#### Phase 1-B: `lambda/notify-to-app/index.py` のバグ修正 ✅

#### タスク 1-B-1: `traceback.print_exc()` の誤用を修正する

- 対象ファイル: `lambda/notify-to-app/index.py`
- 対象行: 483〜484行目
- 作業内容:
  - `print(traceback.print_exc())` を `traceback.print_exc()` に変更する
- 補足: `traceback.print_exc()` は `None` を返すため `print()` で囲むと `"None"` が出力されるだけ。`print_exc()` 自体が `stderr` にスタックトレースを書き出す
- 検証方法:
  - `ruff check lambda/notify-to-app/index.py` を実行する

#### タスク 1-B-2: `summarize_blog()` の未定義変数参照とIndexErrorを修正する

- 対象ファイル: `lambda/notify-to-app/index.py`
- 対象行: 357〜383行目
- 作業内容:
  - `try` ブロック内で `summary`、`detail`、`twitter` を代入する前に、`re.findall()` の結果を変数に格納する
  - 各 `findall()` の結果が空リストだった場合に `ValueError` を raise する（インデックス `[0]` アクセスの前に空チェックを挿入）
  - `except ClientError as error:` ブロックの `AccessDeniedException` 処理で `return` がない問題を修正する。具体的には `raise` を追加して例外を上位に伝播させる
  - `return summary, detail, twitter` の前に、`AccessDeniedException` 後に変数が未定義のパスが存在しないことを確認する
修正後の構造（概要）:

```python
try:
    response = agent(blog_body)
    ... outputText を取得 ...
    summary_matches = re.findall(r"<summary>...", outputText)
    detail_matches  = re.findall(r"<thinking>...", outputText)
    twitter_matches = re.findall(r"<twitter>...", outputText)
    if not summary_matches or not detail_matches or not twitter_matches:
        raise ValueError(f"Missing required XML tags in response: {outputText[:300]}")
    summary = summary_matches[0]
    detail  = detail_matches[0]
    twitter = twitter_matches[0]
except ClientError as error:
    if error.response["Error"]["Code"] == "AccessDeniedException":
        print(...)
        raise   # ← 追加
    raise error
return summary, detail, twitter
```

検証方法:

- `ruff check lambda/notify-to-app/index.py` を実行する
- `summarize_blog()` が `summary` 未定義のまま `return` に到達するパスがないことをコードで確認する

#### タスク 1-B-3: スクレイピング失敗時のフォールバック処理を追加する

- 対象ファイル: `lambda/notify-to-app/index.py`
- 対象行: 403〜407行目（`push_notification()` 内）
- 作業内容:
  - `content = get_blog_content(item_url)` の直後に `None` チェックを追加する
  - 採用する方針: タイトルフォールバック方式（通知の欠落を防ぐ）

```python
content = get_blog_content(item_url)
if content is None:
    print(f"Content unavailable for {item_url}. Falling back to title only.")
    content = item["rss_title"]
```

- 補足: `continue` でスキップする方式も候補だが、タイトルだけでも要約・通知を行う方がユーザー体験として優れているため、フォールバック方式を優先する
- 検証方法:
  - `ruff check lambda/notify-to-app/index.py` を実行する
  - `content` が `None` のまま `summarize_blog()` に渡るパスがないことを確認する

---

### フェーズ2: セキュリティ・堅牢性改善（中優先度）✅ 完了

#### Phase 2-A: IAMポリシーのBedrockリソースをモデルARNに限定する ✅

#### タスク 2-A-1: `bedrock:InvokeModel` のリソース指定を絞り込む

- 対象ファイル: `lib/whats-new-summary-notifier-stack.ts`
- 対象行: 39〜43行目
- 事前確認: `cdk.json` の `modelId`（`openai.gpt-oss-120b-1:0`）がfoundation model ARNの形式で参照可能かどうかを確認する。cross-region inferenceプロファイルを使う場合はARN形式が異なるため、Bedrock APIドキュメントで `InvokeModel` に必要なARN形式を確認する
作業内容（foundation modelとして直接参照できる場合）:

```typescript
const modelArn = `arn:aws:bedrock:${modelRegion}::foundation-model/${modelId}`;
new PolicyStatement({
  actions: ['bedrock:InvokeModel'],
  effect: Effect.ALLOW,
  resources: [modelArn],
}),
```

- 注意点: cross-region inferenceを使う場合は `arn:aws:bedrock:${region}:${accountId}:inference-profile/*` のような形式が必要になる可能性があり、その場合はワイルドカードを含むARNを指定するか、複数リソースを列挙する
- 検証方法:
  - `npm run build` でTypeScriptのコンパイルエラーがないことを確認する
  - `cdk synth` でCloudFormationテンプレートが生成できることを確認する
  - 生成されたテンプレート（`cdk.out/` 内）のIAMポリシーリソースが `"*"` ではないことを確認する

---

### フェーズ3: コード品質改善（低優先度）✅ 完了

フェーズ1・2の作業が完了し、動作確認が取れてからまとめて実施します。

#### タスク 3-1: `BEDROCK_ASSUME_ROLE` の要件を確認する（実装前の調査）✅

- 作業内容: `BEDROCK_ASSUME_ROLE` 環境変数を実際に設定して使っているか、またはクロスアカウントのBedrockアクセスを今後サポートする予定があるかを確認する
- 確認場所: `lambda/notify-to-app/index.py` の 150行目 `os.environ.get("BEDROCK_ASSUME_ROLE", None)`
- 判断基準:
  - 使っていない・使う予定もない場合 → タスク3-2でAssumeRole関連コードも合わせて削除する
  - 使っている・使う予定がある場合 → Strands SDKでのAssumeRole対応方法を別途調査し、`get_bedrock_client()` を削除するのではなくStrands SDKに統合する形に変更する
- 成果物: この確認結果をタスク3-2・3-3の実施前にコメントとして本ファイルに追記する
- 調査結果: `BEDROCK_ASSUME_ROLE` はCDKスタック（`lib/whats-new-summary-notifier-stack.ts`）のどの Lambda 環境変数にも設定されていないことを確認。使用実績なし → タスク3-2で `get_bedrock_client()` および関連コードを削除した。

#### タスク 3-2: `get_bedrock_client()` 関数と `boto3_bedrock` 変数を削除する ✅

- 前提: タスク3-1で `BEDROCK_ASSUME_ROLE` が不要と確認された場合のみ実施する
- 対象ファイル: `lambda/notify-to-app/index.py`
- 作業内容:
  - 66〜128行目の `get_bedrock_client()` 関数定義を削除する
  - `summarize_blog()` 内の 149〜152行目 `boto3_bedrock = get_bedrock_client(...)` の呼び出しを削除する
  - `from botocore.config import Config` のインポートが他で使われていないことを確認してから削除する（`get_bedrock_client()` 内でのみ使用している）
  - `from botocore.exceptions import ClientError` は `summarize_blog()` の `except ClientError` で使用しているため残す
- 検証方法:
  - `ruff check lambda/notify-to-app/index.py` で未使用インポートのエラーがないことを確認する

#### タスク 3-3: コメントアウトされたBedrockの旧実装コードを削除する ✅

- 対象ファイル: `lambda/notify-to-app/index.py`
- 対象行: 297〜335行目（`## Use Bedrock API` から `#    outputText = response...` まで）
- 作業内容:
  - コメントアウトされた `converse()` API呼び出しのコードブロック全体を削除する
  - `## Use Strands API` というコメント行（337行目）も、Strands APIが唯一の実装になるため不要なコメントとして削除する
- 検証方法:
  - `ruff check lambda/notify-to-app/index.py` を実行する
  - 削除後のファイルを読み、`summarize_blog()` の構造が明確になっていることを確認する

---

### フェーズ4: テスト追加（推奨）✅ 完了

フェーズ1〜3の修正内容に対してユニットテストを追加します。テストがあることで、将来的な修正時にリグレッションを防ぐことができます。

#### タスク 4-1: `lambda/rss-crawler/` のテストファイルを作成する ✅

- 作成ファイル: `lambda/rss-crawler/test_index.py`
- テストケース:
  - `recently_published()`: 7日以内の日付 → `True`、8日以前の日付 → `False`
  - `str2datetime()`: RSSの日付文字列を正しくdatetimeに変換できること
  - `write_to_table()`: `ClientError` 発生時にエラーログを出力して例外を伝播させないこと（`moto` でDynamoDBをモック）
  - `handler()`: `event["notifierName"]` と `event["notifier"]` から正しく値を取得できること（feedparserをモック）
- 実行方法: `python -m pytest lambda/rss-crawler/test_index.py` または `ruff check` と合わせてCIに組み込む

#### タスク 4-2: `lambda/notify-to-app/` のテストファイルを作成する ✅

- 作成ファイル: `lambda/notify-to-app/test_index.py`
- テストケース:
  - `get_blog_content()`: 正常な `<main>` タグのある応答 → テキストを返すこと
  - `get_blog_content()`: `<main>` タグなし → `None` を返すこと
  - `get_blog_content()`: HTTP 5xx エラー → `None` を返すこと
  - `get_blog_content()`: 無効URL（`ftp://...`）→ `None` を返すこと
  - `get_new_entries()`: `INSERT` イベントのみフィルタリングされること
  - `get_new_entries()`: `REMOVE` / `UPDATE` イベントはスキップされること
  - `create_slack_message()`: Twitter URLが正しくエンコードされること
  - `push_notification()`: `content is None` のときタイトルフォールバックが発動すること
- 実行方法: `python -m pytest lambda/notify-to-app/test_index.py`

---

### 実施順序と依存関係

```text
Phase 1-A (rss-crawler バグ修正)
  ├── タスク 1-A-1: write_to_table() 修正
  └── タスク 1-A-2: event.values() 修正

Phase 1-B (notify-to-app バグ修正)
  ├── タスク 1-B-1: traceback 修正          ← 独立・最小変更
  ├── タスク 1-B-2: summarize_blog() 修正
  └── タスク 1-B-3: None フォールバック追加

Phase 2-A (IAMポリシー絞り込み)
  └── タスク 2-A-1: bedrock リソース ARN 指定   ← Phase 1 と独立して実施可能

Phase 3 (コード品質)
  ├── タスク 3-1: AssumeRole 要件確認（調査）   ← Phase 1 完了後に実施
  ├── タスク 3-2: get_bedrock_client() 削除     ← タスク3-1 の結果に依存
  └── タスク 3-3: コメントアウトコード削除       ← Phase 1 完了後に実施

Phase 4 (テスト追加)
  ├── タスク 4-1: rss-crawler テスト           ← Phase 1-A 完了後に実施
  └── タスク 4-2: notify-to-app テスト         ← Phase 1-B 完了後に実施
```

Phase 1 は最優先で実施します。Phase 2 は Phase 1 と並行して進めることができます。Phase 3 は Phase 1 の修正が安定してから実施します。Phase 4 のテストは各フェーズの修正直後に書くことが理想ですが、まとめて実施しても問題ありません。
