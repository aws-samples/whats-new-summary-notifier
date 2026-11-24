import * as fs from 'fs';
import * as path from 'path';
import { deployPolicy } from '../console/server/deploy-policy';

const ACCOUNT = '123456789012';
const PROJECT = 'whats-new-summary-notifier-test';

type Statement = { Sid?: string; Action: string | string[]; Resource: string | string[] };
const list = (v: string | string[]) => (Array.isArray(v) ? v : [v]);

// The DEPLOY_POLICY heredoc in deploy.sh, with the shell variables filled in
function deployShPolicy(): { Statement: Statement[] } {
  const script = fs.readFileSync(path.join(__dirname, '..', 'deploy.sh'), 'utf-8');
  const body = script.split('DEPLOY_POLICY=$(cat <<EOJSON\n')[1].split('\nEOJSON')[0];
  return JSON.parse(body.replaceAll('${ACCOUNT_ID}', ACCOUNT).replaceAll('${CB_PROJECT_NAME}', PROJECT));
}

describe.each([
  ['console', () => deployPolicy(ACCOUNT, PROJECT) as { Statement: Statement[] }],
  ['deploy.sh', deployShPolicy],
])('CodeBuild deploy policy (%s)', (_name, policy) => {
  test('every resource is scoped to this account', () => {
    for (const s of policy().Statement) {
      for (const r of list(s.Resource)) {
        expect(r).not.toBe('*');
        expect(r).toContain(ACCOUNT);
      }
    }
  });

  test('grants nothing the cdk-hnb659fds-* roles already do', () => {
    const actions = policy().Statement.flatMap((s) => list(s.Action));
    for (const service of ['lambda', 'dynamodb', 'events', 'bedrock']) {
      expect(actions.filter((a) => a.startsWith(`${service}:`))).toEqual([]);
    }
  });

  test('build logs are limited to the tenant project', () => {
    const logs = policy().Statement.find((s) => s.Sid === 'BuildLogs')!;
    expect(list(logs.Resource)).toEqual([
      `arn:aws:logs:*:${ACCOUNT}:log-group:/aws/codebuild/${PROJECT}`,
      `arn:aws:logs:*:${ACCOUNT}:log-group:/aws/codebuild/${PROJECT}:*`,
    ]);
  });

  test('can assume the bootstrap roles', () => {
    const assume = policy().Statement.find((s) => s.Sid === 'AssumeCdkBootstrapRoles')!;
    expect(list(assume.Action)).toContain('sts:AssumeRole');
    expect(assume.Resource).toBe(`arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-*-role-${ACCOUNT}-*`);
  });

  test('keeps the bootstrap version parameter statement', () => {
    const ssm = policy().Statement.find((s) => s.Sid === 'BootstrapVersionParameter')!;
    expect(list(ssm.Action)).toEqual(expect.arrayContaining([
      'ssm:PutParameter', 'ssm:GetParameters', 'ssm:DeleteParameter',
      'ssm:AddTagsToResource', 'ssm:RemoveTagsFromResource',
    ]));
    expect(ssm.Resource).toBe(`arn:aws:ssm:*:${ACCOUNT}:parameter/cdk-bootstrap/*`);
  });
});

test('deploy.sh and the console grant the same, except reading the S3 source zip', () => {
  const consoleStatements = deployPolicy(ACCOUNT, PROJECT).Statement.filter((s) => !s.Sid.startsWith('ReadSource'));
  expect(deployShPolicy().Statement).toEqual(consoleStatements);
});
