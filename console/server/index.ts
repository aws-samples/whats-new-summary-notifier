import express from 'express';
import cors from 'cors';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { loadSharedConfigFiles } from '@smithy/shared-ini-file-loader';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import {
  CloudFormationClient,
  ListStacksCommand,
  DescribeStacksCommand,
  ListStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import {
  DynamoDBClient,
  ListTablesCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { LambdaClient, GetFunctionConfigurationCommand, InvokeCommand } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand, PutParameterCommand, DeleteParameterCommand, DescribeParametersCommand } from '@aws-sdk/client-ssm';
import {
  CodeBuildClient,
  CreateProjectCommand,
  UpdateProjectCommand,
  StartBuildCommand,
  BatchGetBuildsCommand,
  DeleteProjectCommand,
} from '@aws-sdk/client-codebuild';
import {
  IAMClient,
  CreateRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  DeleteRoleCommand,
} from '@aws-sdk/client-iam';
import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { S3Client, CreateBucketCommand, PutObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { execSync } from 'child_process';

const app = express();
app.use(cors());
app.use(express.json());

// Deploy constants
const PROJECT_PREFIX = 'whats-new-summary-notifier';
const CODEBUILD_IMAGE = 'aws/codebuild/amazonlinux2-x86_64-standard:5.0';
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const CACHE_DIR = path.resolve(__dirname, '../../tenants/.cache');
const CACHE_TTL_MS = 60 * 60 * 1000;

function getCachePath(profile: string) {
  return path.join(CACHE_DIR, `${profile.replace(/[^a-zA-Z0-9_+-]/g, '_')}.json`);
}

function readCache(profile: string) {
  const p = getCachePath(profile);
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (Date.now() - data.timestamp < CACHE_TTL_MS) return data;
  } catch { /* ignore corrupt cache */ }
  return null;
}

function writeCache(profile: string, stacks: unknown[]) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(getCachePath(profile), JSON.stringify({ timestamp: Date.now(), stacks }, null, 2) + '\n');
}

const STACK_PREFIX = 'WhatsNewSummaryNotifier';
const REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
  'ap-southeast-1', 'ap-southeast-2', 'ap-south-1',
  'eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-north-1',
  'sa-east-1', 'ca-central-1',
];

// ─── Existing endpoints ───

