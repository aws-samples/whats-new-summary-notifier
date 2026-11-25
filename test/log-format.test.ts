import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { WhatsNewSummaryNotifierStack } from '../lib/whats-new-summary-notifier-stack';
import { lambdaLogFormatFromTemplate } from '../console/server/log-format';

function synth(lambdaLogFormat?: unknown): Template {
  const app = new cdk.App({
    context: {
      'aws:cdk:bundling-stacks': [],
      modelRegion: 'us-east-1',
      modelIds: ['global.anthropic.claude-sonnet-4-6'],
      summarizers: { S: { outputLanguage: 'Japanese.', persona: 'solutions architect in AWS' } },
      notifiers: {
        N: { destination: 'slack', summarizerName: 'S', webhookUrlParameterName: '/WhatsNew/URL', rssUrl: { f: 'https://example.com/feed' } },
      },
      ...(lambdaLogFormat === undefined ? {} : { lambdaLogFormat }),
    },
  });
  return Template.fromStack(new WhatsNewSummaryNotifierStack(app, 'TestStack'));
}

function logFormats(template: Template): unknown[] {
  return Object.values(template.findResources('AWS::Lambda::Function')).map(
    (f) => (f as { Properties: { LoggingConfig?: { LogFormat?: unknown } } }).Properties.LoggingConfig?.LogFormat
  );
}

describe('lambdaLogFormat', () => {
  test('without the setting the functions keep the default text format', () => {
    expect(logFormats(synth())).toEqual([undefined, undefined]);
  });

  test('JSON sets the JSON format on both functions and keeps the default log levels', () => {
    const template = synth('JSON');
    expect(logFormats(template)).toEqual(['JSON', 'JSON']);
    for (const f of Object.values(template.findResources('AWS::Lambda::Function'))) {
      const config = (f as { Properties: { LoggingConfig: Record<string, unknown> } }).Properties.LoggingConfig;
      expect(config.ApplicationLogLevel).toBeUndefined();
      expect(config.SystemLogLevel).toBeUndefined();
    }
  });

  test('TEXT sets the text format explicitly', () => {
    expect(logFormats(synth('TEXT'))).toEqual(['Text', 'Text']);
  });

  test.each(['json', 'Text', 1, { format: 'JSON' }])('rejects %p', (value) => {
    expect(() => synth(value)).toThrow('lambdaLogFormat must be "TEXT" or "JSON"');
  });

  test('the Console reads the setting back from the deployed template', () => {
    expect(lambdaLogFormatFromTemplate(JSON.stringify(synth('JSON').toJSON()))).toBe('JSON');
    expect(lambdaLogFormatFromTemplate(JSON.stringify(synth('TEXT').toJSON()))).toBeUndefined();
    expect(lambdaLogFormatFromTemplate(JSON.stringify(synth().toJSON()))).toBeUndefined();
    expect(lambdaLogFormatFromTemplate('not json')).toBeUndefined();
    expect(lambdaLogFormatFromTemplate(undefined)).toBeUndefined();
  });
});
