import { execSync } from 'child_process';
import { CfnOutput, Stack } from 'aws-cdk-lib';

/**
 * The commit a deploy was built from, so what runs can be traced to the code: the stack output `GitCommitId` and the
 * `version` that `/health` answers. Adapted from `@orcabus/platform-cdk-constructs` 1.9.11 `utils`; the output keeps
 * its key and logical ID, so stacks deployed with that package update in place.
 */

const SHORT_SHA = /^[0-9a-f]{7}$/i;

/** A command's output, or undefined when it fails, as outside a git checkout. */
const run = (command: string): string | undefined => {
  try {
    return execSync(command, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
};

/**
 * The commit's short SHA: CodeBuild's resolved source version in the pipelines, or HEAD for a local synth, with
 * `-dirty` when the checkout has uncommitted changes. `unknown` when neither can be read.
 */
export const resolveGitCommitId = (): string => {
  const built = process.env['CODEBUILD_RESOLVED_SOURCE_VERSION']?.trim().slice(0, 7);
  if (built && SHORT_SHA.test(built)) {
    return built;
  }
  const head = run('git rev-parse HEAD')?.slice(0, 7);
  if (!head || !SHORT_SHA.test(head)) {
    return 'unknown';
  }
  return run('git status --porcelain') ? `${head}-dirty` : head;
};

/** Adds the commit as the stack output `GitCommitId`. */
export const addGitCommitIdOutput = (stack: Stack): void => {
  new CfnOutput(stack, 'CfnOutputGitCommitId', {
    key: 'GitCommitId',
    value: resolveGitCommitId(),
    description: 'The git commit id of the deployed code',
  });
};
