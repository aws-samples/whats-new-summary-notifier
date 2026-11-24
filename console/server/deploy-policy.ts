// Inline policy for the CodeBuild role that the Console creates for each tenant.
// buildspec.yml runs `cdk bootstrap` and `cdk deploy`; the destroy build runs
// `cdk destroy`. In CDK v2, deploy and destroy act through the cdk-hnb659fds-*
// roles that bootstrap creates, so this role only needs to:
//   - write its own build logs and read the source zip,
//   - assume the bootstrap roles,
//   - create or update the CDKToolkit stack, whose resources CloudFormation
//     creates with this role's own permissions (no service role).
// Resource names follow the default bootstrap template (qualifier hnb659fds).
// The policy is not scoped to one Region: a tenant's role is reused in every
// Region the tenant is deployed to.
// shortcut: the ARNs assume the aws partition and the default qualifier; derive
// them from the caller ARN and cdk.json if the Console needs aws-cn, aws-us-gov
// or a custom qualifier.
// Keep in sync with DEPLOY_POLICY in deploy.sh, which has no source bucket statement.

export const CDK_QUALIFIER = 'hnb659fds';

export function deployPolicy(accountId: string, projectName: string) {
  const q = CDK_QUALIFIER;
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'BuildLogs',
        Effect: 'Allow',
        Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        Resource: [
          `arn:aws:logs:*:${accountId}:log-group:/aws/codebuild/${projectName}`,
          `arn:aws:logs:*:${accountId}:log-group:/aws/codebuild/${projectName}:*`,
        ],
      },
      {
        Sid: 'ReadSourceZip',
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:GetObjectVersion'],
        Resource: `arn:aws:s3:::wnsn-deploy-${accountId}-*-an/source/*`,
      },
      {
        Sid: 'ReadSourceBucket',
        Effect: 'Allow',
        Action: ['s3:GetBucketAcl', 's3:GetBucketLocation'],
        Resource: `arn:aws:s3:::wnsn-deploy-${accountId}-*-an`,
      },
      {
        Sid: 'AssumeCdkBootstrapRoles',
        Effect: 'Allow',
        Action: ['sts:AssumeRole', 'sts:TagSession'],
        Resource: `arn:aws:iam::${accountId}:role/cdk-${q}-*-role-${accountId}-*`,
      },
      {
        Sid: 'BootstrapStack',
        Effect: 'Allow',
        Action: 'cloudformation:*',
        Resource: `arn:aws:cloudformation:*:${accountId}:stack/CDKToolkit/*`,
      },
      {
        Sid: 'BootstrapBucket',
        Effect: 'Allow',
        Action: 's3:*',
        Resource: `arn:aws:s3:::cdk-${q}-assets-${accountId}-*`,
      },
      {
        Sid: 'BootstrapRepository',
        Effect: 'Allow',
        Action: 'ecr:*',
        Resource: `arn:aws:ecr:*:${accountId}:repository/cdk-${q}-container-assets-${accountId}-*`,
      },
      {
        Sid: 'BootstrapRoles',
        Effect: 'Allow',
        Action: 'iam:*',
        Resource: `arn:aws:iam::${accountId}:role/cdk-${q}-*`,
      },
      {
        // CloudFormation manages the CDKToolkit version parameter with the caller's permissions
        Sid: 'BootstrapVersionParameter',
        Effect: 'Allow',
        Action: [
          'ssm:PutParameter', 'ssm:GetParameter', 'ssm:GetParameters', 'ssm:DeleteParameter',
          'ssm:AddTagsToResource', 'ssm:RemoveTagsFromResource',
        ],
        Resource: `arn:aws:ssm:*:${accountId}:parameter/cdk-bootstrap/*`,
      },
    ],
  };
}
