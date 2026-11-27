import { CODEBUILD_IMAGE, ensureCodeBuildProject } from '../console/server/codebuild';

const ROLE_ARN = 'arn:aws:iam::123456789012:role/whats-new-summary-notifier-role';

describe('Console ensureCodeBuildProject', () => {
  test('creates a new project with the current image', async () => {
    const api = { createProject: jest.fn().mockResolvedValue({}), updateProject: jest.fn() };

    await ensureCodeBuildProject(api, 'proj', ROLE_ARN, 'bucket', 'source/1.zip');

    expect(api.createProject).toHaveBeenCalledWith(expect.objectContaining({
      name: 'proj',
      environment: expect.objectContaining({ image: CODEBUILD_IMAGE }),
      serviceRole: ROLE_ARN,
    }));
    expect(api.updateProject).not.toHaveBeenCalled();
  });

  test('updates an existing project to the same image and environment as a new one', async () => {
    const exists = Object.assign(new Error('exists'), { name: 'ResourceAlreadyExistsException' });
    const api = { createProject: jest.fn().mockRejectedValue(exists), updateProject: jest.fn().mockResolvedValue({}) };

    await ensureCodeBuildProject(api, 'proj', ROLE_ARN, 'bucket', 'source/2.zip');

    const created = api.createProject.mock.calls[0][0];
    expect(api.updateProject).toHaveBeenCalledWith({
      name: 'proj',
      source: { type: 'S3', location: 'bucket/source/2.zip' },
      environment: created.environment,
    });
    expect(api.updateProject.mock.calls[0][0].environment.image).toBe(CODEBUILD_IMAGE);
  });

  test('rethrows other errors without updating', async () => {
    const api = { createProject: jest.fn().mockRejectedValue(new Error('AccessDenied')), updateProject: jest.fn() };

    await expect(ensureCodeBuildProject(api, 'proj', ROLE_ARN, 'bucket', 'k')).rejects.toThrow('AccessDenied');
    expect(api.updateProject).not.toHaveBeenCalled();
  });
});
