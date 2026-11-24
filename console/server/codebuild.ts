// CodeBuild project settings shared by the Console deploy, update and destroy paths.
// Kept free of SDK imports so the root Jest suite can test it without console/node_modules.

export const CODEBUILD_IMAGE = 'aws/codebuild/amazonlinux-x86_64-standard:6.0';

export const CODEBUILD_ENVIRONMENT = {
  type: 'LINUX_CONTAINER' as const,
  image: CODEBUILD_IMAGE,
  computeType: 'BUILD_GENERAL1_MEDIUM' as const,
  privilegedMode: true,
};

export interface ProjectApi {
  createProject(input: {
    name: string;
    source: { type: 'S3'; location: string };
    artifacts: { type: 'NO_ARTIFACTS' };
    environment: typeof CODEBUILD_ENVIRONMENT;
    serviceRole: string;
    timeoutInMinutes: number;
  }): Promise<unknown>;
  updateProject(input: {
    name: string;
    source: { type: 'S3'; location: string };
    environment: typeof CODEBUILD_ENVIRONMENT;
  }): Promise<unknown>;
}

// Create the project, or update an existing one. The update sets the same
// environment as a new project, as the deploy.sh update already does, so
// existing projects stay on the same image as new ones and a later change to
// CODEBUILD_IMAGE reaches Console-created projects too. The service role is
// left as it is.
export async function ensureCodeBuildProject(api: ProjectApi, name: string, roleArn: string, s3Bucket: string, s3Key: string) {
  const source = { type: 'S3' as const, location: `${s3Bucket}/${s3Key}` };
  try {
    await api.createProject({
      name, source, artifacts: { type: 'NO_ARTIFACTS' }, environment: CODEBUILD_ENVIRONMENT, serviceRole: roleArn, timeoutInMinutes: 30,
    });
  } catch (e: any) {
    if (e.name !== 'ResourceAlreadyExistsException') throw e;
    await api.updateProject({ name, source, environment: CODEBUILD_ENVIRONMENT });
  }
}
