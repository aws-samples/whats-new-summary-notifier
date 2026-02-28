# F1 Prompt Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Revise the `Formula1ProfessionalJapanese` prompt in `lambda/notify-to-app/index.py` to use F1-specific reasoning steps and per-topic bullet-point summaries instead of the AWS-derived 2-3 sentence prose format.

**Architecture:** Only one file changes: `lambda/notify-to-app/index.py`. The `elif summarizer_name == "Formula1ProfessionalJapanese":` branch (currently lines 113–221) is modified in-place. The XML tag structure (`<thinking>`, `<summary>`, `<twitter>`), glossary, and all other summarizer branches are untouched.

**Tech Stack:** Python 3.12, prompt string embedded in source (no external config files).

---

### Task 1: Replace the `<instruction>` section

**Files:**
- Modify: `lambda/notify-to-app/index.py:122-133` (the `<instruction>…</instruction>` block inside the F1 branch)

**Context:** The current instruction enumerates five bullet-point questions borrowed from the AWS summarizer. Replace them with the three-step reasoning process defined in the design doc.

**Step 1: Locate the exact block to replace**

Open `lambda/notify-to-app/index.py` and find the `<instruction>` block (starts around line 122, ends around line 133). It currently reads:

```
<instruction>
Analyze the Formula 1 news in <input></input> tags and provide comprehensive insights covering:
- What is the main F1-related development or news story being reported
- Which F1 teams, drivers, circuits, or officials are involved
- How this impacts the current F1 season, championships, or future races
- What are the technical, regulatory, or strategic implications
- Why this news matters to F1 fans, teams, or the sport overall
...
</instruction>
```

**Step 2: Replace with the new 3-step instruction**

The new block must read (preserve the surrounding whitespace/indentation exactly as it appears in the f-string):

```
<instruction>
Analyze the Formula 1 or motorsport article in <input></input> tags using the following three steps.

STEP 1: Identify all categories present in the article. For each category below, state true or false:
- レース結果 (race result)
- 予選・フリー走行 (qualifying / practice)
- スプリント (sprint)
- 技術・レギュレーション (technical / regulation)
- ドライバー/チーム人事 (driver / team personnel)
- コメント・インタビュー (comment / interview)
- 次戦プレビュー (next race preview)
- その他 (other)

STEP 2: For each category marked true, extract key points:
- Involved driver names, team names, and circuit names
- Numeric results (position, time, points, lap times) where available
- Regulatory context or technical background
- One notable quote (one sentence max) if relevant

STEP 3: Select the single most important category for the twitter output and briefly explain why it is the most newsworthy item.

Output your reasoning in <thinking></thinking> tags following the three steps above.
Create a bullet-point summary following <summaryRule></summaryRule> and format according to <outputFormat></outputFormat>.
Generate a Twitter-ready summary for the <twitter></twitter> section following <twitterRules></twitterRules>.
</instruction>
```

Note: also remove the sentence that currently follows the five bullets:

```
When writing in Japanese: Use ONLY the Japanese translations from the <glossary> for names, teams, and technical terms. Do NOT use English names in <summary> or <twitter>. Do NOT invent your own katakana; use the glossary form exactly.

Output your analysis in <thinking></thinking> tags using bullet points (each starting with "- " and ending with "\n").
Create an engaging summary following <summaryRule></summaryRule> and format according to <outputFormat></outputFormat>.
Generate a Twitter-ready summary for the <twitter></twitter> section following <twitterRules></twitterRules>.
```

Replace it with a single line at the end of the new instruction:

```
When writing in Japanese: Use ONLY the Japanese translations from the <glossary> for names, teams, and technical terms. Do NOT use English names in <summary> or <twitter>. Do NOT invent your own katakana; use the glossary form exactly.
```

**Step 3: Verify the file is syntactically valid**

```bash
cd /home/tsuyoshi/go/src/github.com/revsystem/whats-new-summary-notifier
python3 -c "import ast; ast.parse(open('lambda/notify-to-app/index.py').read()); print('OK')"
```

Expected output: `OK`

**Step 4: Commit**

```bash
git add lambda/notify-to-app/index.py
git commit -m "feat: replace F1 instruction with 3-step reasoning process"
```

---

### Task 2: Replace `<summaryRule>`

**Files:**
- Modify: `lambda/notify-to-app/index.py` — the `<summaryRule>…</summaryRule>` tag inside the F1 branch (currently one line around line 206)

**Context:** The current rule forces a 2-3 sentence prose summary. Replace it with the per-topic bullet-point format.

**Step 1: Locate the current summaryRule**

```
<summaryRule>The final summary must be 2-3 sentences that capture the significance of the F1 news, explaining what happened and why it matters to fans in a professional tone. When writing in Japanese: use ONLY the Japanese forms from the glossary for all driver names, team names, and technical terms—no English names in the summary.</summaryRule>
```

**Step 2: Replace with the new summaryRule**