app.get('/api/profiles', async (_req, res) => {
  try {
    const files = await loadSharedConfigFiles();
    const names = new Set([
      ...Object.keys(files.credentialsFile ?? {}),
      ...Object.keys(files.configFile ?? {}),
    ]);
    res.json([...names].sort());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/account', async (req, res) => {
  const profile = (req.query.profile as string) || 'default';
  try {
    const sts = new STSClient({ credentials: fromIni({ profile }) });
    const { Account, Arn } = await sts.send(new GetCallerIdentityCommand({}));
    res.json({ accountId: Account, arn: Arn });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stacks', async (req, res) => {
  const profile = (req.query.profile as string) || 'default';
  const forceRefresh = req.query.refresh === 'true';
  const credentials = fromIni({ profile });

  if (!forceRefresh) {
    const cached = readCache(profile);
    if (cached) return res.json(cached.stacks);
  }

  const results: any[] = [];

  await Promise.all(
    REGIONS.map(async (region) => {
      try {
        const cf = new CloudFormationClient({ region, credentials });
        const { StackSummaries } = await cf.send(
          new ListStacksCommand({ StackStatusFilter: ['CREATE_COMPLETE', 'UPDATE_COMPLETE'] })
        );
        for (const s of StackSummaries ?? []) {
          if (!s.StackName?.startsWith(STACK_PREFIX)) continue;
          const { Stacks } = await cf.send(new DescribeStacksCommand({ StackName: s.StackName }));
          const stack = Stacks?.[0];

          let envVars: Record<string, string> = {};
          try {
            const { StackResourceSummaries } = await cf.send(
              new ListStackResourcesCommand({ StackName: s.StackName })
            );
            const lambdas = (StackResourceSummaries ?? []).filter(
              (r) => r.ResourceType === 'AWS::Lambda::Function'
            );
            const lambda = new LambdaClient({ region, credentials });
            for (const l of lambdas) {
              if (!l.PhysicalResourceId) continue;
              try {
                const fn = await lambda.send(
                  new GetFunctionConfigurationCommand({ FunctionName: l.PhysicalResourceId })
                );
                const vars = fn.Environment?.Variables ?? {};
                if (vars['MODEL_IDS'] || vars['MODEL_ID'] || vars['NOTIFIERS'] || vars['APP']) {
                  envVars = { ...envVars, ...vars };
                }
              } catch { /* skip */ }
            }
          } catch { /* ignore */ }

          const tenant =
            s.StackName === 'WhatsNewSummaryNotifierStack'
              ? '(default)'
              : s.StackName.replace('WhatsNewSummaryNotifier-', '');

          results.push({
            stackName: s.StackName,
            region,
            tenant,
            status: s.StackStatus,
            createdAt: s.CreationTime,
            updatedAt: s.LastUpdatedTime,
            parameters: stack?.Parameters ?? [],
            outputs: stack?.Outputs ?? [],
            tags: stack?.Tags ?? [],
            envVars,
          });
        }
      } catch { /* skip */ }
    })
  );
  const sorted = results.sort((a, b) => a.region.localeCompare(b.region));
  writeCache(profile, sorted);
  res.json(sorted);
});

app.get('/api/cache-status', (req, res) => {
  const profile = (req.query.profile as string) || 'default';
  const cached = readCache(profile);
  if (!cached) return res.json({ valid: false });
  res.json({ valid: true, age: Date.now() - cached.timestamp, stacks: cached.stacks });
});

app.get('/api/ssm', async (req, res) => {
  const profile = (req.query.profile as string) || 'default';
  const region = req.query.region as string;
  const name = req.query.name as string;
  if (!region || !name) return res.status(400).json({ error: 'region and name required' });
  try {
    const ssm = new SSMClient({ region, credentials: fromIni({ profile }) });
    const { Parameter } = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true })
    );
    res.json({
      name: Parameter?.Name,
      type: Parameter?.Type,
      version: Parameter?.Version,
      lastModified: Parameter?.LastModifiedDate,
      value: Parameter?.Value,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/ddb/tables', async (req, res) => {
  const profile = (req.query.profile as string) || 'default';
  const region = req.query.region as string;
  if (!region) return res.status(400).json({ error: 'region required' });
  try {
    const ddb = new DynamoDBClient({ region, credentials: fromIni({ profile }) });
    const { TableNames } = await ddb.send(new ListTablesCommand({}));
    res.json((TableNames ?? []).filter((t) => t.includes('RSSHistory')));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/ddb', async (req, res) => {
  const profile = (req.query.profile as string) || 'default';
  const region = req.query.region as string;
  const tableName = req.query.table as string;
  if (!region || !tableName) return res.status(400).json({ error: 'region and table required' });
  try {
    const ddb = new DynamoDBClient({ region, credentials: fromIni({ profile }) });
    const { Items, Count } = await ddb.send(new ScanCommand({ TableName: tableName, Limit: 50 }));
    res.json({ items: Items ?? [], count: Count ?? 0 });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/export-tenant', (req, res) => {
  const { tenant, region, accountId, config } = req.body;
  if (!config) return res.status(400).json({ error: 'config required' });
  const dir = path.resolve(__dirname, '../../tenants/exported'); // nosemgrep: path-traversal
  fs.mkdirSync(dir, { recursive: true });
  const parts = [accountId || 'unknown', region || 'unknown', tenant || 'default'];
  const filename = `${parts.join('_').replace(/[^a-zA-Z0-9_+-]/g, '_')}.json`;
  const filePath = path.join(dir, filename); // nosemgrep: path-traversal
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
  res.json({ path: `tenants/exported/${filename}` });
});

// ─── Deploy helpers ───

function deriveNames(tenant: string) {
  const hasTenant = tenant && tenant !== '(default)';
  return {
    ssmParamName: hasTenant ? `/WhatsNew/URL/${tenant}` : '/WhatsNew/URL',
    cbProjectName: hasTenant ? `${PROJECT_PREFIX}-${tenant}` : PROJECT_PREFIX,
    stackName: hasTenant ? `WhatsNewSummaryNotifier-${tenant}` : 'WhatsNewSummaryNotifierStack',
    roleName: hasTenant ? `${PROJECT_PREFIX}-${tenant}-role` : `${PROJECT_PREFIX}-role`,
  };
}

const TRUST_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Principal: { Service: 'codebuild.amazonaws.com' }, Action: 'sts:AssumeRole' }],
});

const DEPLOY_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [{
    Effect: 'Allow',
    Action: [
      'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents',
      's3:*', 'cloudformation:*', 'iam:*', 'lambda:*', 'dynamodb:*',
      'events:*', 'ssm:*',
      'bedrock:*', 'sts:AssumeRole', 'ecr:*',
    ],
    Resource: '*',
  }],
});

