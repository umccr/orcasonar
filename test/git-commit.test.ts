import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { addGitCommitIdOutput, resolveGitCommitId } from '../infrastructure/shared/git-commit';

const SOURCE_VERSION = 'CODEBUILD_RESOLVED_SOURCE_VERSION';
/** A full SHA, as CodeBuild gives it. */
const COMMIT = `abc1234${'0'.repeat(33)}`;
/** HEAD of this checkout, or `unknown` where there is none, as in a pipeline's source artifact. */
const LOCAL = /^([0-9a-f]{7}(-dirty)?|unknown)$/;

describe('the deployed commit', () => {
  const saved = process.env[SOURCE_VERSION];
  afterEach(() => {
    if (saved === undefined) {
      delete process.env[SOURCE_VERSION];
    } else {
      process.env[SOURCE_VERSION] = saved;
    }
  });

  test("is CodeBuild's source version, shortened, in the pipelines", () => {
    process.env[SOURCE_VERSION] = COMMIT;
    expect(resolveGitCommitId()).toBe('abc1234');
  });

  test("is the checkout's HEAD for a local synth, marked when it has changes", () => {
    delete process.env[SOURCE_VERSION];
    expect(resolveGitCommitId()).toMatch(LOCAL);
  });

  test('falls back to the checkout when the source version is not a commit', () => {
    process.env[SOURCE_VERSION] = 'refs/heads/main';
    expect(resolveGitCommitId()).toMatch(LOCAL);
  });

  // Stacks deployed with @orcabus/platform-cdk-constructs have this output; the same key updates it in place.
  test('is the stack output GitCommitId', () => {
    process.env[SOURCE_VERSION] = COMMIT;
    const stack = new Stack(new App(), 'Commit');
    addGitCommitIdOutput(stack);
    Template.fromStack(stack).hasOutput('GitCommitId', {
      Value: 'abc1234',
      Description: 'The git commit id of the deployed code',
    });
  });
});
