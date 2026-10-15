import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { Construct } from 'constructs';
import { STAGE_ENVIRONMENTS, TOOLCHAIN_ENVIRONMENT } from '../infrastructure/environments';
import { OrcaSonarStatefulStack } from '../infrastructure/stage/stateful-stack';
import { OrcaSonarStatelessStack } from '../infrastructure/stage/stateless-stack';
import { StatefulStack } from '../infrastructure/toolchain/stateful-stack';
import { StatelessStack } from '../infrastructure/toolchain/stateless-stack';

// The stage stacks have their own tests; mocking them keeps these to the pipelines.
jest.mock('../infrastructure/stage/stateful-stack', () => ({
  OrcaSonarStatefulStack: jest.fn((scope: Construct, id: string) => {
    const stack = new Stack(scope, id);
    new (jest.requireActual('aws-cdk-lib').CfnWaitConditionHandle)(stack, 'Placeholder');
    return stack;
  }),
}));
jest.mock('../infrastructure/stage/stateless-stack', () => ({
  OrcaSonarStatelessStack: jest.fn((scope: Construct, id: string) => {
    const stack = new Stack(scope, id);
    new (jest.requireActual('aws-cdk-lib').CfnWaitConditionHandle)(stack, 'Placeholder');
    return stack;
  }),
}));

type Pipeline = {
  Name: string;
  Stages: Array<{ Name: string; Actions: Array<{ Configuration?: Record<string, unknown> }> }>;
};

const pipelineOf = (stack: Stack, name: string): Pipeline => {
  const pipelines = Object.values(
    Template.fromStack(stack).findResources('AWS::CodePipeline::Pipeline')
  ).map((resource) => (resource as { Properties: Pipeline }).Properties);
  const pipeline = pipelines.find((candidate) => candidate.Name === name);
  expect(pipeline).toBeDefined();
  return pipeline!;
};

describe.each([
  [
    'stateful',
    StatefulStack,
    'UMCCR-OrcaSonarStateful',
    OrcaSonarStatefulStack,
    'UMCCR-OrcaSonarStatefulStack',
  ],
  [
    'stateless',
    StatelessStack,
    'UMCCR-OrcaSonarStateless',
    OrcaSonarStatelessStack,
    'UMCCR-OrcaSonarStatelessStack',
  ],
])('%s pipeline', (_mode, Toolchain, pipelineName, StageStack, stackName) => {
  const app = new App();
  const stack = new Toolchain(app, `Test${pipelineName}`, { env: TOOLCHAIN_ENVIRONMENT });

  test('builds from umccr/orcasonar main', () => {
    const pipeline = pipelineOf(stack, pipelineName);
    expect(pipeline.Stages[0]!.Actions[0]!.Configuration).toMatchObject({
      FullRepositoryId: 'umccr/orcasonar',
      BranchName: 'main',
    });
  });

  test('deploys beta, then gamma, then prod', () => {
    const stages = pipelineOf(stack, pipelineName).Stages.map((stage) => stage.Name);
    expect(stages).toEqual(['Source', 'Build', 'UpdatePipeline', 'Beta', 'Gamma', 'Prod']);
  });

  // OrcaSonar is UMCCR's: the same stack name in every stage account, tagged as OrcaSonar.
  test(`deploys ${stackName} to every stage account, tagged as OrcaSonar`, () => {
    const calls = jest.mocked(StageStack).mock.calls;
    expect(calls.map(([, , props]) => props.env?.account).sort()).toEqual(
      Object.values(STAGE_ENVIRONMENTS)
        .map((environment) => environment.account)
        .sort()
    );
    for (const [, , props] of calls) {
      expect(props.stackName).toBe(stackName);
      expect(props.tags).toMatchObject({
        'umccr-org:Product': 'OrcaSonar',
        'umccr-org:Source': 'https://github.com/umccr/orcasonar',
      });
    }
  });
});
