import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { spawnSync } from 'child_process';
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
  const run = (...args: string[]) =>
    spawnSync('bash', [path.join(__dirname, '..', 'deploy.sh'), '--non-interactive', ...args], {
      encoding: 'utf-8',
      // No AWS credentials: a check that passes would fail later at `aws sts`, never create anything
      env: { PATH: process.env.PATH ?? '', AWS_CONFIG_FILE: '/nonexistent', AWS_SHARED_CREDENTIALS_FILE: '/nonexistent' },
    });

  test.each([
    [['--alarm-email', 'ops@example.com', '--alarm-topic-arn', 'arn:aws:sns:us-east-1:123456789012:t'], /not both/],
    [['--alarm-email', 'not-an-address'], /Not an email address/],
    [['--alarm-email', "o'p@example.com"], /Not an email address/],
    [['--alarm-topic-arn', 'arn:aws:sqs:us-east-1:123456789012:q'], /Not the ARN of an SNS standard topic/],
    [['--alarm-topic-arn', 'arn:aws:sns:us-east-1:123456789012:t.fifo'], /Not the ARN of an SNS standard topic/],
  ])('stops before any AWS call for %j', (args, message) => {
    const r = run(...args);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(message);
  });
});
