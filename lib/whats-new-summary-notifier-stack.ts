import { Construct } from 'constructs';
import { Stack, StackProps, Duration, CfnOutput, RemovalPolicy, ArnFormat, Token } from 'aws-cdk-lib';
import { Table, AttributeType, BillingMode, StreamViewType } from 'aws-cdk-lib/aws-dynamodb';
import { Rule, Schedule, RuleTargetInput, CronOptions } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Role, Policy, ServicePrincipal, PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Runtime, StartingPosition, FilterCriteria, FilterRule, LoggingFormat } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource, SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Alarm, CfnAlarm, ComparisonOperator, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { ITopic, Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { NagSuppressions } from 'cdk-nag';
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
// Retries of a failed stream record. The notify Lambda gets the attempt count (retries + 1) so
// it can mark the item failed on the last attempt.
const NOTIFY_RETRY_ATTEMPTS = 2;

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

export interface AlarmSettings {
  topicArn?: string;
  email?: string;
  noNewEntriesDays?: number;
}

const ALARM_KEYS = ['topicArn', 'email', 'noNewEntriesDays'];
const SNS_TOPIC_ARN = /^arn:aws[a-z-]*:sns:([a-z0-9-]+):(\d{12}):[A-Za-z0-9_-]{1,256}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Read the optional `alarms` context: where the stack's alarms send their ALARM and OK
 * notifications. Without it the alarms have no actions, as before.
 *
 * `-c alarms='{...}'` on the cdk command line passes the value as a string, so a JSON
 * string is accepted as well as an object.
 */
/**
 * The optional `lambdaLogFormat` setting: "TEXT" or "JSON" for both functions. Without it the
 * functions keep Lambda's default (plain text) and the template has no LogFormat.
 */
export function parseLambdaLogFormat(value: unknown): LoggingFormat | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'TEXT') return LoggingFormat.TEXT;
  if (value === 'JSON') return LoggingFormat.JSON;
  throw new Error('lambdaLogFormat must be "TEXT" or "JSON"');
}

