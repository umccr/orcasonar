/*
 * A self-mutating CDK pipeline in the toolchain account that deploys one stack to the beta, gamma and prod accounts,
 * prod after a manual approval.
 *
 * Adapted from `DeploymentStackPipeline` in OrcaBus's platform-cdk-constructs
 * (https://github.com/OrcaBus/platform-cdk-constructs, packages/deployment-stack-pipeline/pipeline.ts), which fixes
 * OrcaBus names: the stage IDs `OrcaBusBeta`, `OrcaBusGamma` and `OrcaBusProd`, the stack names derived from them, the
 * `umccr-org:Product` tag and the notification rule's prefix. Here the caller names each of them. Other changes: the
 * pipeline has its own artifact bucket and key instead of the OrcaBus shared one, the trigger uses CDK's trigger API,
 * which checks CodePipeline's limits as the pipeline is built, and the drift check, cache and asset-stripping options
 * are left out.
 *
 * umccr/docs-platform and umccr/orcasonar hold the same copy of this file; keep them in step.
 *
 * The original is distributed under this licence:
 *
 * MIT License
 *
 * Copyright (c) 2025 OrcaBus
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { Duration, Environment, RemovalPolicy, Stack, StackProps, Stage } from 'aws-cdk-lib';
import { SlackChannelConfiguration } from 'aws-cdk-lib/aws-chatbot';
import { BuildSpec, ComputeType, IBuildImage, LinuxArmBuildImage } from 'aws-cdk-lib/aws-codebuild';
import {
  IStage,
  Pipeline,
  PipelineNotificationEvents,
  PipelineType,
  ProviderType,
} from 'aws-cdk-lib/aws-codepipeline';
import { ManualApprovalAction } from 'aws-cdk-lib/aws-codepipeline-actions';
import { DetailType } from 'aws-cdk-lib/aws-codestarnotifications';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import {
  CodeBuildStep,
  CodePipeline,
  CodePipelineActionFactoryResult,
  CodePipelineSource,
  ICodePipelineActionFactory,
  ProduceActionOptions,
  Step,
} from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';

/** The stages a pipeline deploys to, in order. Prod waits for an approval after gamma. */
export const DEPLOYMENT_STAGES = ['beta', 'gamma', 'prod'] as const;
export type DeploymentStage = (typeof DEPLOYMENT_STAGES)[number];

/** Each stage's ID: the name of its stage in the pipeline, and its part of the stack's construct path. */
export const DEPLOYMENT_STAGE_IDS: Record<DeploymentStage, string> = {
  beta: 'Beta',
  gamma: 'Gamma',
  prod: 'Prod',
};

/** The approval between gamma and prod. */
export const PROMOTE_TO_PROD = 'PromoteToProd';

/**
 * CodePipeline accepts at most this many patterns in each include or exclude list of a trigger filter. CDK's trigger
 * API refuses a longer list when the pipeline is built, rather than when CloudFormation creates it.
 */
export const MAX_TRIGGER_FILE_PATHS = 8;

/** The CodeConnections connection to GitHub, an SSM parameter in the toolchain account. */
const GITHUB_CONNECTION_PARAMETER = 'codestar_github_arn';

/** The alerts Slack channel's AWS Chatbot configuration, an SSM parameter in the toolchain account. */
const SLACK_CHANNEL_PARAMETER = '/chatbot_arn/slack/alerts-build';

/** The partial buildspec of every CodeBuild step that names none: Node.js 22. */
export const DEFAULT_PARTIAL_BUILD_SPEC: Record<string, unknown> = {
  version: '0.2',
  phases: { install: { 'runtime-versions': { nodejs: '22.x' } } },
};

/** The install commands of a step that names none. */
export const DEFAULT_INSTALL_COMMANDS = [
  'npm install --global corepack@latest',
  'corepack enable',
  'node -v',
  'corepack --version',
  'pnpm install --frozen-lockfile --ignore-scripts',
];

export interface BuildStepProps {
  /** The step's commands, run from the repository root. */
  readonly commands: string[];
  /** @default DEFAULT_INSTALL_COMMANDS */
  readonly installCommands?: string[];
  /** @default the pipeline's `partialBuildSpec` */
  readonly partialBuildSpec?: Record<string, unknown>;
  /** Permissions the step's role needs beyond reading the source. */
  readonly rolePolicyStatements?: PolicyStatement[];
}

export interface SynthStepProps extends BuildStepProps {
  /** Where `cdk synth` writes the cloud assembly. @default 'cdk.out' */
  readonly primaryOutputDirectory?: string;
}

