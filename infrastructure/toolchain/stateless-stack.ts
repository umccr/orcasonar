import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { STAGE_ENVIRONMENTS } from '../environments';
import { getOrcaSonarStatelessStackProps } from '../stage/config';
import { OrcaSonarStatelessStack, OrcaSonarStatelessStackProps } from '../stage/stateless-stack';
import { node24PartialBuildSpec } from './build-spec';
import { DeploymentPipeline } from './deployment-pipeline';

/** The stateless pipeline's name in the toolchain account. */
export const STATELESS_PIPELINE_NAME = 'UMCCR-OrcaSonarStateless';

/** The stateless stack's CloudFormation name, the same in every stage: each stage is its own account. */
export const STATELESS_STACK_NAME = 'UMCCR-OrcaSonarStatelessStack';

/** Deploys OrcaSonarStatelessStack: beta, then prod after approval. */
export class StatelessStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new DeploymentPipeline<OrcaSonarStatelessStackProps>(this, 'DeploymentPipeline', {
      pipelineName: STATELESS_PIPELINE_NAME,
      repository: 'umccr/orcasonar',
      excludedFilePaths: [
        'docs/**',
        '**/*.md',
        'infrastructure/stage/stateful-stack.ts',
        'infrastructure/toolchain/stateful-stack.ts',
      ],
      stack: OrcaSonarStatelessStack,
      stackId: 'OrcaSonarStatelessStack',
      stackName: STATELESS_STACK_NAME,
      stackProps: {
        beta: getOrcaSonarStatelessStackProps('BETA'),
        prod: getOrcaSonarStatelessStackProps('PROD'),
      },
      environments: STAGE_ENVIRONMENTS,
      tags: { 'umccr-org:Product': 'OrcaSonar' },
      partialBuildSpec: node24PartialBuildSpec(),
      // The install step installs the whole workspace, app included.
      tests: {
        UnitIacTest: { commands: ['pnpm test'] },
        UnitAppTest: { commands: ['cd app && pnpm check && pnpm test'] },
      },
      synth: { commands: ['pnpm cdk-stateless synth'] },
    });
  }
}
