#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { TOOLCHAIN_ENVIRONMENT } from '../infrastructure/environments';
import { StatefulStack } from '../infrastructure/toolchain/stateful-stack';
import { StatelessStack } from '../infrastructure/toolchain/stateless-stack';

const app = new cdk.App();

// One toolchain stack, and so one pipeline, per run: `pnpm cdk-stateful ...` or `pnpm cdk-stateless ...`.
const deployMode = app.node.tryGetContext('deployMode');
if (!deployMode) {
  throw new Error("deployMode is required in context (e.g. '-c deployMode=stateless')");
}

const tags = { 'umccr-org:Product': 'OrcaSonar' };

if (deployMode === 'stateless') {
  new StatelessStack(app, 'OrcaSonarStatelessStack', {
    env: TOOLCHAIN_ENVIRONMENT,
    tags: { ...tags, 'umccr-org:Stack': 'OrcaSonarStatelessStack' },
  });
} else if (deployMode === 'stateful') {
  new StatefulStack(app, 'OrcaSonarStatefulStack', {
    env: TOOLCHAIN_ENVIRONMENT,
    tags: { ...tags, 'umccr-org:Stack': 'OrcaSonarStatefulStack' },
  });
} else {
  throw new Error(`Invalid deployMode '${deployMode}': use stateful or stateless`);
}
