import { Construct } from 'constructs';
import { Stack, StackProps, Duration, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { Table, AttributeType, BillingMode, StreamViewType } from 'aws-cdk-lib/aws-dynamodb';
import { Rule, Schedule, RuleTargetInput, CronOptions } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Role, Policy, ServicePrincipal, PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Runtime, StartingPosition, FilterCriteria, FilterRule } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource, SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { PythonFunction } from '@aws-cdk/aws-lambda-python-alpha';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
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

    // Log groups that the stack owns. CloudFormation names them (<stack name>-<id>-<suffix>):
    // a deployment made with the old logRetention setting already has /aws/lambda/<function
    // name>, so reusing that name would fail on update. RETAIN_ON_UPDATE_OR_DELETE keeps the logs
    // when the stack is deleted, and deletes a log group only when the update that created it
    // is rolled back.
    const newLogGroup = (id: string) =>
      new LogGroup(this, id, {
        retention: RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
      });

    // Lambda Function to post new entries written to DynamoDB to Slack or Microsoft Teams
    const notifyNewEntry = new PythonFunction(this, 'NotifyNewEntry', {
      runtime: Runtime.PYTHON_3_15,
      entry: path.join(__dirname, '../lambda/notify-to-app'),
      handler: 'handler',
      index: 'index.py',
      timeout: Duration.seconds(180),
      logGroup: newLogGroup('NotifyNewEntryLogGroup'),
      role: notifyNewEntryRole,
      reservedConcurrentExecutions: 1,
      environment: notifyEnvironment,
    });

    // Records that still fail after the retries below. Lambda sends only metadata about the
    // failed batch (shard, sequence numbers, reason), not the article itself.
    const notifyFailureQueue = new Queue(this, 'NotifyFailureQueue', {
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });

    notifyNewEntry.addEventSource(
      new DynamoEventSource(rssHistoryTable, {
        startingPosition: StartingPosition.LATEST,
        // One record per invocation, so a retry never posts another article again
        batchSize: 1,
        // Only new articles: the notify Lambda's own write-backs are MODIFY records
        filters: [FilterCriteria.filter({ eventName: FilterRule.isEqual('INSERT') })],
        // The notify Lambda raises only failures a retry may fix (throttling, 5xx, timeouts)
        retryAttempts: 2,
        maxRecordAge: Duration.hours(6),
        onFailure: new SqsDlq(notifyFailureQueue),
      })
    );

    // Alarms without actions: add an action (for example an SNS topic) in CloudWatch if you
    // want to be told. IteratorAge is how far the notify Lambda is behind the stream.
    new Alarm(this, 'NotifyIteratorAgeAlarm', {
      alarmDescription: 'The notify Lambda is more than 30 minutes behind the DynamoDB stream',
      metric: notifyNewEntry.metric('IteratorAge', { statistic: 'Maximum', period: Duration.minutes(5) }),
      threshold: Duration.minutes(30).toMilliseconds(),
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    new Alarm(this, 'NotifyFailureQueueAlarm', {
      alarmDescription: 'Articles were not notified after the retries; see the NotifyFailureQueue messages',
      metric: notifyFailureQueue.metricApproximateNumberOfMessagesVisible({
        statistic: 'Maximum',
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    // Allow writing to DynamoDB
    rssHistoryTable.grantWriteData(newsCrawlerRole);
    rssHistoryTable.grantWriteData(notifyNewEntryRole);

    // Lambda Function to fetch RSS and write to DynamoDB
    const newsCrawler = new PythonFunction(this, `newsCrawler`, {
      runtime: Runtime.PYTHON_3_15,
      entry: path.join(__dirname, '../lambda/rss-crawler'),
      handler: 'handler',
      index: 'index.py',
      timeout: Duration.seconds(60),
      logGroup: newLogGroup('NewsCrawlerLogGroup'),
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