/** A stack class whose constructor takes its props third, as CDK stacks do. */
export type StackClass<P extends StackProps> = new (
  scope: Construct,
  id: string,
  props: P
) => Stack;

/** The stack props the pipeline sets itself, the same way in every stage. */
export type PipelineStackProps = 'env' | 'stackName' | 'tags';

export interface DeploymentPipelineProps<P extends StackProps> {
  /** The CodePipeline's name in the toolchain account. Its Slack notification rule has the same name. */
  readonly pipelineName: string;
  /** The GitHub repository, `owner/name`, cloned through the `codestar_github_arn` connection. */
  readonly repository: string;
  /** The branch the pipeline builds. @default 'main' */
  readonly branch?: string;
  /** Changed files that start the pipeline, as glob patterns; at most 8. @default every change */
  readonly includedFilePaths?: string[];
  /** Changed files that do not, even where an include matches; at most 8. An exclude wins over an include. */
  readonly excludedFilePaths?: string[];
  /** The stack each stage deploys. */
  readonly stack: StackClass<P>;
  /** The stack's construct ID in each stage, such as `DocsHostingStack`; also its `umccr-org:Service` tag. */
  readonly stackId: string;
  /** The stack's CloudFormation name, the same in every stage: each stage is its own account. */
  readonly stackName: string;
  /** Each stage's stack props, apart from `env`, `stackName` and `tags`, which the pipeline sets. */
  readonly stackProps: Record<DeploymentStage, Omit<P, PipelineStackProps>>;
  /** Each stage's account and region. */
  readonly environments: Record<DeploymentStage, Environment>;
  /**
   * The stack's tags in every stage, such as `umccr-org:Product`. The pipeline adds `umccr-org:Creator`,
   * `umccr-org:Service` and `umccr-org:Source`; a tag given here wins.
   */
  readonly tags: Record<string, string>;
  /** Steps that must pass before synth, such as unit tests, by step name. They run in parallel. */
  readonly tests: Record<string, BuildStepProps>;
  /** The synth step, which installs the app and runs `cdk synth`. */
  readonly synth: SynthStepProps;
  /** The partial buildspec of every step that names none. @default DEFAULT_PARTIAL_BUILD_SPEC */
  readonly partialBuildSpec?: Record<string, unknown>;
  /** @default LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0 */
  readonly buildImage?: IBuildImage;
  /**
   * How long the approval before prod waits. It then fails, so the run ends and does not hold back newer ones.
   * @default 60 minutes
   */
  readonly approvalTimeout?: Duration;
  /** Post to the alerts Slack channel. @default true */
  readonly slackNotification?: boolean;
  /** The events posted to Slack. @default failed runs */
  readonly notificationEvents?: PipelineNotificationEvents[];
}

/**
 * A self-mutating pipeline that deploys {@link DeploymentPipelineProps.stack} to beta, then gamma, then, after the
 * `PromoteToProd` approval, prod. Tests run in parallel before synth; failed runs post to the alerts Slack channel.
 *
 * Needs, in the toolchain account, the SSM parameters `codestar_github_arn` and `/chatbot_arn/slack/alerts-build`;
 * and in each stage account, a CDK bootstrap that trusts the toolchain account.
 */
export class DeploymentPipeline<P extends StackProps> extends Construct {
  /** The CodePipeline. */
  readonly pipeline: Pipeline;
  /** The stack each stage deploys. */
  readonly stacks: Record<DeploymentStage, Stack>;

