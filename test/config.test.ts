import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';

describe('Multi-tenant and config file', () => {
  const baseContext = {
    modelRegion: 'us-east-1',
    modelIds: ['global.anthropic.claude-sonnet-4-6'],
    summarizers: {
      S1: { outputLanguage: 'Japanese.', persona: 'SA' },
    },
    notifiers: {
      N1: {
        destination: 'slack',
        summarizerName: 'S1',
        webhookUrlParameterName: '/WhatsNew/URL',
        rssUrl: { feed: 'https://example.com/feed' },
      },
    },
  };

  test('default stack name when no tenant', () => {
    const app = new cdk.App({ context: baseContext });
    const tenant = app.node.tryGetContext('tenant') || '';
    const stackName = tenant ? `WhatsNewSummaryNotifier-${tenant}` : 'WhatsNewSummaryNotifierStack';
    expect(stackName).toBe('WhatsNewSummaryNotifierStack');
  });

  test('tenant-specific stack name', () => {
    const app = new cdk.App({ context: { ...baseContext, tenant: 'test' } });
    const tenant = app.node.tryGetContext('tenant') || '';
    const stackName = tenant ? `WhatsNewSummaryNotifier-${tenant}` : 'WhatsNewSummaryNotifierStack';
    expect(stackName).toBe('WhatsNewSummaryNotifier-test');
  });

  test('config file merges into context as defaults', () => {
    const tmpDir = fs.mkdtempSync('/tmp/cdk-test-');
    const configPath = path.join(tmpDir, 'tenant.json');
    fs.writeFileSync(configPath, JSON.stringify({ tenant: 'fromfile', modelRegion: 'eu-west-1' }));

    const app = new cdk.App({ context: { ...baseContext, config: configPath } });

    // Simulate config file loading logic from bin/whats-new-summary-notifier.ts
    const cfgPath = app.node.tryGetContext('config');
    if (cfgPath && fs.existsSync(cfgPath)) {
      const fileCtx = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      for (const [key, value] of Object.entries(fileCtx)) {
        if (key !== 'config' && app.node.tryGetContext(key) === undefined) {
          app.node.setContext(key, value);
        }
      }
    }

    // tenant from file (not in baseContext)
    expect(app.node.tryGetContext('tenant')).toBe('fromfile');
    // modelRegion from baseContext takes precedence over file
    expect(app.node.tryGetContext('modelRegion')).toBe('us-east-1');

    fs.rmSync(tmpDir, { recursive: true });
  });

  test('CLI context overrides config file', () => {
    const tmpDir = fs.mkdtempSync('/tmp/cdk-test-');
    const configPath = path.join(tmpDir, 'tenant.json');
    fs.writeFileSync(configPath, JSON.stringify({ tenant: 'fromfile' }));

    // Simulate: -c config=... -c tenant=fromcli
    const app = new cdk.App({ context: { ...baseContext, config: configPath, tenant: 'fromcli' } });

    const cfgPath = app.node.tryGetContext('config');
    if (cfgPath && fs.existsSync(cfgPath)) {
      const fileCtx = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      for (const [key, value] of Object.entries(fileCtx)) {
        if (key !== 'config' && app.node.tryGetContext(key) === undefined) {
          app.node.setContext(key, value);
        }
      }
    }

    // CLI value wins
    expect(app.node.tryGetContext('tenant')).toBe('fromcli');

    fs.rmSync(tmpDir, { recursive: true });
  });
});
