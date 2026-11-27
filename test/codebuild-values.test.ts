import { readFileSync } from 'fs';
import * as path from 'path';
import { CODEBUILD_IMAGE } from '../console/server/codebuild';

const read = (file: string) => readFileSync(path.join(__dirname, '..', file), 'utf8');

// Values that must change together when the CodeBuild image is raised
describe('CodeBuild values shared by deploy.sh and the Console', () => {
  test('deploy.sh uses the same CodeBuild image as the Console', () => {
    const m = read('deploy.sh').match(/^CODEBUILD_IMAGE="([^"]+)"$/m);
    expect(m?.[1]).toBe(CODEBUILD_IMAGE);
  });

  test('buildspec.yml and both destroy buildspecs use the same Node.js version', () => {
    const versions = ['buildspec.yml', 'deploy.sh', 'console/server/index.ts'].map((f) => {
      const all = [...read(f).matchAll(/nodejs: (\d+)/g)].map((m) => m[1]);
      expect(all).toHaveLength(1);
      return all[0];
    });
    expect(new Set(versions).size).toBe(1);
  });
});
