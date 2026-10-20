import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { STAGE_ENVIRONMENTS } from '../environments';
import { getOrcaSonarStatefulStackProps } from '../stage/config';
import { OrcaSonarStatefulStack, OrcaSonarStatefulStackProps } from '../stage/stateful-stack';
import { node24PartialBuildSpec } from './build-spec';
import { DeploymentPipeline } from './deployment-pipeline';

/** The stateful pipeline's name in the toolchain account. */
export const STATEFUL_PIPELINE_NAME = 'UMCCR-OrcaSonarStateful';

/** The stateful stack's CloudFormation name, the same in every stage: each stage is its own account. */
export const STATEFUL_STACK_NAME = 'UMCCR-OrcaSonarStatefulStack';

/** Deploys OrcaSonarStatefulStack: beta, then prod after approval. */
export class StatefulStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new DeploymentPipeline<OrcaSonarStatefulStackProps>(this, 'DeploymentPipeline', {
      pipelineName: STATEFUL_PIPELINE_NAME,
      repository: 'umccr/orcasonar',
      excludedFilePaths: [
        'app/**',
        'docs/**',
        '**/*.md',
        'infrastructure/stage/stateless-stack.ts',
        'infrastructure/toolchain/stateless-stack.ts',
      ],
      stack: OrcaSonarStatefulStack,
      stackId: 'OrcaSonarStatefulStack',
      stackName: STATEFUL_STACK_NAME,
      stackProps: {
        beta: getOrcaSonarStatefulStackProps('BETA'),
        prod: getOrcaSonarStatefulStackProps('PROD'),
      },
      environments: STAGE_ENVIRONMENTS,
      tags: { 'umccr-org:Product': 'OrcaSonar' },
      partialBuildSpec: node24PartialBuildSpec(),
      // No app tests: the stateful stack deploys no code.
      tests: { UnitIacTest: { commands: ['pnpm test'] } },
      synth: { commands: ['pnpm cdk-stateful synth'] },
    });
  }
}
