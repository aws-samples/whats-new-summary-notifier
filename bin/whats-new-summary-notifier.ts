#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import { WhatsNewSummaryNotifierStack } from '../lib/whats-new-summary-notifier-stack';

const app = new cdk.App();

// Load external config file if specified: -c config=tenants/test.json
// File values override cdk.json defaults (but explicit -c key=value still wins via CDK precedence).
const configPath = app.node.tryGetContext('config');
if (configPath && fs.existsSync(configPath)) {
  const fileCtx = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  for (const [key, value] of Object.entries(fileCtx)) {
    if (key !== 'config') {
      app.node.setContext(key, value);
    }
  }
}

const tenant = app.node.tryGetContext('tenant') || '';
const stackName = tenant ? `WhatsNewSummaryNotifier-${tenant}` : 'WhatsNewSummaryNotifierStack';

new WhatsNewSummaryNotifierStack(app, stackName, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
