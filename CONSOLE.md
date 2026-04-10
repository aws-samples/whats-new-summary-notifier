# Management Console

**[日本語はこちら](CONSOLE_ja.md)**

The Management Console is a local web application for managing Whats New Summary Notifier deployments. It provides a GUI for deploying new tenants, updating configurations, monitoring build jobs, and inspecting DynamoDB data — all from your browser.

## Prerequisites

- Node.js 22+
- AWS CLI configured with one or more named profiles
- The profile must have permissions for CloudFormation, Lambda, DynamoDB, SSM, CodeBuild, IAM, S3, and Bedrock

## Getting Started

```bash
npm run dev:console
```

Open [http://localhost:5173](http://localhost:5173) in your browser. The Express API server runs on port 3456 and the Vite dev server proxies API requests to it.

## Features

### 1. Profile Selection & Stack Discovery

Select an AWS CLI profile from the dropdown. The console will:
- Display the AWS account ID
- Load cached stack data (if available)
- Click **🔍 Scan Regions** to search all AWS regions for deployed `WhatsNewSummaryNotifier*` stacks

### 2. Stack Overview

Each discovered stack shows:
- Region, tenant name, stack name, status, last updated time
- Action buttons: **▼ Details**, **📊 DDB**, **📤 Export**, **🔄 Update**, **▶️ Test**, **🗑️ Destroy**

### 3. Deploy New Tenant

Click **+ Deploy New Tenant** in the header to open the deploy modal.

**Basic fields:**
- **Tenant Name** — leave empty for default stack
- **Deploy Region** — select from dropdown or use profile default

**Webhook URL registration:**
- Enter a Webhook URL and optionally specify a custom SSM Parameter name
- Or check **Use existing SSM parameter** to select from a dropdown of existing `/WhatsNew/*` parameters in the target region

**Configuration editor (GUI / JSON tabs):**

The **🛠️ GUI Editor** tab provides structured forms for:

| Section | Fields |
|---|---|
| 🤖 Model Configuration | Model Region (dropdown), Model IDs (with Bedrock + CRIS model suggestions) |
| 📝 Summarizers | Name, output language, persona (define before Notifiers) |
| 🔔 Notifiers | Name, destination (Slack/Teams), summarizer (dropdown from defined summarizers), SSM param name (dropdown of existing + manual input), RSS URLs |

The **📝 JSON** tab allows direct editing of the configuration JSON. Changes sync bidirectionally between tabs.

You can also:
- **📁 Load file** — browse for a tenant JSON file
- **Drag & drop** a JSON file onto the editor

### 4. Update Existing Tenant

Click **🔄 Update** on a stack row. The modal pre-fills with the current configuration reconstructed from Lambda environment variables. Edit any field and deploy.

### 5. Destroy Tenant

Click **🗑️ Destroy** on a stack row. A confirmation dialog requires you to type the tenant name exactly. After the destroy build succeeds, the CodeBuild project, IAM role, and SSM parameter are automatically cleaned up.

### 6. Build Console

When a deploy/update/destroy is triggered, a build console panel appears at the bottom of the screen:
- Real-time log streaming from CloudWatch Logs (3-second polling)
- Status badge: 🔵 IN_PROGRESS / 🟢 SUCCEEDED / 🔴 FAILED
- **Minimizable** — click the header bar or ▼/▲ button
- **Persistent** — build state is saved to localStorage and survives page refresh
- On success: stack list auto-refreshes; on destroy success: resources are cleaned up

### 7. Test (Invoke Crawler)

Click **▶️ Test** on a stack row to manually trigger the RSS crawler Lambda. A browser confirmation dialog appears first. The crawler is invoked once per notifier with the same payload as EventBridge, triggering the full pipeline: RSS fetch → DynamoDB write → Bedrock summarization → Webhook notification.

### 8. DynamoDB Preview

Click **📊 DDB** on a stack row to browse the RSS history table. Each item shows:
- Title (linked), publish time, category, notifier name
- Summary status badge (completed / pending)
- Model ID, latency, input/output token counts
- Summary text (green highlight)
- Detail text (collapsible)

### 9. Stack Details

Click **▼ Details** to expand:
- Model configuration (region, model IDs)
- Summarizers and Notifiers configuration (JSON)
- SSM parameters (click **Load** to decrypt and view)
- Raw CloudFormation parameters and outputs

### 10. Export Tenant Config

Click **📤 Export** to save the stack's configuration as a JSON file to `tenants/exported/`. The exported file can be used with `deploy.sh --config` or loaded back into the Management Console.

## How It Works

The Management Console runs entirely on your local machine:

1. **Express API server** (port 3456) uses your AWS CLI credentials via `fromIni()` to call AWS APIs
2. **React frontend** (port 5173) proxies API requests to the Express server
3. **Deploy flow**: Local source code is zipped (excluding `.git`, `node_modules`, etc.) → uploaded to S3 → CodeBuild project created/updated → build started with CDK context as environment variables
4. **No data leaves your machine** except AWS API calls to your own account

## Configuration Priority

When deploying via the Management Console:

1. GUI/JSON editor values are written to a temp config file
2. Passed to CDK via `-c config=/tmp/cdk-context-config.json`
3. Config file values **override** `cdk.json` defaults
