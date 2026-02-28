# F1 Slack Output Improvement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the F1 Slack notification show readable journalist-style prose instead of bullet points and internal reasoning steps.

**Architecture:** Two kinds of changes in a single file (`lambda/notify-to-app/index.py`): (1) update two strings inside the F1 prompt template to change how the LLM formats its summary, and (2) remove one line from `create_slack_message` so the internal reasoning (`detail`) is no longer sent to Slack.

**Tech Stack:** Python 3.12, prompt string embedded in source.

---

### Task 1: Rewrite `<summaryRule>` to journalist-style prose

**Files:**
- Modify: `lambda/notify-to-app/index.py` — `<summaryRule>…</summaryRule>` block inside the `Formula1ProfessionalJapanese` branch (around line 206)

**Step 1: Locate the current summaryRule block**

It currently reads:

```
<summaryRule>
Summarize each topic present in the article as a separate bullet point.
Each bullet MUST begin with an AI-chosen Japanese sub-heading that reflects the content, followed by a colon (e.g., 「開幕戦結果:」「FIA規則変更:」「サインツ移籍:」).
Keep each bullet to 1-2 sentences. Do not force multiple topics into a prose paragraph.
If the article covers only one topic, a single bullet is sufficient.
When writing in Japanese: use ONLY the Japanese forms from the glossary for all driver names, team names, and technical terms—no English names in the summary.
</summaryRule>
```

**Step 2: Replace it with the journalist-prose rule**

New content:

```
<summaryRule>
Write a flowing 2-4 sentence summary in the style of a professional F1 journalist.
If the article covers multiple topics, weave them together naturally in prose—do not use bullet points or sub-headings.
The summary should be engaging enough that readers who follow F1 would want to share it.
Write as if reporting for a Japanese motorsport publication.
When writing in Japanese: use ONLY the Japanese forms from the glossary for all driver names, team names, and technical terms—no English names in the summary.
</summaryRule>
```

**Step 3: Verify Python syntax**

```bash
python3 -c "import ast; ast.parse(open('lambda/notify-to-app/index.py').read()); print('OK')"
```

Expected: `OK`

**Step 4: Commit**

```bash
git add lambda/notify-to-app/index.py
git commit -m "feat: change F1 summaryRule to journalist-style prose"
```

---

### Task 2: Update `<outputFormat>` summary description

**Files:**
- Modify: `lambda/notify-to-app/index.py` — the `<outputFormat>` line inside the `Formula1ProfessionalJapanese` branch (around line 226)

**Step 1: Locate the current outputFormat line**

It currently contains this `<summary>` description within the single-line `<outputFormat>` tag:

```
<summary>(bullet list — one bullet per topic detected in STEP 1, each starting with an AI-chosen Japanese sub-heading and a colon; 1-2 sentences per bullet; all proper nouns and technical terms MUST use exact glossary forms)</summary>
```

**Step 2: Replace only the `<summary>` description**

Change it to:

```
<summary>(2-4 sentence journalist-style prose summary; weave multiple topics naturally if present; no bullet points or sub-headings; all proper nouns and technical terms MUST use exact glossary forms)</summary>
```

The `<thinking>` and `<twitter>` descriptions in the same `<outputFormat>` line remain unchanged.

**Step 3: Verify Python syntax**

```bash
python3 -c "import ast; ast.parse(open('lambda/notify-to-app/index.py').read()); print('OK')"
```

Expected: `OK`

**Step 4: Commit**

```bash
git add lambda/notify-to-app/index.py
git commit -m "feat: update F1 outputFormat to reflect prose summary"
```

---

### Task 3: Remove `detail` from `create_slack_message`

**Files:**
- Modify: `lambda/notify-to-app/index.py` — `create_slack_message` function (around line 378)

**Step 1: Locate the current message block**

```python
message = {
    "text": f"{item['rss_time']}\n" \
            f"<{item['rss_link']}|{item['rss_title']}>\n" \
            f"{item['summary']}\n" \
            f"{item['detail']}\n" \
            f"<https://x.com/intent/tweet?url={encoded_rss_link}&text={encoded_twitter_text}|Share on X>"
}
```

**Step 2: Remove the `detail` line**

```python
message = {
    "text": f"{item['rss_time']}\n" \
            f"<{item['rss_link']}|{item['rss_title']}>\n" \
            f"{item['summary']}\n" \
            f"<https://x.com/intent/tweet?url={encoded_rss_link}&text={encoded_twitter_text}|Share on X>"
}
```

**Step 3: Verify Python syntax**

```bash
python3 -c "import ast; ast.parse(open('lambda/notify-to-app/index.py').read()); print('OK')"
```

Expected: `OK`

**Step 4: Run ruff to confirm no lint issues**

```bash
ruff check lambda/notify-to-app/index.py
```

Expected: `All checks passed!`

**Step 5: Confirm `detail` is still logged**

In `push_notification`, the line `print("push_msg:{}".format(msg))` prints the Slack message but NOT `detail`. However, `item` (which contains `detail`) is printed earlier via `print(new_data)` in `get_new_entries` — that only has the RSS fields, not `detail`.

To preserve the ability to inspect the thinking content in CloudWatch Logs, confirm that `summarize_blog` logs are sufficient, or optionally add a debug print. No code change is strictly required here — the `detail` content will still appear in the Lambda log as part of the Strands agent's own output.

**Step 6: Commit**

```bash
git add lambda/notify-to-app/index.py
git commit -m "feat: remove detail (thinking) from Slack message"
```

---

### Task 4: Deploy and verify

**Step 1: Deploy**

```bash
PATH="$PATH:/mnt/c/Program Files/Docker/Docker/resources/bin" cdk deploy --require-approval never --profile production
```

Expected: `✅  WhatsNewSummaryNotifierStack`

**Step 2: Invoke Lambda with test event**

```bash
cat > /tmp/test_event.json << 'EOF'
{
  "Records": [
    {
      "eventName": "INSERT",
      "dynamodb": {
        "NewImage": {
          "category": {"S": "Latest F1 News"},
          "pubtime": {"S": "2026-02-28"},
          "title": {"S": "Verstappen leads Red Bull one-two as Hamilton impresses on Ferrari debut"},
          "url": {"S": "https://www.racefans.net/2025/02/27/verstappen-leads-red-bull-one-two-in-bahrain-practice-as-hamilton-impresses-on-ferrari-debut/"},
          "notifier_name": {"S": "F1WhatsNew"}
        }
      }
    }
  ]
}
EOF

aws lambda invoke \
  --function-name "WhatsNewSummaryNotifierStac-NotifyNewEntry0DE3CAEC-sGl6B7Jh1WYe" \
  --payload file:///tmp/test_event.json \
  --cli-binary-format raw-in-base64-out \
  --profile production \
  /tmp/lambda_response.json
```

Expected: `"StatusCode": 200`

**Step 3: Check logs**

```bash
aws logs tail /aws/lambda/NotifyNewEntry --since 3m --profile production
```

Verify in the log:
- `push_msg` text does NOT contain `STEP 1:`, `STEP 2:`, `STEP 3:` — confirms `detail` is gone from Slack
- `push_msg` text contains a flowing Japanese sentence (not bullet points)
- Slack channel receives the notification with the new format