  constructor(scope: Construct, id: string, props: DeploymentPipelineProps<P>) {
    super(scope, id);
    const branch = props.branch ?? 'main';
    // An empty list means no filter: CodePipeline wants at least one pattern in a list it is given.
    const includedFilePaths = props.includedFilePaths?.length ? props.includedFilePaths : undefined;
    const excludedFilePaths = props.excludedFilePaths?.length ? props.excludedFilePaths : undefined;

    const source = CodePipelineSource.connection(props.repository, branch, {
      connectionArn: StringParameter.valueForStringParameter(this, GITHUB_CONNECTION_PARAMETER),
      triggerOnPush: true,
    });

    this.pipeline = new Pipeline(this, 'Pipeline', {
      pipelineName: props.pipelineName,
      pipelineType: PipelineType.V2,
      // The stage accounts' deploy roles read the artifacts, so they are encrypted with the pipeline's own key.
      crossAccountKeys: true,
      enableKeyRotation: true,
      // Otherwise the self-update cancels the run it is part of:
      // https://stackoverflow.com/questions/75701776/updatepipeline-stage-in-cdk-pipeline-is-cancelled
      restartExecutionOnUpdate: true,
    });
    // CDK retains the artifact bucket it creates, even when the stack's first create rolls back.
    this.pipeline.artifactBucket.applyRemovalPolicy(RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE);

    const buildStep = (stepId: string, step: SynthStepProps): CodeBuildStep =>
      new CodeBuildStep(stepId, {
        input: source,
        installCommands: step.installCommands ?? DEFAULT_INSTALL_COMMANDS,
        commands: step.commands,
        primaryOutputDirectory: step.primaryOutputDirectory,
        // A copy: CodeBuild steps may add to their buildspec.
        partialBuildSpec: BuildSpec.fromObject(
          JSON.parse(
            JSON.stringify(
              step.partialBuildSpec ?? props.partialBuildSpec ?? DEFAULT_PARTIAL_BUILD_SPEC
            )
          ) as Record<string, unknown>
        ),
        rolePolicyStatements: step.rolePolicyStatements,
      });

    const synth = buildStep('Synth', { primaryOutputDirectory: 'cdk.out', ...props.synth });
    for (const [stepId, test] of Object.entries(props.tests)) {
      synth.addStepDependency(buildStep(stepId, test));
    }

    const cdkPipeline = new CodePipeline(this, 'CdkPipeline', {
      codePipeline: this.pipeline,
      synth,
      selfMutation: true,
      codeBuildDefaults: {
        buildEnvironment: {
          computeType: ComputeType.LARGE,
          buildImage: props.buildImage ?? LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
          environmentVariables: { NODE_OPTIONS: { value: '--max-old-space-size=8192' } },
        },
      },
    });

    const tags = {
      'umccr-org:Creator': 'CDK',
      'umccr-org:Service': props.stackId,
      'umccr-org:Source':
        branch === 'main'
          ? `https://github.com/${props.repository}`
          : `https://github.com/${props.repository}/tree/${branch}`,
      ...props.tags,
    };
    const stacks: Partial<Record<DeploymentStage, Stack>> = {};
    for (const stageName of DEPLOYMENT_STAGES) {
      const env = props.environments[stageName];
      const stage = new Stage(this, DEPLOYMENT_STAGE_IDS[stageName], { env });
      // The stage's props first, so the pipeline's environment, name and tags always apply.
      stacks[stageName] = new props.stack(stage, props.stackId, {
        ...props.stackProps[stageName],
        env,
        stackName: props.stackName,
        tags,
      } as unknown as P);
      cdkPipeline.addStage(
        stage,
        stageName === 'gamma'
          ? {
              post: [
                new ApprovalStep(PROMOTE_TO_PROD, props.approvalTimeout ?? Duration.minutes(60)),
              ],
            }
          : undefined
      );
    }
    this.stacks = stacks as Record<DeploymentStage, Stack>;

    cdkPipeline.buildPipeline();

    if (includedFilePaths || excludedFilePaths) {
      this.pipeline.addTrigger({
        providerType: ProviderType.CODE_STAR_SOURCE_CONNECTION,
        gitConfiguration: {
          sourceAction: this.pipeline.stages[0].actions[0],
          pushFilter: [
            {
              branchesIncludes: [branch],
              filePathsIncludes: includedFilePaths,
              filePathsExcludes: excludedFilePaths,
            },
          ],
        },
      });
    }

    if (props.slackNotification ?? true) {
      const slack = SlackChannelConfiguration.fromSlackChannelConfigurationArn(
        this,
        'SlackChannel',
        StringParameter.valueForStringParameter(this, SLACK_CHANNEL_PARAMETER)
      );
      this.pipeline.notifyOn('SlackNotification', slack, {
        events: props.notificationEvents ?? [PipelineNotificationEvents.PIPELINE_EXECUTION_FAILED],
        detailType: DetailType.FULL,
        notificationRuleName: props.pipelineName,
      });
    }
  }
}

/**
 * A manual approval that times out. CDK Pipelines' own `ManualApprovalStep` cannot set a timeout, so this produces the
 * action itself, at the run order CDK Pipelines gives it.
 */
class ApprovalStep extends Step implements ICodePipelineActionFactory {
  constructor(
    id: string,
    private readonly timeout: Duration
  ) {
    super(id);
  }

  produceAction(stage: IStage, options: ProduceActionOptions): CodePipelineActionFactoryResult {
    stage.addAction(
      new ManualApprovalAction({
        actionName: options.actionName,
        runOrder: options.runOrder,
        timeout: this.timeout,
      })
    );
    return { runOrdersConsumed: 1 };
  }
}
