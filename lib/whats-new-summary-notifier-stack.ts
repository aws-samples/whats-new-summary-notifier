import { Construct } from 'constructs';
import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Table, AttributeType, BillingMode, StreamViewType } from 'aws-cdk-lib/aws-dynamodb';
import { Rule, Schedule, RuleTargetInput, CronOptions } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Role, Policy, ServicePrincipal, PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Runtime, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { PythonFunction } from '@aws-cdk/aws-lambda-python-alpha';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import * as path from 'path';

// Lambda allows 4 KB for all environment variables of a function, and an EventBridge
// target input is at most 8,192 characters.
const LAMBDA_ENV_LIMIT_BYTES = 4096;
const EVENT_INPUT_LIMIT_CHARS = 8192;
// The table name is a token at synth time; count the longest name DynamoDB allows.
const TABLE_NAME_MAX_BYTES = 255;

/**
 * Check the optional `filter` of each notifier. Notifiers without a filter are not checked,
 * so configurations that synthesized before keep synthesizing unchanged.
 */
export function validateNotifierFilters(notifiers: Record<string, Record<string, unknown>>, environments: Record<string, string>[]): void {
  let anyFilter = false;
  for (const [name, notifier] of Object.entries(notifiers ?? {})) {
    const filter = notifier?.['filter'];
    if (filter === undefined) continue;
    anyFilter = true;
    if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
      throw new Error(`notifiers.${name}.filter must be an object`);
    }
    for (const key of ['categories', 'topics', 'modelIds']) {
      const value = (filter as Record<string, unknown>)[key];
      if (value !== undefined && !(Array.isArray(value) && value.every((v) => typeof v === 'string'))) {
        throw new Error(`notifiers.${name}.filter.${key} must be an array of strings`);
      }
    }
    const input = JSON.stringify({ notifierName: name, notifier });
    if (input.length > EVENT_INPUT_LIMIT_CHARS) {
      throw new Error(`notifiers.${name} is ${input.length} characters as an EventBridge target input (limit ${EVENT_INPUT_LIMIT_CHARS}); shorten filter.topics`);
    }
  }
  if (!anyFilter) return;
  for (const env of environments) {
    const size = Object.entries(env).reduce(
      (sum, [k, v]) => sum + Buffer.byteLength(k) + (k === 'DDB_TABLE_NAME' ? TABLE_NAME_MAX_BYTES : Buffer.byteLength(v)),
      0
    );
    if (size > LAMBDA_ENV_LIMIT_BYTES) {
      throw new Error(`Lambda environment variables would be about ${size} bytes (limit ${LAMBDA_ENV_LIMIT_BYTES}); shorten the notifiers' filter settings`);
    }
  }
}

export class WhatsNewSummaryNotifierStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const region = Stack.of(this).region;
    const accountId = Stack.of(this).account;

    const modelRegion = this.node.tryGetContext('modelRegion');
    const modelIds: string[] = this.node.tryGetContext('modelIds');
    const commitHash: string = this.node.tryGetContext('commitHash') ?? 'local';

    const notifiers = this.node.tryGetContext('notifiers');
    const summarizers: [] = this.node.tryGetContext('summarizers');

    // Role for Lambda Function to post new entries written to DynamoDB to Slack or Microsoft Teams
    const notifyNewEntryRole = new Role(this, 'NotifyNewEntryRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });
    notifyNewEntryRole.attachInlinePolicy(
      new Policy(this, 'AllowNotifyNewEntryLogging', {
        statements: [
          new PolicyStatement({
            actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
            effect: Effect.ALLOW,
            resources: [`arn:aws:logs:${region}:${accountId}:log-group:*`],
          }),
          new PolicyStatement({
            actions: ['bedrock:InvokeModel'],
            effect: Effect.ALLOW,
            resources: ['*'],
          }),
        ],
      })
    );

    // Role for Lambda function to fetch RSS and write to DynamoDB
    const newsCrawlerRole = new Role(this, 'NewsCrawlerRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });
    newsCrawlerRole.attachInlinePolicy(
      new Policy(this, 'AllowNewsCrawlerLogging', {
        statements: [
          new PolicyStatement({
            actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
            effect: Effect.ALLOW,
            resources: [`arn:aws:logs:${region}:${accountId}:log-group:*`],
          }),
        ],
      })
    );

    // DynamoDB to store RSS data
    const rssHistoryTable = new Table(this, 'WhatsNewRSSHistory', {
      partitionKey: { name: 'url', type: AttributeType.STRING },
      sortKey: { name: 'notifier_name', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      stream: StreamViewType.NEW_IMAGE,
    });

    const notifyEnvironment = {
      MODEL_IDS: JSON.stringify(modelIds),
      MODEL_REGION: modelRegion,
      DDB_TABLE_NAME: rssHistoryTable.tableName,
      NOTIFIERS: JSON.stringify(notifiers),
      SUMMARIZERS: JSON.stringify(summarizers),
    };
    const crawlerEnvironment = {
      DDB_TABLE_NAME: rssHistoryTable.tableName,
      NOTIFIERS: JSON.stringify(notifiers),
    };
    validateNotifierFilters(notifiers, [notifyEnvironment, crawlerEnvironment]);

    // Lambda Function to post new entries written to DynamoDB to Slack or Microsoft Teams
    const notifyNewEntry = new PythonFunction(this, 'NotifyNewEntry', {
      runtime: Runtime.PYTHON_3_14,
      entry: path.join(__dirname, '../lambda/notify-to-app'),
      handler: 'handler',
      index: 'index.py',
      timeout: Duration.seconds(180),
      logRetention: RetentionDays.TWO_WEEKS,
      role: notifyNewEntryRole,
      reservedConcurrentExecutions: 1,
      environment: notifyEnvironment,
    });

    notifyNewEntry.addEventSource(
      new DynamoEventSource(rssHistoryTable, {
        startingPosition: StartingPosition.LATEST,
        batchSize: 1,
      })
    );

    // Allow writing to DynamoDB
    rssHistoryTable.grantWriteData(newsCrawlerRole);
    rssHistoryTable.grantWriteData(notifyNewEntryRole);

    // Lambda Function to fetch RSS and write to DynamoDB
    const newsCrawler = new PythonFunction(this, `newsCrawler`, {
      runtime: Runtime.PYTHON_3_14,
      entry: path.join(__dirname, '../lambda/rss-crawler'),
      handler: 'handler',
      index: 'index.py',
      timeout: Duration.seconds(60),
      logRetention: RetentionDays.TWO_WEEKS,
      role: newsCrawlerRole,
      environment: crawlerEnvironment,
    });

    for (const notifierName in notifiers) {
      const notifier = notifiers[notifierName];
      // const cron is a cronOption defined in a notifier. if it is not defined, set default schedule (every hour)
      const schedule: CronOptions = notifier['schedule'] || {
        minute: '0',
        hour: '*',
        day: '*',
        month: '*',
        year: '*',
      };
      const webhookUrlParameterName = notifier['webhookUrlParameterName'];
      const webhookUrlParameterStore = StringParameter.fromSecureStringParameterAttributes(
        this,
        `webhookUrlParameterStore-${notifierName}`,
        {
          parameterName: webhookUrlParameterName,
        }
      );

      // add permission to Lambda Role
      webhookUrlParameterStore.grantRead(notifyNewEntryRole);

      // Scheduled Rule for RSS Crawler
      // Run every hour, 24 hours a day
      // see https://docs.aws.amazon.com/AmazonCloudWatch/latest/events/ScheduledEvents.html#CronExpressions
      const rule = new Rule(this, `CheckUpdate-${notifierName}`, {
        schedule: Schedule.cron(schedule),
        enabled: true,
      });

      rule.addTarget(
        new LambdaFunction(newsCrawler, {
          event: RuleTargetInput.fromObject({ notifierName, notifier }),
          retryAttempts: 2,
        })
      );
    }

    new CfnOutput(this, 'CommitHash', { value: commitHash });
  }
}
