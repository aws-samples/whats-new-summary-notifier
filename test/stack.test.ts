import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { WhatsNewSummaryNotifierStack, parseAlarmSettings } from '../lib/whats-new-summary-notifier-stack';

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
      Runtime: 'python3.15',
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

  test('event source passes INSERT only and bounds retries with a failure queue', () => {
    const template = createStack();
    template.resourceCountIs('AWS::SQS::Queue', 1);
    const queueId = Object.keys(template.findResources('AWS::SQS::Queue'))[0];
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FilterCriteria: { Filters: [{ Pattern: JSON.stringify({ eventName: ['INSERT'] }) }] },
      MaximumRetryAttempts: 2,
      MaximumRecordAgeInSeconds: 6 * 60 * 60,
      DestinationConfig: { OnFailure: { Destination: { 'Fn::GetAtt': [queueId, 'Arn'] } } },
    });
  });

  test('failure queue is encrypted, requires TLS and only the notify role can send to it', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::SQS::Queue', {
      SqsManagedSseEnabled: true,
      MessageRetentionPeriod: 14 * 24 * 60 * 60,
    });
    template.hasResourceProperties('AWS::SQS::QueuePolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
        ]),
      },
    });
    const queueId = Object.keys(template.findResources('AWS::SQS::Queue'))[0];
    const sendStatements = Object.entries(template.findResources('AWS::IAM::Policy')).flatMap(([id, p]) =>
      (p as { Properties: { PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] } } })
        .Properties.PolicyDocument.Statement.filter((s) => [s.Action].flat().includes('sqs:SendMessage')).map(
          (s) => ({ id, resource: s.Resource })
        )
    );
    expect(sendStatements).toHaveLength(1);
    expect(sendStatements[0].id).toMatch(/^NotifyNewEntryRole/);
    expect(sendStatements[0].resource).toEqual({ 'Fn::GetAtt': [queueId, 'Arn'] });
  });

  test('alarms on IteratorAge and the failure queue, without actions', () => {
    const template = createStack();
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'IteratorAge',
      Namespace: 'AWS/Lambda',
      Statistic: 'Maximum',
      Threshold: 30 * 60 * 1000,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Namespace: 'AWS/SQS',
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    });
    for (const alarm of Object.values(template.findResources('AWS::CloudWatch::Alarm'))) {
      const props = (alarm as { Properties: Record<string, unknown> }).Properties;
      expect(props.AlarmActions).toBeUndefined();
      expect(props.OKActions).toBeUndefined();
      expect(props.InsufficientDataActions).toBeUndefined();
    }
    template.resourceCountIs('AWS::SNS::Topic', 0);
    template.resourceCountIs('AWS::SNS::Subscription', 0);
  });

  describe('alarm notifications', () => {
    const topicArn = 'arn:aws:sns:us-east-1:123456789012:wnsn-alarms';
    const alarmProps = (template: Template) =>
      Object.values(template.findResources('AWS::CloudWatch::Alarm')).map(
        (a) => (a as { Properties: Record<string, unknown> }).Properties
      );

    test('alarms.topicArn adds ALARM and OK actions to every alarm and creates no topic', () => {
      const template = createStack({ alarms: { topicArn } });
      template.resourceCountIs('AWS::SNS::Topic', 0);
      const props = alarmProps(template);
      expect(props.length).toBeGreaterThan(0);
      for (const p of props) {
        expect(p.AlarmActions).toEqual([topicArn]);
        expect(p.OKActions).toEqual([topicArn]);
      }
    });

    test('alarms.email creates a TLS-only topic that only this account\'s alarms can publish to', () => {
      const template = createStack({ alarms: { email: 'ops@example.com' } });
      template.resourceCountIs('AWS::SNS::Topic', 1);
      const topicId = Object.keys(template.findResources('AWS::SNS::Topic'))[0];
      expect(template.findResources('AWS::SNS::Topic')[topicId].Properties?.KmsMasterKeyId).toBeUndefined();
      template.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'email',
        Endpoint: 'ops@example.com',
        TopicArn: { Ref: topicId },
      });
      template.hasResourceProperties('AWS::SNS::TopicPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Action: 'sns:Publish',
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            }),
            Match.objectLike({
              Effect: 'Allow',
              Principal: { Service: 'cloudwatch.amazonaws.com' },
              Action: 'sns:Publish',
              Condition: {
                StringEquals: { 'aws:SourceAccount': Match.anyValue() },
                ArnLike: { 'aws:SourceArn': Match.anyValue() },
              },
            }),
          ]),
        },
      });
      for (const p of alarmProps(template)) {
        expect(p.AlarmActions).toEqual([{ Ref: topicId }]);
        expect(p.OKActions).toEqual([{ Ref: topicId }]);
      }
    });

    test('a JSON string from -c alarms=... is accepted', () => {
      const template = createStack({ alarms: JSON.stringify({ topicArn }) });
      for (const p of alarmProps(template)) expect(p.AlarmActions).toEqual([topicArn]);
    });

    test.each([
      [{ topicArn, email: 'ops@example.com' }, /cannot both be set/],
      [{ topicArn: 'arn:aws:sqs:us-east-1:123456789012:q' }, /ARN of an SNS standard topic/],
      [{ topicArn: `${topicArn}.fifo` }, /ARN of an SNS standard topic/],
      [{ email: 'not-an-address' }, /must be an email address/],
      [{ emails: 'ops@example.com' }, /alarms.emails is not a known setting/],
      [['ops@example.com'], /must be an object/],
      ['{not json', /must be a JSON object/],
    ])('rejects alarms=%j', (alarms, message) => {
      expect(() => createStack({ alarms })).toThrow(message);
    });

    test('rejects a topic in another Region when the stack Region is known', () => {
      expect(() => parseAlarmSettings({ topicArn: 'arn:aws:sns:eu-west-1:123456789012:t' }, 'us-east-1')).toThrow(
        /use a topic in the stack's Region \(us-east-1\)/
      );
      expect(parseAlarmSettings({ topicArn }, 'us-east-1')).toEqual({ topicArn });
      expect(parseAlarmSettings(undefined, 'us-east-1')).toBeUndefined();
    });
  });

  test('each function writes to its own stack-owned log group kept for 14 days', () => {
    const template = createStack();
    // No LogRetention custom resource and no provider function for it
    template.resourceCountIs('Custom::LogRetention', 0);
    template.resourceCountIs('AWS::Lambda::Function', 2);
    const logGroups = template.findResources('AWS::Logs::LogGroup');
    expect(Object.keys(logGroups)).toHaveLength(2);
    for (const lg of Object.values(logGroups) as {
      Properties: Record<string, unknown>;
      DeletionPolicy?: string;
      UpdateReplacePolicy?: string;
    }[]) {
      expect(lg.Properties.RetentionInDays).toBe(14);
      // CloudFormation names it, so it never collides with /aws/lambda/<function name>
      expect(lg.Properties.LogGroupName).toBeUndefined();
      expect(lg.DeletionPolicy).toBe('RetainExceptOnCreate');
      expect(lg.UpdateReplacePolicy).toBe('Retain');
    }
    const targets = Object.values(template.findResources('AWS::Lambda::Function')).map(
      (f) => (f as { Properties: { LoggingConfig?: { LogGroup?: { Ref?: string } } } }).Properties.LoggingConfig?.LogGroup?.Ref
    );
    expect(targets.sort()).toEqual(Object.keys(logGroups).sort());
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

  test('googlechat notifier gets read access to its webhook URL parameter', () => {
    const template = createStack({
      notifiers: {
        GoogleChat: {
          destination: 'googlechat',
          summarizerName: 'AwsSolutionsArchitectJapanese',
          webhookUrlParameterName: '/WhatsNew/URL/googlechat',
          rssUrl: { feed: 'https://example.com/feed' },
        },
      },
    });
    template.resourceCountIs('AWS::Events::Rule', 1);
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('parameter/WhatsNew/URL/googlechat');
  });

  describe('notifier filter', () => {
    const notifierWith = (filter: unknown) => ({
      notifiers: {
        AwsWhatsNew: {
          destination: 'slack',
          summarizerName: 'AwsSolutionsArchitectJapanese',
          webhookUrlParameterName: '/WhatsNew/URL',
          rssUrl: { feed: 'https://example.com/feed' },
          filter,
        },
      },
    });

    test('a valid filter is passed to both Lambda functions', () => {
      const filter = { categories: ['general:products/amazon-bedrock'], topics: ['generative AI'] };
      const template = createStack(notifierWith(filter));
      const functions = Object.values(template.findResources('AWS::Lambda::Function')) as {
        Properties: { Environment?: { Variables?: Record<string, unknown> } };
      }[];
      const notifierEnvs = functions
        .map((f) => f.Properties.Environment?.Variables?.NOTIFIERS)
        .filter((v): v is string => typeof v === 'string');
      expect(notifierEnvs).toHaveLength(2);
      for (const env of notifierEnvs) {
        expect(JSON.parse(env).AwsWhatsNew.filter).toEqual(filter);
      }
    });

    test('rejects a filter that is not an object', () => {
      expect(() => createStack(notifierWith(['general:products']))).toThrow('notifiers.AwsWhatsNew.filter must be an object');
    });

    test('rejects categories that are not a list of strings', () => {
      expect(() => createStack(notifierWith({ categories: 'general:products' }))).toThrow(
        'notifiers.AwsWhatsNew.filter.categories must be an array of strings'
      );
    });

    test('rejects settings too large for the Lambda environment', () => {
      expect(() => createStack(notifierWith({ topics: ['x'.repeat(4000)] }))).toThrow(/Lambda environment variables/);
    });

    test('rejects settings too large for the EventBridge target input', () => {
      expect(() => createStack(notifierWith({ topics: ['x'.repeat(9000)] }))).toThrow(/EventBridge target input/);
    });
  });
});
