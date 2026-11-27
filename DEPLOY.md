# Deployment Guide

## Quick Deploy (Recommended)

Deploy using [AWS CloudShell](https://console.aws.amazon.com/cloudshell/home) — no local tools required.

### 1. Create Webhook URL

#### For Slack
Refer to [Slack Workflow documentation](https://slack.com/help/articles/17542172840595-Build-a-workflow--Create-a-workflow-in-Slack). Create a workflow with 5 text variables: `rss_time`, `rss_link`, `rss_title`, `summary`, `detail`.

#### For Microsoft Teams
Microsoft retired Office 365 connectors in Teams, including the connector-based Incoming Webhook, in May 2026. Create the webhook with the Workflows app instead ([Create an Incoming Webhook](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook), [Send messages in Teams using incoming webhooks](https://support.microsoft.com/en-us/office/send-messages-in-teams-using-incoming-webhooks-323660ec-12ca-40b1-a1d3-a3df47e808c4)):

1. In Teams, go to the channel, select **More options (...)** next to it, and select **Workflows**.
2. Select the **Send webhook alerts to a channel** template. The notifier sends no sign-in token, so the templates "from specific people" and "from people in an org" do not work with it.
3. Choose the team and channel, select **Save**, and copy the webhook URL shown on the workflow's details page.

Posts appear under the Workflows bot. Anyone who has the URL can post to the channel, so keep it secret. The workflow belongs to the person who created it; add a co-owner so that it keeps working if that person leaves.

If you deployed with a connector URL before, it no longer works. Create a workflow as above and put its URL in the same SSM parameter (`/WhatsNew/URL`, or `/WhatsNew/URL/<tenant>`), for example by editing the parameter in Systems Manager Parameter Store or by running `bash deploy.sh` again. The notify Lambda reads the parameter for every article, so it uses the new URL without a redeploy.

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

If you deployed before the stack created its own log groups, an update moves the Lambda logs to two new log groups whose names start with the stack name (see [Lambda logs](#lambda-logs)). The old `/aws/lambda/...` log groups stay and get no new events; their events expire after 14 days. Metric filters, subscription filters, and saved Logs Insights queries on the old log groups stop matching new logs, so point them at the new log groups.

#### Non-Interactive Mode

```bash
bash deploy.sh --non-interactive \
  --webhook-url "https://hooks.slack.com/..." \
  --destination slack \
  --language japanese
  # optional: --alarm-email ops@example.com  (see "Alarm notifications")
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
The notify Lambda opens each article URL from the RSS feed and summarizes the text of its `<main>` element, or `<article>`, or `<body>` (without navigation, headers, footers and scripts), up to 50,000 characters. When the page cannot be fetched or has less than 200 characters of text, the RSS description of the entry is summarized instead; when neither is available, the article is not posted and its item gets `summary_status` = `failed`. `summary_source` in the DynamoDB item shows which one was used.

Requests send a `whats-new-summary-notifier` User-Agent and go only to public `http`/`https` addresses (checked again on every redirect, at most 5), with a 10-second timeout, a 20-second limit for the whole download and a 5 MB size limit.

### When an article is not notified
Some failures before the post may not happen again on a later attempt: Bedrock throttling or a 5xx error, a webhook that answers 429 or 5xx, a connection that cannot be made, or a timeout. For these, the notify Lambda fails, and Lambda retries the article up to 2 times. An article that has waited in the stream for more than 6 hours is not retried.

Any other failure (no text to summarize, a webhook 4xx, no access to the model) is written to the DynamoDB item as `summary_status` = `failed` with a `failure_reason`, and the article is not retried. When the webhook request was sent but no answer came back within 10 seconds, the article is also marked `failed`, because it may already have been posted. A retry never posts an article twice.

When the retries do not help, Lambda sends a message about the failed stream record (not the article itself) to the SQS queue whose name contains `NotifyFailureQueue`, which keeps messages for 14 days. The stack creates two CloudWatch alarms: one when that queue has a message, and one when the notify Lambda is more than 30 minutes behind the stream (`IteratorAge`). They have no actions unless you set `alarms` (see "Alarm notifications"). To find articles that were not posted, look for items whose `summary_status` is `failed`, or is not set on an item without a `filter_result`.

### Alarm notifications (optional)
Without `alarms`, the stack's CloudWatch alarms have no actions and nobody is told when they go into ALARM. Add `alarms` to `cdk.json` (or to a tenant config file) to send an email, or a message to your own SNS topic, when any of the stack's alarms goes into ALARM and when it returns to OK:

```json
"alarms": { "email": "ops@example.com" }
```

```json
"alarms": { "topicArn": "arn:aws:sns:us-east-1:<account ID>:my-alarm-topic" }
```

| Key | Description |
|---|---|
| `email` | The stack creates an SNS topic and an email subscription to it. The topic only accepts requests over TLS and only lets CloudWatch alarms of this account publish to it. It is not encrypted at rest: CloudWatch alarms cannot publish to a topic encrypted with the AWS managed key `alias/aws/sns`, and the notifications carry alarm names, states and thresholds only |
| `topicArn` | An existing SNS standard topic in the stack's Region (for example one that forwards to Slack with Amazon Q Developer in chat applications). The stack only adds it to the alarms' actions and does not change the topic or its policy, so the topic policy must let `cloudwatch.amazonaws.com` publish. Use this for a topic encrypted with a customer managed key; the key policy must also let `cloudwatch.amazonaws.com` use `kms:Decrypt` and `kms:GenerateDataKey*` |

Set one of the two, not both. `cdk synth` stops with a message when the value has the wrong shape or the topic is in another Region. With `deploy.sh`, pass `--alarm-email <address>` or `--alarm-topic-arn <ARN>` (the interactive wizard also asks for an email); the script sends it to the build as `alarms`. Pass the same option on every update: an update without it removes the notifications. The Management Console has an "Alarm notifications" section in the GUI editor, and an update pre-fills it with the setting the stack was deployed with.

- **Confirm the subscription.** After the deploy, SNS sends a confirmation email to the address. Nothing is delivered until someone clicks the link in it (check the spam folder). SNS deletes a subscription that is not confirmed within 48 hours. Deploying again with the same address does not send a new confirmation email, because the stack's subscription resource has not changed: change `email` to another value (or remove it) and deploy, then set it back and deploy again, or subscribe the address again in the SNS console (that subscription is then outside the stack).
- **Test it.** After confirming, `aws cloudwatch set-alarm-state --alarm-name <alarm name> --state-value ALARM --state-reason test` sends one notification; the alarm returns to its real state at the next evaluation.
- **Actions added by hand.** Without `alarms`, the update does not change the existing alarms, so an action you added in the CloudWatch console stays. Once you set `alarms`, CloudFormation rewrites the alarms with the stack's actions only, and an action added by hand is removed: put that topic in `topicArn` instead.
- **Do not commit an email address to a public fork.** Put `alarms` in a tenant config file that you do not commit (`cdk deploy -c config=tenants/myteam.json`), or pass it on the command line: `cdk deploy -c alarms='{"email":"ops@example.com"}'`.

### Lambda logs
Each Lambda function writes to a log group that the stack creates and keeps for 14 days. CloudFormation names it: `<stack name>-NotifyNewEntryLogGroup...` for the notify Lambda and `<stack name>-NewsCrawlerLogGroup...` for the crawler. To find them:

```bash
aws logs describe-log-groups --log-group-name-prefix WhatsNewSummaryNotifier --query 'logGroups[].logGroupName'
```

For 14 days after an update from an earlier version, older events are still in `/aws/lambda/<stack name>-NotifyNewEntry...` and `/aws/lambda/<stack name>-newsCrawler...`. Select both log groups in Logs Insights to search across the update.

## Destroy

```bash
bash deploy.sh --destroy                # default stack
bash deploy.sh --destroy --tenant test  # specific tenant
```

The script deletes the CDK stack with a CodeBuild build and waits for that build to finish. When the build succeeds, it cleans up the CodeBuild project, IAM role, and SSM parameter. When the build fails, it keeps them and exits with an error, so you can check the build logs and run the same command again.

If the script stops while it waits for the build (you press Ctrl+C, close the terminal, or the CloudShell session ends), the build keeps running in CodeBuild, but the cleanup does not run, so the CodeBuild project, IAM role, and SSM parameter stay. Run the same `deploy.sh --destroy` command again. It starts another destroy build, which succeeds even when the stack is already gone, and then cleans up the three resources.

For manual cleanup: `cdk destroy` or `cdk destroy -c tenant=test`

### What remains after destroy

Deleting the stack does not delete everything. These resources stay in the account and Region.

| Resource | Name | Why it stays |
|---|---|---|
| DynamoDB table (the RSS history) | `<stack name>-WhatsNewRSSHistory...` | The table uses the CDK default removal policy `RETAIN`, so CloudFormation skips it (`DELETE_SKIPPED`) |
| Lambda log groups (2) | `<stack name>-NotifyNewEntryLogGroup...`, `<stack name>-NewsCrawlerLogGroup...` | Their removal policy keeps the logs when the stack is deleted (`DELETE_SKIPPED`) |
| Older Lambda log groups (3, only for stacks first deployed before the stack created its own log groups) | `/aws/lambda/<stack name>-NotifyNewEntry...`, `-newsCrawler...`, `-LogRetention...` | They were created outside the stack by the earlier `logRetention` setting |
| CodeBuild log group | `/aws/codebuild/whats-new-summary-notifier[-<tenant>]` | CodeBuild creates it; `deploy.sh` deletes the project but not its logs |
| CDKToolkit stack and its assets bucket | `CDKToolkit`, `cdk-hnb659fds-assets-<account>-<region>` | Created by `cdk bootstrap` and shared by every CDK app in the account and Region. Deleting CDKToolkit also keeps the bucket (`DELETE_SKIPPED`) |

`<stack name>` is `WhatsNewSummaryNotifierStack`, or `WhatsNewSummaryNotifier-<tenant>` for a tenant (long names are shortened in the log group names). To remove them, after the destroy has finished:

```bash
# DynamoDB table (this deletes the stored articles and their summaries)
aws dynamodb list-tables --query "TableNames[?contains(@, 'WhatsNewRSSHistory')]"
aws dynamodb delete-table --table-name <table name>

# Log groups
aws logs describe-log-groups --log-group-name-prefix WhatsNewSummaryNotifier --query 'logGroups[].logGroupName'
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/WhatsNewSummaryNotifier --query 'logGroups[].logGroupName'
aws logs describe-log-groups --log-group-name-prefix /aws/codebuild/whats-new-summary-notifier --query 'logGroups[].logGroupName'
aws logs delete-log-group --log-group-name <log group name>
```

Delete CDKToolkit only when no other CDK app in the account and Region uses it. The assets bucket is versioned, so delete every object version and delete marker before you delete the bucket (for example, empty it in the S3 console, then delete it). The tables and log groups of other tenants and other stacks may match the same prefixes, so check each name before you delete it.
