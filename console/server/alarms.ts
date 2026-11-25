// Read the `alarms` setting a stack was deployed with back from its CloudFormation template,
// so an update from the Console sends the same setting and does not drop the notifications.
export type AlarmSettings = { email?: string; topicArn?: string };

type Resource = { Type?: string; Properties?: Record<string, unknown> };

export function alarmsFromTemplate(templateBody: string | undefined): AlarmSettings {
  let resources: Record<string, Resource> = {};
  try {
    resources = JSON.parse(templateBody ?? '{}').Resources ?? {};
  } catch {
    return {};
  }
  const all = Object.values(resources);
  // alarms.email: the stack's own topic with an email subscription
  const email = all.find(
    (r) => r.Type === 'AWS::SNS::Subscription' && r.Properties?.Protocol === 'email' && typeof r.Properties?.Endpoint === 'string'
  );
  if (email) return { email: email.Properties!.Endpoint as string };
  // alarms.topicArn: an alarm whose action is a literal SNS topic ARN
  for (const r of all) {
    if (r.Type !== 'AWS::CloudWatch::Alarm') continue;
    const action = (r.Properties?.AlarmActions as unknown[] | undefined)?.[0];
    if (typeof action === 'string' && action.startsWith('arn:') && action.includes(':sns:')) return { topicArn: action };
  }
  return {};
}
