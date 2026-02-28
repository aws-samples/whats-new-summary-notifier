# F1 Prompt Redesign for Formula1ProfessionalJapanese

Date: 2026-02-28

## Background

The `Formula1ProfessionalJapanese` summarizer block was originally derived from
`AwsSolutionsArchitectJapanese`. The AWS-oriented prompt focuses on structured
analysis of tech announcements (new feature, affected services, technical
benefits, target audience). Those dimensions are not meaningful for F1 and
motorsport journalism.

Additionally, F1 news articles frequently contain multiple unrelated topics in a
single feed entry (e.g., race result + regulatory update + driver transfer). The
current 2-3 sentence prose `summaryRule` produces awkward, run-on summaries when
the article covers heterogeneous topics.

## Goals

1. Replace the AWS-derived analysis dimensions with F1/motorsport-specific ones.
2. Handle multi-topic articles naturally by emitting one bullet point per topic
   instead of forcing everything into a prose paragraph.
3. Add an explicit article-categorization step inside the thinking process so the
   model can adapt its sub-headings to the content type.
4. Keep the twitter section focused on the single most important topic (200 chars).

## Non-Goals

- Changing the glossary or `glossary_compliance_priority` section.
- Changing the output XML tag structure (`<thinking>`, `<summary>`, `<twitter>`).
- Changing the `twitterRules` beyond adding the multi-topic constraint.
- Modifying `AwsSolutionsArchitectJapanese` or any other summarizer.

## Approach: Topic Detection + Dynamic Bullet List

The `thinking` tag will contain a structured reasoning process:

- **STEP 1** — Categorize the article. Possible categories: race result,
  qualifying/practice, sprint, technical/regulation, driver or team personnel,
  comment/interview, next race preview, other. Enumerate which categories are
  present (true/false).
- **STEP 2** — Extract key points per present category: driver/team/circuit names,
  numeric results (position, time, points), regulatory background, notable quotes
  (one sentence max).
- **STEP 3** — Select the single most important category for the twitter output.

The `<summary>` tag will contain one bullet point per detected topic. Each
bullet starts with an AI-chosen Japanese sub-heading that reflects the content
(e.g., `開幕戦結果:`, `FIA規則変更:`, `サインツ移籍:`). If the article covers
only one topic, a single bullet is emitted. Each bullet is 1-2 sentences.

The `<twitter>` tag covers the STEP 3 winner only.

## Changes to `summaryRule`

Old:
> The final summary must be 2-3 sentences that capture the significance of the
> F1 news, explaining what happened and why it matters to fans in a professional
> tone.

New:
> Summarize each topic present in the article as a separate bullet point.
> Each bullet must begin with an AI-chosen Japanese sub-heading followed by a
> colon (e.g., 「開幕戦結果:」). Keep each bullet to 1-2 sentences.
> If the article has only one topic, a single bullet is sufficient.
> Do not force multiple topics into a prose paragraph.

## Changes to `instruction`

Replace the current five bullet questions with the three-step reasoning process:

```
STEP 1: Identify all categories present in the article.
  Possible categories:
  - レース結果 (race result)
  - 予選・フリー走行 (qualifying / practice)
  - スプリント (sprint)
  - 技術・レギュレーション (technical / regulation)
  - ドライバー/チーム人事 (driver / team personnel)
  - コメント・インタビュー (comment / interview)
  - 次戦プレビュー (next race preview)
  - その他 (other)
  List each with true/false.

STEP 2: For each true category, extract key points:
  - Involved driver names, team names, circuit names
  - Numeric results (position, time, points, lap times) if available
  - Regulatory context or technical background
  - One notable quote (one sentence max) if relevant

STEP 3: Select the single most important category for the twitter output and
  note why it is the most newsworthy.
```

## Changes to `twitterRules`

Append to the existing rules:

```
- If the article covers multiple topics, cover only the most important one
  (selected in STEP 3) in the tweet. Do not attempt to summarize all topics.
```

## Changes to `outputFormat`

Old:
```
<summary>(professional summary; if Japanese, all proper nouns and technical
terms MUST use the exact forms from the glossary)</summary>
```

New:
```
<summary>(bullet list; one bullet per topic; each bullet starts with an
AI-chosen Japanese sub-heading followed by a colon; 1-2 sentences per bullet;
all proper nouns and technical terms MUST use exact glossary forms)</summary>
```

## Files to Change

- `lambda/notify-to-app/index.py` — the `Formula1ProfessionalJapanese` branch of
  `summarize_blog()`

No other files need to change.
