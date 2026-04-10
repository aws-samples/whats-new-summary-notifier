# Deployment Guide

## Quick Deploy (Recommended)

Deploy using [AWS CloudShell](https://console.aws.amazon.com/cloudshell/home) — no local tools required.

### 1. Create Webhook URL

#### For Slack
Refer to [Slack Workflow documentation](https://slack.com/help/articles/17542172840595-Build-a-workflow--Create-a-workflow-in-Slack). Create a workflow with 5 text variables: `rss_time`, `rss_link`, `rss_title`, `summary`, `detail`.

#### For Microsoft Teams
Refer to [Teams Incoming Webhook documentation](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook?tabs=newteams%2Cdotnet).

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
| `destination` | `slack` or `teams` |
| `summarizerName` | Name of the summarizer to use |
| `webhookUrlParameterName` | SSM Parameter Store name for Webhook URL |
| `rssUrl` | RSS feed URLs (multiple supported) |
| `schedule` | (Optional) CRON schedule for RSS polling |

**Schedule example** (every 15 minutes):
```json
"schedule": { "minute": "0/15", "hour": "*", "day": "*", "month": "*", "year": "*" }
```

## Destroy

```bash
bash deploy.sh --destroy                # default stack
bash deploy.sh --destroy --tenant test  # specific tenant
```

This automatically cleans up the CDK stack, CodeBuild project, IAM role, and SSM parameter.

For manual cleanup: `cdk destroy` or `cdk destroy -c tenant=test`
