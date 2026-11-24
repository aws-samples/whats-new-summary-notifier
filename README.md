# Whats New Summary Notifier

**[日本語はこちら](README_ja.md)**

**Whats New Summary Notifier** is a sample implementation of a generative AI application that summarizes the content of AWS What's New and other web articles in multiple languages when there is an update, and delivers the summary to Slack, Microsoft Teams or Google Chat (preview).

<p align="center">
  <img alt="example" src="doc/example_en.png" width="50%" />
</p>

## Architecture

This stack create following architecture.

![architecture](doc/architecture.png)

## Prerequisites
- AWS Account with [CloudShell](https://console.aws.amazon.com/cloudshell/home) access
- Webhook URL for Slack, Microsoft Teams or Google Chat (preview)
- (For manual deploy only) Node.js 22+, Docker, [AWS CDK CLI](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html)

## Deployment Steps

### Create Webhook URL

#### For Slack
Refer to [this documentation](https://slack.com/help/articles/17542172840595-Build-a-workflow--Create-a-workflow-in-Slack) to create the Webhook URL. Select "Add a Variable" and create the following 5 variables, all with the Text data type:

* `rss_time`: The time the article was posted
* `rss_link`: The URL of the article
* `rss_title`: The title of the article
* `summary`: A summary of the article
* `detail`: A bulleted description of the article

#### For Microsoft Teams
Microsoft retired Office 365 connectors in Teams, including the connector-based Incoming Webhook, in May 2026. Create the webhook with the Workflows app: in the channel, select **More options (...)** > **Workflows**, pick the **Send webhook alerts to a channel** template, choose the team and channel, select **Save**, and copy the webhook URL. The other webhook templates ("from specific people", "from people in an org") need a sign-in token, which this application does not send. See [Create an Incoming Webhook](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook) and the [Deployment Guide](DEPLOY.md#for-microsoft-teams), which also covers replacing an old connector URL.

#### For Google Chat (preview)
Google Chat support is a preview: it has not been tested against a real Google Chat space yet. Refer to [Google Chat incoming webhooks](https://developers.google.com/workspace/chat/quickstart/webhooks) and register a webhook in the space (Apps & integrations > Add webhooks), then copy its URL. Your Google Workspace organization must allow incoming webhooks. The URL contains a secret token, so do not share it; it is stored in SSM Parameter Store as a SecureString like the other webhook URLs.

### Deploy

Open [CloudShell](https://console.aws.amazon.com/cloudshell/home) and run:

```bash
git clone https://github.com/aws-samples/whats-new-summary-notifier.git
cd whats-new-summary-notifier
bash deploy.sh
```

The interactive wizard will guide you through selecting the notification destination (Slack/Teams/Google Chat (preview)), summary language, and entering your Webhook URL. Deployment runs via AWS CodeBuild automatically.

For advanced configuration options including multi-tenant deployment, please refer to the [Deployment Guide](DEPLOY.md).

## Management Console

A local web application for managing deployments, updating configurations, monitoring builds, and inspecting data. See the [Management Console Guide](CONSOLE.md) for details.

```bash
npm run dev:console
```

## Delete Stack

Using deploy.sh (recommended):
```bash
bash deploy.sh --destroy
```

Or manually:
```bash
cdk destroy
```
By default, some resources such as the Amazon DynamoDB table are set to not be deleted.
If you need to completely delete everything, you will need to access the remaining resources and manually delete them.

## Third Party Services
This code interacts with Slack, Microsoft Teams or Google Chat which has terms published at [Terms Page (Slack)](https://slack.com/main-services-agreement) / [Terms Page (Microsoft 365)](https://www.microsoft.com/en/servicesagreement) / [Terms Page (Google Workspace)](https://workspace.google.com/terms/premier_terms/), and pricing described at [Pricing Page (Slack)](https://slack.com/pricing) / [Pricing Page (Microsoft 365)](https://www.microsoft.com/en-us/microsoft-365/business/compare-all-microsoft-365-business-products?&activetab=tab:primaryr2) / [Pricing Page (Google Workspace)](https://workspace.google.com/pricing). You should be familiar with the pricing and confirm that your use case complies with the terms before proceeding.
