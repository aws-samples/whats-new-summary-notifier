# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an AWS CDK application that implements a Whats New Summary Notifier - a generative AI application that monitors RSS feeds (primarily AWS What's New and other tech blogs), summarizes content using Amazon Bedrock, and delivers notifications to Slack.

## Quick Start

```bash
npm install
npm run build
cdk bootstrap   # run once per account/region
cdk deploy
```

**Prerequisites:** Docker (required for Lambda build via `aws-lambda-python-alpha`). See [README.md](README.md) for full prerequisites.

## Architecture

The application consists of:
- **RSS Crawler Lambda**: Fetches RSS feeds and stores new entries in DynamoDB
- **Notification Lambda**: Triggered by DynamoDB streams, summarizes content using Bedrock, and posts to Slack
- **DynamoDB Table**: Stores RSS history to avoid duplicate processing
- **EventBridge Rules**: Schedules RSS crawling based on configured cron expressions
- **SSM Parameter Store**: Securely stores Slack webhook URLs

## Key Files

- `bin/whats-new-summary-notifier.ts` - CDK app entry point
- `lib/whats-new-summary-notifier-stack.ts` - Stack definition (DynamoDB, Lambdas, EventBridge, SSM)

## Build and Development Commands

### CDK Operations
- `cdk bootstrap` - Initialize CDK in the AWS account/region (run once)
- `cdk synth` - Synthesize CloudFormation templates and verify configuration
- `cdk deploy` - Deploy the stack to AWS
- `cdk destroy` - Delete the stack from AWS

### Code Quality
- `npm run build` - Compile TypeScript to JavaScript
- `npm run watch` - Watch for TypeScript changes and compile automatically
- `npm test` - Run Jest tests
- `ruff check` - Lint Python code in Lambda functions
- `ruff format` - Format Python code in Lambda functions
- `npx eslint .` - Run ESLint on TypeScript code (uses eslint.config.mjs)
- `npm run audit` - Run npm security audit on dependencies
- `npm run deps:update` - Update dependencies, then build and test

## Configuration

The application is configured via the `context` section in `cdk.json`:

- **modelRegion**: AWS region for Bedrock (currently us-west-2)
- **modelId**: Bedrock model ID (currently amazon.nova-pro-v1:0)
- **summarizers**: Define different AI personas and output languages
- **notifiers**: Configure RSS sources, schedules, and Slack webhook parameters

### Key Configuration Points
- Each notifier can have its own RSS feeds, schedule, and summarizer
- Webhook URLs are stored in SSM Parameter Store for security
- Default schedule runs every hour, but can be customized per notifier
- Supports multiple languages (English/Japanese) and personas (AWS Solutions Architect, F1 Journalist)

## Lambda Functions

### RSS Crawler (`lambda/rss-crawler/index.py`)
- Fetches RSS feeds using feedparser
- Filters entries to only those published within the last 7 days (hardcoded)
- Stores new entries in DynamoDB with deduplication
- DynamoDB key: `url` (partition) + `notifier_name` (sort) — natural dedup without explicit checks

### Notification Handler (`lambda/notify-to-app/index.py`)

- Triggered by DynamoDB streams on new RSS entries (batchSize=1, StreamViewType=NEW_IMAGE)
- Scrapes full article content using cloudscraper and BeautifulSoup (targets `<main>` tag)
- Summarizes content using Strands Agents SDK (`strands-agents` library) with Bedrock — temperature=0.1
- Posts formatted messages to Slack with Twitter sharing links
- F1 notifier has a strict Japanese glossary for driver/team names — edit carefully

## Gotchas

- Prerequisites, deployment steps, and common pitfalls: see [README.md](README.md).
- **Docker** must be running before `cdk deploy` (Lambda build).
- **Bedrock** model access must be enabled in the region set in `modelRegion` (cdk.json).
- **F1 Glossary**: The Formula 1 notifier enforces a strict glossary for Japanese translations of driver names, team names, and technical terms (defined in `lambda/notify-to-app/index.py`). Always preserve these mappings when editing prompts.
- **cdk-nag**: `bin/cdk_test.ts` runs AwsSolutionsChecks on synth. CDK nag suppressions are required for any intentional deviations from AWS security best practices.

## Development Notes

- Python Lambda functions use Python 3.12 runtime
- CDK stack uses TypeScript with AWS CDK v2
- Tool versions are managed via `mise` (see `mise.toml`) — install with `mise install`
- Web scraping handles Cloudflare protection using cloudscraper
- Bedrock summarization includes structured output with thinking/summary/twitter sections
- Lambda concurrency is limited to 1 for the notification function to prevent rate limiting