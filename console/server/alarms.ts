// Read the `alarms` setting a stack was deployed with back from its CloudFormation template,
// so an update from the Console sends the same setting and does not drop the notifications.
export type AlarmSettings = { email?: string; topicArn?: string; noNewEntriesDays?: number };

type Resource = { Type?: string; Properties?: Record<string, unknown> };

export function alarmsFromTemplate(templateBody: string | undefined): AlarmSettings {
  let resources: Record<string, Resource> = {};
  try {
    resources = JSON.parse(templateBody ?? '{}').Resources ?? {};
  } catch {
    return {};
  }
  const all = Object.values(resources);
  const settings: AlarmSettings = {};
  // alarms.email: the stack's own topic with an email subscription
  const email = all.find(
    (r) => r.Type === 'AWS::SNS::Subscription' && r.Properties?.Protocol === 'email' && typeof r.Properties?.Endpoint === 'string'
  );
  if (email) settings.email = email.Properties!.Endpoint as string;
  for (const r of all) {
    if (r.Type !== 'AWS::CloudWatch::Alarm') continue;
    // alarms.topicArn: an alarm whose action is a literal SNS topic ARN
    const action = (r.Properties?.AlarmActions as unknown[] | undefined)?.[0];
    if (!email && typeof action === 'string' && action.startsWith('arn:') && action.includes(':sns:')) settings.topicArn = action;
    // alarms.noNewEntriesDays: the daily alarm on the notify Lambda's invocations
    const p = r.Properties ?? {};
    if (p.MetricName === 'Invocations' && p.ComparisonOperator === 'LessThanThreshold' && typeof p.EvaluationPeriods === 'number') {
      settings.noNewEntriesDays = p.EvaluationPeriods;
    }
  }
  return settings;
}