```
<summaryRule>
Summarize each topic present in the article as a separate bullet point.
Each bullet MUST begin with an AI-chosen Japanese sub-heading that reflects the content, followed by a colon (e.g., 「開幕戦結果:」「FIA規則変更:」「サインツ移籍:」).
Keep each bullet to 1-2 sentences. Do not force multiple topics into a prose paragraph.
If the article covers only one topic, a single bullet is sufficient.
When writing in Japanese: use ONLY the Japanese forms from the glossary for all driver names, team names, and technical terms—no English names in the summary.
</summaryRule>
```

**Step 3: Verify syntax**

```bash
python3 -c "import ast; ast.parse(open('lambda/notify-to-app/index.py').read()); print('OK')"
```

Expected: `OK`

**Step 4: Commit**

```bash
git add lambda/notify-to-app/index.py
git commit -m "feat: change F1 summaryRule to per-topic bullet-point format"
```

---

### Task 3: Update `<twitterRules>` for multi-topic constraint

**Files:**
- Modify: `lambda/notify-to-app/index.py` — the `<twitterRules>…</twitterRules>` block inside the F1 branch

**Context:** The twitter section must cover only the single most important topic when the article is multi-topic.

**Step 1: Locate the current twitterRules block**

The block currently ends with:
```
- When writing in Japanese: use ONLY glossary Japanese for names, teams, and terms—no English in the tweet
```

**Step 2: Append two new rules before the closing tag**

```
- If the article covers multiple topics, tweet about only the most important one (selected in STEP 3 of your reasoning). Do not attempt to cover all topics in 200 characters.
- State the key fact (who, what, result or decision) in one tight sentence.
```

**Step 3: Verify syntax**

```bash
python3 -c "import ast; ast.parse(open('lambda/notify-to-app/index.py').read()); print('OK')"
```

Expected: `OK`

**Step 4: Commit**

```bash
git add lambda/notify-to-app/index.py
git commit -m "feat: add multi-topic constraint to F1 twitterRules"
```

---

### Task 4: Update `<outputFormat>` summary description

**Files:**
- Modify: `lambda/notify-to-app/index.py` — the `<outputFormat>…</outputFormat>` line inside the F1 branch (currently the last line of the prompt string, around line 218)

**Context:** The outputFormat description for `<summary>` still says "professional summary". Update it to describe the bullet list.

**Step 1: Locate the current outputFormat**

```
<outputFormat><thinking>(detailed bullet point analysis of the F1 news)</thinking><summary>(professional summary; if Japanese, all proper nouns and technical terms MUST use the exact forms from the glossary)</summary><twitter>(Twitter-ready summary within 200 characters; if Japanese, all names/teams/terms MUST be in glossary Japanese only)</twitter></outputFormat>
```

**Step 2: Replace the summary description**

Change only the `<summary>` description part:

Old:
```
<summary>(professional summary; if Japanese, all proper nouns and technical terms MUST use the exact forms from the glossary)</summary>
```

New:
```
<summary>(bullet list — one bullet per topic detected in STEP 1, each starting with an AI-chosen Japanese sub-heading and a colon; 1-2 sentences per bullet; all proper nouns and technical terms MUST use exact glossary forms)</summary>
```

Also update the `<thinking>` description to reflect the 3-step structure:

Old:
```
<thinking>(detailed bullet point analysis of the F1 news)</thinking>
```

New:
```
<thinking>(3-step reasoning: STEP 1 category list, STEP 2 key points per category, STEP 3 most important category for twitter)</thinking>
```

**Step 3: Verify syntax**

```bash
python3 -c "import ast; ast.parse(open('lambda/notify-to-app/index.py').read()); print('OK')"
```

Expected: `OK`

**Step 4: Verify the FINAL CHECK line is still present and correct**

The prompt ends with a FINAL CHECK instruction reminding the model to use glossary Japanese. Confirm this line is still present after the outputFormat tag.

**Step 5: Commit**

```bash
git add lambda/notify-to-app/index.py
git commit -m "feat: update F1 outputFormat to describe bullet-list summary"
```

---

### Task 5: Lint and final review

**Files:**
- Read: `lambda/notify-to-app/index.py` (full file, confirm overall coherence)

**Step 1: Run ruff linter**

```bash
cd /home/tsuyoshi/go/src/github.com/revsystem/whats-new-summary-notifier
ruff check lambda/notify-to-app/index.py
```

Expected: no errors.

**Step 2: Manually read the full F1 prompt block**

Read lines 113–225 and confirm:
- `<persona>` — unchanged
- `<glossary_compliance_priority>` — unchanged
- `<instruction>` — 3-step STEP 1/2/3 format, ends with glossary reminder
- `<glossary>` — unchanged (names, teams, technical_terms)
- `<outputLanguage>` — unchanged
- `<summaryRule>` — bullet-point format with sub-heading rule
- `<twitterRules>` — original 6 rules + 2 new multi-topic rules
- `<outputFormat>` — updated thinking and summary descriptions
- FINAL CHECK — unchanged

**Step 3: Commit (if any lint fixes were needed)**

```bash
git add lambda/notify-to-app/index.py
git commit -m "fix: apply ruff lint fixes to F1 prompt block"
```

(Skip this step if ruff reported no issues.)