export function parseAlarmSettings(value: unknown, region: string): AlarmSettings | undefined {
  if (value === undefined || value === null) return undefined;
  let settings = value;
  if (typeof settings === 'string') {
    try {
      settings = JSON.parse(settings);
    } catch {
      throw new Error('alarms must be a JSON object');
    }
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new Error('alarms must be an object');
  }
  const s = settings as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    if (!ALARM_KEYS.includes(key)) throw new Error(`alarms.${key} is not a known setting (${ALARM_KEYS.join(', ')})`);
  }
  const { topicArn, email, noNewEntriesDays } = s;
  if (topicArn !== undefined && email !== undefined) {
    throw new Error('alarms.topicArn and alarms.email cannot both be set');
  }
  const result: AlarmSettings = {};
  if (topicArn !== undefined) {
    const m = typeof topicArn === 'string' ? SNS_TOPIC_ARN.exec(topicArn) : null;
    if (!m) throw new Error('alarms.topicArn must be the ARN of an SNS standard topic');
    // CloudWatch alarms publish only to a topic in their own Region
    if (!Token.isUnresolved(region) && m[1] !== region) {
      throw new Error(`alarms.topicArn is in ${m[1]}; use a topic in the stack's Region (${region})`);
    }
    result.topicArn = m[0];
  }
  if (email !== undefined) {
    if (typeof email !== 'string' || !EMAIL.test(email)) throw new Error('alarms.email must be an email address');
    result.email = email;
  }
  if (noNewEntriesDays !== undefined) {
    // A daily period over N periods; CloudWatch allows at most 7 days for period x periods
    if (typeof noNewEntriesDays !== 'number' || !Number.isInteger(noNewEntriesDays) || noNewEntriesDays < 1 || noNewEntriesDays > 7) {
      throw new Error('alarms.noNewEntriesDays must be a whole number of days from 1 to 7');
    }
    result.noNewEntriesDays = noNewEntriesDays;
  }
  return Object.keys(result).length ? result : undefined;
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
    const alarmSettings = parseAlarmSettings(this.node.tryGetContext('alarms'), region);
    const loggingFormat = parseLambdaLogFormat(this.node.tryGetContext('lambdaLogFormat'));

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
      NOTIFY_MAX_ATTEMPTS: String(NOTIFY_RETRY_ATTEMPTS + 1),
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
      loggingFormat,
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
        retryAttempts: NOTIFY_RETRY_ATTEMPTS,
        maxRecordAge: Duration.hours(6),
        onFailure: new SqsDlq(notifyFailureQueue),
      })
    );

    // Every alarm goes in this list; the optional `alarms` setting adds its actions at the end.
    // IteratorAge is how far the notify Lambda is behind the stream.
    const alarms: Alarm[] = [];
    alarms.push(new Alarm(this, 'NotifyIteratorAgeAlarm', {
      alarmDescription: 'The notify Lambda is more than 30 minutes behind the DynamoDB stream',
      metric: notifyNewEntry.metric('IteratorAge', { statistic: 'Maximum', period: Duration.minutes(5) }),
      threshold: Duration.minutes(30).toMilliseconds(),
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }));
    alarms.push(new Alarm(this, 'NotifyFailureQueueAlarm', {
      alarmDescription: 'Articles were not notified after the retries; see the NotifyFailureQueue messages',
      metric: notifyFailureQueue.metricApproximateNumberOfMessagesVisible({
        statistic: 'Maximum',
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }));

    // The notify Lambda writes one EMF log line per record with these counts (see index.py).
    // Failed: an article was given up (webhook 4xx, no access to the model, no text, ...).
    // RelevanceFailOpen: the topics check got no answer from any model and posted anyway.
    const notifyMetric = (metricName: string) =>
      new Metric({
        namespace: 'WhatsNewSummaryNotifier',
        metricName,
        dimensionsMap: { FunctionName: notifyNewEntry.functionName },
        statistic: 'Sum',
        period: Duration.hours(1),
      });
    alarms.push(
      new Alarm(this, 'NotifyFailedAlarm', {
        alarmDescription:
          'An article was not notified and its item has summary_status=failed; the item\'s failure_reason and the notify Lambda log ("is not notified") say why',
        metric: notifyMetric('Failed'),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      })
    );
    const anyTopics = Object.values(notifiers ?? {}).some((n) => {
      const topics = (n as { filter?: { topics?: unknown } })?.filter?.topics;
      return Array.isArray(topics) && topics.some((t) => typeof t === 'string' && t.trim() !== '');
    });
    if (anyTopics) {
      alarms.push(
        new Alarm(this, 'RelevanceFailOpenAlarm', {
          alarmDescription:
            'The topics check got no valid answer from any model, so an article was posted without the check; see "relevance" in the notify Lambda log',
          metric: notifyMetric('RelevanceFailOpen'),
          threshold: 1,
          evaluationPeriods: 1,
          comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: TreatMissingData.NOT_BREACHING,
        })
      );
    }

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
      loggingFormat,
      role: newsCrawlerRole,
      environment: crawlerEnvironment,
    });

    // A crawl that fails is retried twice by Lambda's asynchronous queue and then dropped. The
    // next hourly crawl reads the same 7 days again, so a dropped crawl loses nothing unless the
    // failure goes on, which this alarm shows.
    alarms.push(
      new Alarm(this, 'CrawlerDroppedAlarm', {
        alarmDescription:
          'A crawl failed 3 times and was dropped: an RSS feed could not be read or an article could not be written. Search the newsCrawler log group for "ERROR: RSS"',
        metric: newsCrawler.metric('AsyncEventsDropped', { statistic: 'Sum', period: Duration.hours(1) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      })
    );

    // Optional: no new article reached the notify Lambda for N days. It only receives INSERT
    // records, so its invocations count new articles (plus retries), for all notifiers together.
    const noNewEntriesDays = alarmSettings?.noNewEntriesDays;
    if (noNewEntriesDays) {
      const noNewEntries = new Alarm(this, 'NoNewEntriesAlarm', {
        alarmDescription: `No new article reached the notify Lambda for ${noNewEntriesDays} days: check the crawler logs, the EventBridge rules and the RSS feeds`,
        metric: notifyNewEntry.metric('Invocations', { statistic: 'Sum', period: Duration.days(1) }),
        threshold: 1,
        evaluationPeriods: noNewEntriesDays,
        datapointsToAlarm: noNewEntriesDays,
        comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
        // A day without invocations has no data point; count it as a day without articles
        treatMissingData: TreatMissingData.BREACHING,
      });
      // The L2 Alarm has no warm-up yet. Wait 2 days (the most CloudWatch allows) after the alarm
      // is created, so a new stack is not in ALARM before its first crawl.
      (noNewEntries.node.defaultChild as CfnAlarm).addPropertyOverride('WarmUpConfiguration', {
        WarmUpPeriodDurationInMinutes: 2880,
      });
      alarms.push(noNewEntries);
    }

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

    // Optional alarm notifications. Without the `alarms` setting nothing below is created and
    // the alarms keep no actions, so an action added by hand in CloudWatch stays in place.
    let alarmTopic: ITopic | undefined;
    if (alarmSettings?.topicArn) {
      alarmTopic = Topic.fromTopicArn(this, 'AlarmTopic', alarmSettings.topicArn);
    } else if (alarmSettings?.email) {
      // No encryption at rest: CloudWatch alarms cannot publish to a topic encrypted with the
      // AWS managed key (alias/aws/sns). Use alarms.topicArn for a topic encrypted with a
      // customer managed key. The notifications carry alarm names and states only.
      const topic = new Topic(this, 'AlarmTopic', { enforceSSL: true });
      topic.addToResourcePolicy(
        new PolicyStatement({
          sid: 'AllowCloudWatchAlarmsOfThisAccount',
          effect: Effect.ALLOW,
          principals: [new ServicePrincipal('cloudwatch.amazonaws.com')],
          actions: ['sns:Publish'],
          resources: [topic.topicArn],
          conditions: {
            StringEquals: { 'aws:SourceAccount': accountId },
            ArnLike: {
              'aws:SourceArn': this.formatArn({
                service: 'cloudwatch',
                resource: 'alarm',
                resourceName: '*',
                arnFormat: ArnFormat.COLON_RESOURCE_NAME,
              }),
            },
          },
        })
      );
      topic.addSubscription(new EmailSubscription(alarmSettings.email));
      NagSuppressions.addResourceSuppressions(topic, [
        {
          id: 'AwsSolutions-SNS2',
          reason:
            'Alarm notifications carry no article or secret. CloudWatch alarms cannot publish to a topic encrypted with alias/aws/sns; use alarms.topicArn for a topic encrypted with a customer managed key.',
        },
      ]);
      alarmTopic = topic;
    }
    if (alarmTopic) {
      const action = new SnsAction(alarmTopic);
      for (const alarm of alarms) {
        alarm.addAlarmAction(action);
        alarm.addOkAction(action);
      }
    }

    new CfnOutput(this, 'CommitHash', { value: commitHash });
  }
}