async function ensureIamRole(iam: IAMClient, roleName: string): Promise<string> {
  try {
    const { Role } = await iam.send(new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: TRUST_POLICY,
    }));
    // New role — attach policy and wait for propagation
    await iam.send(new PutRolePolicyCommand({
      RoleName: roleName, PolicyName: 'deploy-policy', PolicyDocument: DEPLOY_POLICY,
    }));
    await new Promise((r) => setTimeout(r, 10000));
    return Role!.Arn!;
  } catch (e: any) {
    if (e.name === 'EntityAlreadyExistsException') {
      // Ensure policy is up to date
      await iam.send(new PutRolePolicyCommand({
        RoleName: roleName, PolicyName: 'deploy-policy', PolicyDocument: DEPLOY_POLICY,
      }));
      const { Role } = await iam.send(new GetRoleCommand({ RoleName: roleName }));
      return Role!.Arn!;
    }
    throw e;
  }
}

async function ensureCodeBuildProject(cb: CodeBuildClient, name: string, roleArn: string, s3Bucket: string, s3Key: string) {
  const source = { type: 'S3' as const, location: `${s3Bucket}/${s3Key}` };
  const environment = {
    type: 'LINUX_CONTAINER' as const,
    image: CODEBUILD_IMAGE,
    computeType: 'BUILD_GENERAL1_MEDIUM' as const,
    privilegedMode: true,
  };
  try {
    await cb.send(new CreateProjectCommand({
      name, source, artifacts: { type: 'NO_ARTIFACTS' as const }, environment, serviceRole: roleArn, timeoutInMinutes: 30,
    }));
  } catch (e: any) {
    if (e.name === 'ResourceAlreadyExistsException') {
      // Update only source location (preserve existing role)
      await cb.send(new UpdateProjectCommand({ name, source }));
    } else throw e;
  }
}

async function ensureS3Bucket(s3: S3Client, bucket: string) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

async function uploadSource(s3: S3Client, bucket: string, key: string): Promise<string> {
  const zipData = execSync( // nosemgrep: dangerous-exec-cmd
    'zip -r - . -x ".git/*" "node_modules/*" "cdk.out/*" "console/*" ".cache/*" "tenants/.cache/*" ".ash/*" ".pytest_cache/*" ".ruff_cache/*" "__pycache__/*" "doc/*"',
    { cwd: PROJECT_ROOT, maxBuffer: 100 * 1024 * 1024 }
  );
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: zipData }));
  try { return execSync('git rev-parse --short HEAD', { cwd: PROJECT_ROOT }).toString().trim(); } catch { return 'unknown'; } // nosemgrep: dangerous-exec-cmd
}

function buildDefaultConfig(destination: string, language: string, ssmParamName: string) {
  const summarizerName = language === 'english' ? 'AwsSolutionsArchitectEnglish' : 'AwsSolutionsArchitectJapanese';
  return {
    notifiers: {
      AwsWhatsNew: {
        destination,
        summarizerName,
        webhookUrlParameterName: ssmParamName,
        rssUrl: { "What's new": 'https://aws.amazon.com/about-aws/whats-new/recent/feed/' },
      },
    },
  };
}

// ─── Deploy endpoints ───

// Helper: upload source and get S3 location
async function prepareSource(credentials: ReturnType<typeof fromIni>, accountId: string, region: string) {
  const s3 = new S3Client({ region, credentials });
  const bucket = `wnsn-deploy-${accountId}-${region}`;
  const key = `source/${Date.now()}.zip`;
  await ensureS3Bucket(s3, bucket);
  const commitHash = await uploadSource(s3, bucket, key);
  return { bucket, key, commitHash };
}

