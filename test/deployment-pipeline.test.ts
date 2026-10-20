// The same tests as umccr/docs-platform's test/deployment-pipeline.test.ts; keep them in step with the construct.
import { App, CfnOutput, CfnWaitConditionHandle, Stack, StackProps } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { Construct } from 'constructs';
import {
  DEPLOYMENT_STAGES,
  DeploymentPipeline,
  DeploymentPipelineProps,
  PROMOTE_TO_PROD,
} from '../infrastructure/toolchain/deployment-pipeline';
import { STAGE_ENVIRONMENTS, TOOLCHAIN_ENVIRONMENT } from '../infrastructure/environments';

interface SampleStackProps extends StackProps {
  readonly greeting: string;
}

class SampleStack extends Stack {
  constructor(scope: Construct, id: string, props: SampleStackProps) {
    super(scope, id, props);
    new CfnWaitConditionHandle(this, 'Placeholder');
    new CfnOutput(this, 'Greeting', { value: props.greeting });
  }
}

type Action = { Name: string; RunOrder?: number; TimeoutInMinutes?: number };
type PipelineProperties = {
  Name: string;
  Stages: Array<{ Name: string; Actions: Action[] }>;
  Triggers?: unknown[];
};

const ENVIRONMENTS = STAGE_ENVIRONMENTS;

const build = (overrides: Partial<DeploymentPipelineProps<SampleStackProps>> = {}) => {
  const app = new App();
  const toolchain = new Stack(app, 'Toolchain', { env: TOOLCHAIN_ENVIRONMENT });
  const deployment = new DeploymentPipeline<SampleStackProps>(toolchain, 'DeploymentPipeline', {
    pipelineName: 'UMCCR-Sample',
    repository: 'umccr/sample',
    includedFilePaths: ['infrastructure/**'],
    excludedFilePaths: ['**/*.md'],
    stack: SampleStack,
    stackId: 'SampleStack',
    stackName: 'UMCCR-SampleStack',
    stackProps: {
      beta: { greeting: 'beta' },
      prod: { greeting: 'prod' },
    },
    environments: ENVIRONMENTS,
    tags: { 'umccr-org:Product': 'Sample' },
    tests: { UnitTest: { commands: ['pnpm test'] } },
    synth: { commands: ['pnpm cdk synth'] },
    ...overrides,
  });
  return { app, toolchain, deployment };
};

const pipelineOf = (template: Template): PipelineProperties =>
  (
    Object.values(template.findResources('AWS::CodePipeline::Pipeline'))[0] as {
      Properties: PipelineProperties;
    }
  ).Properties;

describe('DeploymentPipeline', () => {
  const { app, toolchain, deployment } = build();
  const template = Template.fromStack(toolchain);
  const pipeline = pipelineOf(template);

  test.each(DEPLOYMENT_STAGES)(
    'deploys the stack to %s under one name, with its props and tags',
    (stage) => {
      const stack = deployment.stacks[stage];
      expect(stack.stackName).toBe('UMCCR-SampleStack');
      expect(stack.account).toBe(ENVIRONMENTS[stage].account);
      Template.fromStack(stack).hasOutput('Greeting', { Value: stage });
      expect(stack.tags.tagValues()).toEqual({
        'umccr-org:Product': 'Sample',
        'umccr-org:Creator': 'CDK',
        'umccr-org:Service': 'SampleStack',
        'umccr-org:Source': 'https://github.com/umccr/sample',
      });
    }
  );

  test('deploys beta, then prod, which starts with PromoteToProd', () => {
    expect(pipeline.Name).toBe('UMCCR-Sample');
    expect(pipeline.Stages.map((stage) => stage.Name)).toEqual([
      'Source',
      'Build',
      'UpdatePipeline',
      'Beta',
      'Prod',
    ]);
    const prod = pipeline.Stages.find((stage) => stage.Name === 'Prod')!.Actions;
    const approval = prod.find((action) => action.Name === PROMOTE_TO_PROD)!;
    expect(approval.TimeoutInMinutes).toBe(60);
    for (const action of prod.filter((candidate) => candidate !== approval)) {
      expect(action.RunOrder!).toBeGreaterThan(approval.RunOrder!);
    }
    const beta = pipeline.Stages.find((stage) => stage.Name === 'Beta')!.Actions;
    expect(beta.map((action) => action.Name)).not.toContain(PROMOTE_TO_PROD);
  });

  test('runs the tests before synth', () => {
    const build = pipeline.Stages.find((stage) => stage.Name === 'Build')!.Actions;
    const runOrder = (name: string) => build.find((action) => action.Name === name)!.RunOrder!;
    expect(runOrder('UnitTest')).toBeLessThan(runOrder('Synth'));
  });

  test('starts on pushes to the branch that match the file filters', () => {
    expect(pipeline.Triggers).toEqual([
      {
        ProviderType: 'CodeStarSourceConnection',
        GitConfiguration: {
          SourceActionName: pipeline.Stages[0].Actions[0].Name,
          Push: [
            {
              Branches: { Includes: ['main'] },
              FilePaths: { Includes: ['infrastructure/**'], Excludes: ['**/*.md'] },
            },
          ],
        },
      },
    ]);
  });

  test('names its Slack notification rule after the pipeline', () => {
    template.hasResourceProperties('AWS::CodeStarNotifications::NotificationRule', {
      Name: 'UMCCR-Sample',
    });
  });

  test('encrypts artifacts with its own rotated key, and keeps nothing after a failed first create', () => {
    template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    const policies = Object.values(template.toJSON().Resources as Record<string, object>).map(
      (resource) => (resource as { DeletionPolicy?: string }).DeletionPolicy
    );
    expect(policies).not.toContain('Retain');
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'RetainExceptOnCreate' });
  });

  test('names nothing after OrcaBus', () => {
    const assembly = app.synth();
    const templates = assembly.stacksRecursively.map((stack) => JSON.stringify(stack.template));
    expect(templates.length).toBe(3);
    for (const text of templates) {
      expect(text.toLowerCase()).not.toContain('orcabus');
    }
  });
});

describe('DeploymentPipeline options', () => {
  // CloudFormation would accept the template, and CodePipeline refuse it while creating the pipeline.
  test('refuses trigger lists CodePipeline would reject, as it is built', () => {
    expect(() =>
      build({ excludedFilePaths: Array.from({ length: 9 }, (_, index) => `p${index}/**`) })
    ).toThrow(/maximum length of filePathsExcludes .* is 8, got 9/);
  });

  test.each([
    ['no file filters', undefined],
    ['empty file filters', []],
  ])('starts on every push to the branch with %s', (_label, paths) => {
    const { toolchain } = build({ includedFilePaths: paths, excludedFilePaths: paths });
    expect(pipelineOf(Template.fromStack(toolchain)).Triggers).toBeUndefined();
  });

  test('builds another branch, and links the source tag to it', () => {
    const { deployment } = build({ branch: 'release' });
    expect(deployment.stacks.beta.tags.tagValues()['umccr-org:Source']).toBe(
      'https://github.com/umccr/sample/tree/release'
    );
  });
});
