# Deployment Guide

## Quick Deploy (Recommended)

Deploy using [AWS CloudShell](https://console.aws.amazon.com/cloudshell/home) — no local tools required.

### 1. Create Webhook URL

#### For Slack
Refer to [Slack Workflow documentation](https://slack.com/help/articles/17542172840595-Build-a-workflow--Create-a-workflow-in-Slack). Create a workflow with 5 text variables: `rss_time`, `rss_link`, `rss_title`, `summary`, `detail`.

#### For Microsoft Teams
Refer to [Teams Incoming Webhook documentation](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook?tabs=newteams%2Cdotnet).

#### For Google Chat (preview)
Google Chat support is a preview and has not been tested against a real Google Chat space yet. Refer to [Google Chat incoming webhooks](https://developers.google.com/workspace/chat/quickstart/webhooks): register a webhook in the space (Apps & integrations > Add webhooks) and copy its URL. Your Google Workspace organization must allow incoming webhooks. Keep the URL secret; it contains a token.

### 2. Deploy

Open [CloudShell](https://console.aws.amazon.com/cloudshell/home) and run:

```bash
git clone https://github.com/aws-samples/whats-new-summary-notifier.git
cd whats-new-summary-notifier
bash deploy.sh
```

The interactive wizard will ask for notification destination, language, and Webhook URL. Deployment runs via AWS CodeBuild (Docker and Node.js are handled automatically).

#### Non-Interactive Mode

```bash
bash deploy.sh --non-interactive \
  --webhook-url "https://hooks.slack.com/..." \
  --destination slack \
  --language japanese
```

## Multi-Tenant Deployment

Use `--tenant` to deploy fully isolated stacks. Useful for testing without affecting production.

```bash
bash deploy.sh --tenant test \
  --webhook-url "https://hooks.slack.com/..." \
  --destination slack \
  --language japanese \
  --non-interactive
```

### Using Config Files

Create a tenant-specific config file under `tenants/`:

```bash
cp tenants/test.example.json tenants/myteam.json
```

```json
{
  "tenant": "myteam",
  "notifiers": {
    "AwsWhatsNew": {
      "destination": "slack",
      "summarizerName": "AwsSolutionsArchitectJapanese",
      "webhookUrlParameterName": "/WhatsNew/URL/myteam",
      "rssUrl": { "What's new": "https://aws.amazon.com/about-aws/whats-new/recent/feed/" }
    }
  }
}
```

Deploy with the config file:

```bash
bash deploy.sh --config tenants/myteam.json --webhook-url "https://..."
```

Or directly with CDK:

```bash
cdk deploy -c config=tenants/myteam.json
```

**Priority order** (highest first): config file values **override** `cdk.json` defaults. Only tenant-specific differences need to be in the config file.

| Resource | Production | Test (`--tenant test`) |
|---|---|---|
| Stack Name | `WhatsNewSummaryNotifierStack` | `WhatsNewSummaryNotifier-test` |
| DynamoDB Table | Separate | Separate |
| Lambda Functions | Separate | Separate |
| EventBridge Rules | Separate | Separate |
| SSM Parameter | `/WhatsNew/URL` | `/WhatsNew/URL/test` |

## Deploy via Management Console

For a GUI-based deployment experience, use the [Management Console](CONSOLE.md):

```bash
npm run dev:console
```

The Management Console supports deploying, updating, and destroying tenants with a visual configuration editor, Bedrock model suggestions, and real-time build monitoring. It deploys from your local source code (no need to push to GitHub first).

## Manual Deploy (Advanced)

For local deployment without CodeBuild.

**Prerequisites:** Node.js 22+, Docker, [AWS CDK CLI](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html)

```bash
npm install
cdk bootstrap   # first time only
cdk synth        # verify
cdk deploy
```

For multi-tenant: `cdk deploy -c tenant=test`

## Configuration Reference

Settings are managed in `cdk.json` under `context`.

### Common Settings
| Key | Description |
|---|---|
| `modelRegion` | Source region for Bedrock API calls (default: `us-east-1`) |
| `modelIds` | Array of model IDs tried in order (fallback pool) |

### summarizers
| Key | Description |
|---|---|
| `outputLanguage` | Output language for summaries |
| `persona` | Role/persona given to the model |

### notifiers
| Key | Description |
|---|---|
| `destination` | `slack`, `teams` or `googlechat` (Google Chat is a preview, not yet tested against a real space) |
| `summarizerName` | Name of the summarizer to use |
| `webhookUrlParameterName` | SSM Parameter Store name for Webhook URL |
| `rssUrl` | RSS feed URLs (multiple supported) |
| `schedule` | (Optional) CRON schedule for RSS polling |
| `filter` | (Optional) Post only some articles, see below |

**Schedule example** (every 15 minutes):
```json
"schedule": { "minute": "0/15", "hour": "*", "day": "*", "month": "*", "year": "*" }
```

### Filtering articles (optional)
Without `filter`, every new article is summarized and posted, as before. Add `filter` to a notifier to post only some of them:

```json
"filter": {
  "categories": ["general:products/amazon-bedrock", "marketing:marchitecture/artificial-intelligence"],
  "topics": ["Building applications with generative AI"],
  "modelIds": ["global.anthropic.claude-haiku-5-5"]
}
```

| Key | Description |
|---|---|
| `categories` | (Optional) RSS category tags. An article is kept when one of its tags equals a value, or starts with the value followed by `/` (`general:products` keeps every product tag). Case-insensitive. Articles without tags are kept. Checked by the crawler, with no Bedrock call |
| `topics` | (Optional) Topics in plain text. Before summarizing, the model is asked whether the text to be summarized (the article, or its RSS description; see "How articles are read") is about one of them; only a clear "no" skips the article (`summary_status` = `filtered`). When the check fails or the answer is unclear, the article is posted |
| `modelIds` | (Optional) Models for the `topics` check, tried in order. Defaults to `modelIds`. A smaller model keeps the extra cost low |

Each `topics` check is one more Bedrock call per article that passes `categories`. Changing or removing `filter` later does not post the articles that were filtered out before. `cdk synth` fails with a message when `filter` has the wrong shape or makes the settings too large for a Lambda environment (4 KB) or an EventBridge target input (8,192 characters).

### How articles are read
The notify Lambda opens each article URL from the RSS feed and summarizes the text of its `<main>` element, or `<article>`, or `<body>` (without navigation, headers, footers and scripts), up to 50,000 characters. When the page cannot be fetched or has less than 200 characters of text, the RSS description of the entry is summarized instead; the entry is skipped only when neither is available. `summary_source` in the DynamoDB item shows which one was used.

Requests send a `whats-new-summary-notifier` User-Agent and go only to public `http`/`https` addresses (checked again on every redirect, at most 5), with a 10-second timeout, a 20-second limit for the whole download and a 5 MB size limit.

## Destroy

```bash
bash deploy.sh --destroy                # default stack
bash deploy.sh --destroy --tenant test  # specific tenant
```

The script deletes the CDK stack with a CodeBuild build and waits for that build to finish. When the build succeeds, it cleans up the CodeBuild project, IAM role, and SSM parameter. When the build fails, it keeps them and exits with an error, so you can check the build logs and run the same command again.

For manual cleanup: `cdk destroy` or `cdk destroy -c tenant=test`