// New tenant deploy
app.post('/api/deploy', async (req, res) => {
  const { tenant = '', destination = 'slack', language = 'japanese', webhookUrl, profile = 'default', cdkContext, region: reqRegion, skipSsm, ssmParamName: customSsmName } = req.body;
  if (!skipSsm && !webhookUrl) return res.status(400).json({ error: 'webhookUrl required (or check "Use existing SSM parameter")' });
  const credentials = fromIni({ profile });
  const { ssmParamName: defaultSsmName, cbProjectName, roleName } = deriveNames(tenant);
  const ssmParamName = customSsmName || defaultSsmName;

  try {
    const sts = new STSClient({ credentials });
    const { Account } = await sts.send(new GetCallerIdentityCommand({}));
    const defaultRegion = (sts.config as any)?.region?.() ?? 'us-east-1';
    const resolvedRegion = reqRegion || (typeof defaultRegion === 'string' ? defaultRegion : await defaultRegion);

    // 1. Store webhook URL in SSM (skip if using existing)
    if (!skipSsm && webhookUrl) {
      const ssm = new SSMClient({ region: resolvedRegion, credentials });
      await ssm.send(new PutParameterCommand({
        Name: ssmParamName, Type: 'SecureString', Value: webhookUrl, Overwrite: true,
      }));
    }

    // 2. Ensure IAM role
    const iam = new IAMClient({ region: resolvedRegion, credentials });
    const roleArn = await ensureIamRole(iam, roleName);

    // 3. Upload source to S3 and ensure CodeBuild project
    const { bucket, key, commitHash } = await prepareSource(credentials, Account!, resolvedRegion);
    const cb = new CodeBuildClient({ region: resolvedRegion, credentials });
    await ensureCodeBuildProject(cb, cbProjectName, roleArn, bucket, key);

    // 4. Start build
    const ctx = cdkContext ?? buildDefaultConfig(destination, language, ssmParamName);
    const { build } = await cb.send(new StartBuildCommand({
      projectName: cbProjectName,
      environmentVariablesOverride: [
        { name: 'TENANT', value: tenant || '', type: 'PLAINTEXT' },
        { name: 'CONFIG_FILE', value: '', type: 'PLAINTEXT' },
        { name: 'CDK_CONTEXT_JSON', value: JSON.stringify(ctx), type: 'PLAINTEXT' },
        { name: 'COMMIT_HASH', value: commitHash, type: 'PLAINTEXT' },
      ],
    }));

    res.json({ buildId: build!.id, projectName: cbProjectName, region: resolvedRegion });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Update existing tenant
app.post('/api/deploy/update', async (req, res) => {
  const { tenant = '', destination = 'slack', language = 'japanese', webhookUrl, profile = 'default', region, cdkContext, skipSsm, ssmParamName: customSsmName } = req.body;
  const credentials = fromIni({ profile });
  const { ssmParamName: defaultSsmName, cbProjectName } = deriveNames(tenant);
  const ssmParamName = customSsmName || defaultSsmName;
  const targetRegion = region || 'us-east-1';

  try {
    if (!skipSsm && webhookUrl) {
      const ssm = new SSMClient({ region: targetRegion, credentials });
      await ssm.send(new PutParameterCommand({
        Name: ssmParamName, Type: 'SecureString', Value: webhookUrl, Overwrite: true,
      }));
    }

    // Re-upload source and update project
    const sts = new STSClient({ credentials });
    const { Account } = await sts.send(new GetCallerIdentityCommand({}));
    const { bucket, key, commitHash } = await prepareSource(credentials, Account!, targetRegion);
    const iam = new IAMClient({ region: targetRegion, credentials });
    const roleArn = await ensureIamRole(iam, deriveNames(tenant).roleName);
    const cb = new CodeBuildClient({ region: targetRegion, credentials });
    await ensureCodeBuildProject(cb, cbProjectName, roleArn, bucket, key);

    const ctx = cdkContext ?? buildDefaultConfig(destination, language, ssmParamName);
    const { build } = await cb.send(new StartBuildCommand({
      projectName: cbProjectName,
      environmentVariablesOverride: [
        { name: 'TENANT', value: tenant || '', type: 'PLAINTEXT' },
        { name: 'CONFIG_FILE', value: '', type: 'PLAINTEXT' },
        { name: 'CDK_CONTEXT_JSON', value: JSON.stringify(ctx), type: 'PLAINTEXT' },
        { name: 'COMMIT_HASH', value: commitHash, type: 'PLAINTEXT' },
      ],
    }));

    res.json({ buildId: build!.id, projectName: cbProjectName, region: targetRegion });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Destroy stack
app.post('/api/deploy/destroy', async (req, res) => {
  const { tenant = '', profile = 'default', region, confirmTenant } = req.body;
  const actualTenant = tenant === '(default)' ? '' : tenant;
  const expectedConfirm = tenant === '(default)' ? 'default' : tenant;

  if (confirmTenant !== expectedConfirm) {
    return res.status(400).json({ error: `Tenant name mismatch. Expected "${expectedConfirm}", got "${confirmTenant}"` });
  }

  const credentials = fromIni({ profile });
  const { cbProjectName } = deriveNames(actualTenant);
  const targetRegion = region || 'us-east-1';

  try {
    const cb = new CodeBuildClient({ region: targetRegion, credentials });
    const destroyBuildspec = [
      'version: 0.2',
      'phases:',
      '  install:',
      '    runtime-versions:',
      '      nodejs: 22',
      '    commands:',
      '      - npm install -g aws-cdk',
      '      - npm ci',
      '  build:',
      '    commands:',
      '      - |',
      '        CDK_ARGS=""',
      '        if [ -n "$TENANT" ]; then CDK_ARGS="-c tenant=$TENANT"; fi',
      '        npx cdk destroy --force $CDK_ARGS',
    ].join('\n');

    const { build } = await cb.send(new StartBuildCommand({
      projectName: cbProjectName,
      buildspecOverride: destroyBuildspec,
      environmentVariablesOverride: [
        { name: 'TENANT', value: actualTenant, type: 'PLAINTEXT' },
        { name: 'DEPLOY_ACTION', value: 'destroy', type: 'PLAINTEXT' },
      ],
    }));

    res.json({ buildId: build!.id, projectName: cbProjectName, region: targetRegion });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Post-destroy cleanup
app.post('/api/deploy/cleanup', async (req, res) => {
  const { tenant = '', profile = 'default', region } = req.body;
  const actualTenant = tenant === '(default)' ? '' : tenant;
  const credentials = fromIni({ profile });
  const { ssmParamName, cbProjectName, roleName } = deriveNames(actualTenant);
  const targetRegion = region || 'us-east-1';
  const errors: string[] = [];

  try {
    const cb = new CodeBuildClient({ region: targetRegion, credentials });
    await cb.send(new DeleteProjectCommand({ name: cbProjectName }));
  } catch (e: any) { errors.push(`CodeBuild: ${e.message}`); }

  try {
    const iam = new IAMClient({ region: targetRegion, credentials });
    await iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: 'deploy-policy' }));
    await iam.send(new DeleteRoleCommand({ RoleName: roleName }));
  } catch (e: any) { errors.push(`IAM: ${e.message}`); }

  try {
    const ssm = new SSMClient({ region: targetRegion, credentials });
    await ssm.send(new DeleteParameterCommand({ Name: ssmParamName }));
  } catch (e: any) { errors.push(`SSM: ${e.message}`); }

  res.json({ ok: true, errors });
});

// Build status
app.get('/api/deploy/status', async (req, res) => {
  const { buildId, profile = 'default', region } = req.query as Record<string, string>;
  if (!buildId) return res.status(400).json({ error: 'buildId required' });
  try {
    const credentials = fromIni({ profile });
    const cb = new CodeBuildClient({ region: region || undefined, credentials });
    const { builds } = await cb.send(new BatchGetBuildsCommand({ ids: [buildId] }));
    const b = builds?.[0];
    if (!b) return res.status(404).json({ error: 'Build not found' });
    res.json({
      status: b.buildStatus,
      startTime: b.startTime,
      endTime: b.endTime,
      phases: b.phases?.map((p) => ({ name: p.phaseType, status: p.phaseStatus, duration: p.durationInSeconds })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Build logs
app.get('/api/deploy/logs', async (req, res) => {
  const { buildId, profile = 'default', nextToken, region } = req.query as Record<string, string>;
  if (!buildId) return res.status(400).json({ error: 'buildId required' });
  try {
    const credentials = fromIni({ profile });
    // buildId format: "projectName:buildUUID"
    const colonIdx = buildId.indexOf(':');
    const projectName = buildId.substring(0, colonIdx);
    const buildNum = buildId.substring(colonIdx + 1);
    const logGroup = `/aws/codebuild/${projectName}`;
    const logStream = buildNum;

    const cwl = new CloudWatchLogsClient({ region: region || undefined, credentials });
    const params: any = {
      logGroupName: logGroup,
      logStreamName: logStream,
      startFromHead: true,
    };
    if (nextToken) params.nextToken = nextToken;

    const result = await cwl.send(new GetLogEventsCommand(params));
    res.json({
      events: (result.events ?? []).map((e) => ({ timestamp: e.timestamp, message: e.message })),
      nextToken: result.nextForwardToken,
    });
  } catch (e: any) {
    // Logs may not be available yet
    if (e.name === 'ResourceNotFoundException') {
      return res.json({ events: [], nextToken: null });
    }
    res.status(500).json({ error: e.message });
  }
});

// List SSM parameters matching /WhatsNew/ prefix
app.get('/api/ssm/list', async (req, res) => {
  const profile = (req.query.profile as string) || 'default';
  const region = req.query.region as string;
  if (!region) return res.status(400).json({ error: 'region required' });
  try {
    const ssm = new SSMClient({ region, credentials: fromIni({ profile }) });
    const { Parameters } = await ssm.send(new DescribeParametersCommand({
      ParameterFilters: [{ Key: 'Name', Option: 'BeginsWith', Values: ['/WhatsNew/'] }],
      MaxResults: 50,
    }));
    res.json((Parameters ?? []).map((p) => ({ name: p.Name, type: p.Type, lastModified: p.LastModifiedDate })));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Invoke RSS crawler Lambda for testing
app.post('/api/invoke-crawler', async (req, res) => {
  const { stackName, region, profile = 'default' } = req.body;
  if (!stackName || !region) return res.status(400).json({ error: 'stackName and region required' });
  try {
    const credentials = fromIni({ profile });
    const cf = new CloudFormationClient({ region, credentials });
    const { StackResourceSummaries } = await cf.send(new ListStackResourcesCommand({ StackName: stackName }));
    const crawler = (StackResourceSummaries ?? []).find(
      (r) => r.ResourceType === 'AWS::Lambda::Function' && r.LogicalResourceId?.toLowerCase().includes('crawler')
    );
    if (!crawler?.PhysicalResourceId) return res.status(404).json({ error: 'Crawler Lambda not found in stack' });
    // Get notifiers config from notify Lambda env vars
    const lambda = new LambdaClient({ region, credentials });
    const notifyFn = (StackResourceSummaries ?? []).find(
      (r) => r.ResourceType === 'AWS::Lambda::Function' && r.LogicalResourceId?.toLowerCase().includes('notify')
    );
    let notifiers: Record<string, any> = {};
    if (notifyFn?.PhysicalResourceId) {
      const fn = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: notifyFn.PhysicalResourceId }));
      try { notifiers = JSON.parse(fn.Environment?.Variables?.['NOTIFIERS'] ?? '{}'); } catch { /* */ }
    }
    const entries = Object.entries(notifiers);
    if (entries.length === 0) return res.status(400).json({ error: 'No notifiers config found in stack' });
    // Invoke crawler once per notifier (same payload as EventBridge)
    const results: any[] = [];
    for (const [notifierName, notifier] of entries) {
      const r = await lambda.send(new InvokeCommand({
        FunctionName: crawler.PhysicalResourceId,
        InvocationType: 'RequestResponse',
        Payload: new TextEncoder().encode(JSON.stringify({ notifierName, notifier })),
      }));
      results.push({ notifierName, statusCode: r.StatusCode, payload: r.Payload ? new TextDecoder().decode(r.Payload) : '' });
    }
    res.json({ functionName: crawler.PhysicalResourceId, results });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Bedrock model list (foundation models + CRIS inference profiles)
app.get('/api/bedrock/models', async (req, res) => {
  const profile = (req.query.profile as string) || 'default';
  const region = (req.query.region as string) || 'us-east-1';
  try {
    const bedrock = new BedrockClient({ region, credentials: fromIni({ profile }) });
    const [fmRes, ipRes] = await Promise.all([
      bedrock.send(new ListFoundationModelsCommand({ byOutputModality: 'TEXT', byInferenceType: 'ON_DEMAND' })),
      bedrock.send(new ListInferenceProfilesCommand({ typeEquals: 'SYSTEM_DEFINED' })),
    ]);
    const models = (fmRes.modelSummaries ?? [])
      .filter((m) => m.modelId && m.modelLifecycle?.status !== 'LEGACY')
      .map((m) => ({ modelId: m.modelId!, modelName: m.modelName!, provider: m.providerName!, type: 'foundation' as const }));
    const cris = (ipRes.inferenceProfileSummaries ?? [])
      .filter((p) => p.inferenceProfileId && p.status === 'ACTIVE')
      .map((p) => ({ modelId: p.inferenceProfileId!, modelName: p.inferenceProfileName!, provider: 'Cross-Region (CRIS)', type: 'cris' as const }));
    const all = [...cris, ...models].sort((a, b) => a.type.localeCompare(b.type) || a.provider.localeCompare(b.provider) || a.modelName.localeCompare(b.modelName));
    res.json(all);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(3456, () =>
  console.log('API server: http://localhost:3456\nOpen http://localhost:5173 in your browser')
);
