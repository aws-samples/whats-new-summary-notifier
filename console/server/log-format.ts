// Read the `lambdaLogFormat` setting a stack was deployed with back from its CloudFormation
// template, so an update from the Console sends the same setting and does not fall back to text.
type Resource = { Type?: string; Properties?: { LoggingConfig?: { LogFormat?: unknown } } };

export function lambdaLogFormatFromTemplate(templateBody: string | undefined): 'JSON' | undefined {
  let resources: Record<string, Resource> = {};
  try {
    resources = JSON.parse(templateBody ?? '{}').Resources ?? {};
  } catch {
    return undefined;
  }
  // The stack gives both functions the same format; Text is also the default, so only JSON is kept
  const json = Object.values(resources).some(
    (r) => r.Type === 'AWS::Lambda::Function' && r.Properties?.LoggingConfig?.LogFormat === 'JSON'
  );
  return json ? 'JSON' : undefined;
}
