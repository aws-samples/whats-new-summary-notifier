import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WhatsNewSummaryNotifierStack } from '../lib/whats-new-summary-notifier-stack';
import { alarmsFromTemplate } from '../console/server/alarms';

function templateBody(alarms?: unknown): string {
  const app = new cdk.App({
    context: {
      'aws:cdk:bundling-stacks': [],
      modelRegion: 'us-east-1',
      modelIds: ['global.anthropic.claude-sonnet-4-6'],
      summarizers: { S: { outputLanguage: 'Japanese.', persona: 'solutions architect in AWS' } },
      notifiers: {
        N: { destination: 'slack', summarizerName: 'S', webhookUrlParameterName: '/WhatsNew/URL', rssUrl: { f: 'https://example.com/feed' } },
      },
      ...(alarms === undefined ? {} : { alarms }),
    },
  });
  return JSON.stringify(Template.fromStack(new WhatsNewSummaryNotifierStack(app, 'TestStack')).toJSON());
}

describe('Console reads the alarms setting back from the deployed template', () => {
  test('email', () => {
    expect(alarmsFromTemplate(templateBody({ email: 'ops@example.com' }))).toEqual({ email: 'ops@example.com' });
  });

  test('topicArn', () => {
    const topicArn = 'arn:aws:sns:us-east-1:123456789012:wnsn-alarms';
    expect(alarmsFromTemplate(templateBody({ topicArn }))).toEqual({ topicArn });
  });

  test('none, or a template that cannot be read', () => {
    expect(alarmsFromTemplate(templateBody())).toEqual({});
    expect(alarmsFromTemplate('not json')).toEqual({});
    expect(alarmsFromTemplate(undefined)).toEqual({});
  });
});

describe('deploy.sh alarm options', () => {
  // A stub `aws` that exits 99: an input that passes the checks stops at `aws sts`, never creates anything
  const stubBin = fs.mkdtempSync(path.join(os.tmpdir(), 'wnsn-aws-stub-'));
  fs.writeFileSync(path.join(stubBin, 'aws'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  afterAll(() => fs.rmSync(stubBin, { recursive: true, force: true }));

  const run = (...args: string[]) =>
    spawnSync('bash', [path.join(__dirname, '..', 'deploy.sh'), '--non-interactive', ...args], {
      encoding: 'utf-8',
      env: {
        PATH: `${stubBin}:${process.env.PATH ?? ''}`,
        AWS_CONFIG_FILE: '/nonexistent',
        AWS_SHARED_CREDENTIALS_FILE: '/nonexistent',
      },
    });
  const topicArn = (name: string) => `arn:aws:sns:us-east-1:123456789012:${name}`;

  test.each([
    [['--alarm-email', 'ops@example.com', '--alarm-topic-arn', 'arn:aws:sns:us-east-1:123456789012:t'], /not both/],
    [['--alarm-email', 'not-an-address'], /Not an email address/],
    [['--alarm-email', "o'p@example.com"], /Not an email address/],
    [['--alarm-topic-arn', 'arn:aws:sqs:us-east-1:123456789012:q'], /Not the ARN of an SNS standard topic/],
    [['--alarm-topic-arn', 'arn:aws:sns:us-east-1:123456789012:t.fifo'], /Not the ARN of an SNS standard topic/],
    [['--alarm-topic-arn', topicArn('t'.repeat(257))], /Not the ARN of an SNS standard topic/],
  ])('stops before any AWS call for %j', (args, message) => {
    const r = run(...args);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(message);
  });

  // The name length is checked outside the regex: macOS regex rejects repetition counts over 255
  test.each([topicArn('ops-alarms_1'), topicArn('t'.repeat(256))])('accepts the topic ARN %s', (arn) => {
    const r = run('--alarm-topic-arn', arn);
    expect(r.stdout).not.toMatch(/Not the ARN/);
    expect(r.status).toBe(99);
  });
});
