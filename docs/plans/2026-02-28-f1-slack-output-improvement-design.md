# F1 Slack Output Improvement Design

Date: 2026-02-28

## Background

After deploying the F1 prompt redesign (PR #10), the Slack output was reviewed
and found to be unsatisfactory. The `detail` field (thinking tag content with
STEP 1/2/3 reasoning) was being rendered verbatim in Slack, making the message
read like an internal analysis document rather than a news summary.

Additionally, the `summary` field used a bullet-point format that felt analytical
rather than journalistic. Users want to read the news naturally in Slack and
share it on X if they resonate with it.

## Goals

1. Remove `detail` from the Slack message so only the readable summary is shown.
2. Change `summary` from bullet-point format to flowing journalist-style prose
   that reads naturally and is share-worthy.

## Non-Goals

- Changing the `twitter` section or its rules.
- Removing `detail` from the Lambda return value (keep it for log debugging).
- Changing the 3-step STEP 1/2/3 reasoning in `<instruction>` (keep for model quality).
- Changing any other summarizer (`AwsSolutionsArchitectJapanese`, etc.).

## Approach

### Change 1: Rewrite `summaryRule` in the F1 prompt

Old:
```
Summarize each topic present in the article as a separate bullet point.
Each bullet MUST begin with an AI-chosen Japanese sub-heading that reflects
the content, followed by a colon...
```

New:
```
Write a flowing 2-4 sentence summary in the style of a professional F1 journalist.
If the article covers multiple topics, weave them together naturally in prose—do
not use bullet points or sub-headings. The summary should be engaging enough that
readers who follow F1 would want to share it. Write as if reporting for a Japanese
motorsport publication.
When writing in Japanese: use ONLY the Japanese forms from the glossary for all
driver names, team names, and technical terms—no English names in the summary.
```

### Change 2: Update `outputFormat` summary description

Old:
```
<summary>(bullet list — one bullet per topic detected in STEP 1, each starting
with an AI-chosen Japanese sub-heading and a colon; 1-2 sentences per bullet;
all proper nouns and technical terms MUST use exact glossary forms)</summary>
```

New:
```
<summary>(2-4 sentence journalist-style prose summary; weave multiple topics
naturally if present; no bullet points or sub-headings; all proper nouns and
technical terms MUST use exact glossary forms)</summary>
```

### Change 3: Remove `detail` from `create_slack_message`

In `create_slack_message`, remove the line:
```python
f"{item['detail']}\n" \
```

The `detail` field remains in `item` and will continue to appear in CloudWatch
Logs via the existing `print("push_msg:{}".format(msg))` call (through `item`
being printed earlier in `push_notification`).

## Resulting Slack Message Format

```
2026-02-28
<article-link|article-title>
バーレーンのフリー走行でフェルスタッペンがレッドブルのワンツーをリードした。
フェラーリに移籍したハミルトンは新チームでのデビュー戦で印象的な走りを見せ、
興味深い開幕戦となった。
Share on X
```

## Files to Change

- `lambda/notify-to-app/index.py`:
  - `summaryRule` in the `Formula1ProfessionalJapanese` branch
  - `outputFormat` `<summary>` description in the same branch
  - `create_slack_message` function (remove `detail` line)
