import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { WhatsNewSummaryNotifierStack } from '../lib/whats-new-summary-notifier-stack';

function createStack(contextOverrides: Record<string, unknown> = {}): Template {
  const app = new cdk.App({
    context: {
      // Skip Docker bundling in tests
      'aws:cdk:bundling-stacks': [],
      modelRegion: 'us-east-1',
      modelIds: [
        'global.anthropic.claude-sonnet-4-6',
        'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
      ],
      summarizers: {
        AwsSolutionsArchitectJapanese: {
          outputLanguage: 'Japanese.',
          persona: 'solutions architect in AWS',
        },
      },
      notifiers: {
        AwsWhatsNew: {
          destination: 'slack',
          summarizerName: 'AwsSolutionsArchitectJapanese',
          webhookUrlParameterName: '/WhatsNew/URL',
          rssUrl: { "What's new": 'https://aws.amazon.com/about-aws/whats-new/recent/feed/' },
        },
      },
      ...contextOverrides,
    },
  });
  const stack = new WhatsNewSummaryNotifierStack(app, 'TestStack');
  return Template.fromStack(stack);
}

describe('WhatsNewSummaryNotifierStack', () => {
  test('creates DynamoDB table with correct key schema', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'url', KeyType: 'HASH' },
        { AttributeName: 'notifier_name', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
    });
  });

  test('creates notify Lambda with correct environment variables', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.handler',
      Runtime: 'python3.12',
      Timeout: 180,
      Environment: {
        Variables: Match.objectLike({
          MODEL_REGION: 'us-east-1',
          MODEL_IDS: Match.anyValue(),
          DDB_TABLE_NAME: Match.anyValue(),
          NOTIFIERS: Match.anyValue(),
          SUMMARIZERS: Match.anyValue(),
        }),
      },
    });
  });

  test('MODEL_IDS env var contains model array as JSON', () => {
    const template = createStack();
    const lambdas = template.findResources('AWS::Lambda::Function', {
      Properties: {
        Environment: {
          Variables: {
            MODEL_IDS: Match.anyValue(),
          },
        },
      },
    });
    const ids = Object.values(lambdas);
    const notifyLambda = ids.find(
      (r) => (r as { Properties?: { Environment?: { Variables?: { MODEL_IDS?: string } } } }).Properties?.Environment?.Variables?.MODEL_IDS
    ) as { Properties: { Environment: { Variables: { MODEL_IDS: string } } } };
    expect(notifyLambda).toBeDefined();
    const modelIds = JSON.parse(notifyLambda.Properties.Environment.Variables.MODEL_IDS);
    expect(modelIds).toEqual([
      'global.anthropic.claude-sonnet-4-6',
      'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
    ]);
  });

  test('DDB_TABLE_NAME is passed to notify Lambda', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          DDB_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('creates RSS crawler Lambda with DDB_TABLE_NAME', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 60,
      Environment: {
        Variables: Match.objectLike({
          DDB_TABLE_NAME: Match.anyValue(),
          NOTIFIERS: Match.anyValue(),
        }),
      },
    });
  });

  test('creates EventBridge rule for each notifier', () => {
    const template = createStack();
    template.resourceCountIs('AWS::Events::Rule', 1);
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: Match.anyValue(),
      State: 'ENABLED',
    });
  });

  test('notify Lambda has Bedrock invoke permission', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'bedrock:InvokeModel',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('notify Lambda has DynamoDB write permission', () => {
    const template = createStack();
    // grantWriteData creates a policy with dynamodb:* actions on the table
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'dynamodb:BatchWriteItem',
              'dynamodb:PutItem',
              'dynamodb:UpdateItem',
              'dynamodb:DeleteItem',
            ]),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('creates DynamoDB event source mapping', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      StartingPosition: 'LATEST',
    });
  });

  test('multiple notifiers create multiple EventBridge rules', () => {
    const template = createStack({
      notifiers: {
        Notifier1: {
          destination: 'slack',
          summarizerName: 'AwsSolutionsArchitectJapanese',
          webhookUrlParameterName: '/WhatsNew/URL/1',
          rssUrl: { feed1: 'https://example.com/feed1' },
        },
        Notifier2: {
          destination: 'teams',
          summarizerName: 'AwsSolutionsArchitectJapanese',
          webhookUrlParameterName: '/WhatsNew/URL/2',
          rssUrl: { feed2: 'https://example.com/feed2' },
        },
      },
    });
    template.resourceCountIs('AWS::Events::Rule', 2);
  });
});
