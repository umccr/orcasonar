import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import type { IConstruct } from 'constructs';

/**
 * cdk-nag v3 helpers.
 *
 * v3 replaced the v2 `Aspects`/`NagSuppressions` model with CDK's native policy
 * validation framework:
 *
 * - Packs register via `Validations.of(scope).addPlugins(new AwsSolutionsChecks(scope))`.
 * - Findings are acknowledged with `Validations.of(construct).acknowledge({ id, reason })`
 *   rather than `NagSuppressions.add*`.
 * - Unacknowledged findings interrupt `App.synth()` with a validation report, so
 *   "no findings" is asserted by a synth that does not throw.
 *
 * Two quirks drive the helper below:
 *
 * 1. Acknowledgements are matched by the *exact* rule ID. Finding-level rules such
 *    as `AwsSolutions-IAM5` surface as `AwsSolutions-IAM5[Resource::...]`, so a bare
 *    `AwsSolutions-IAM5` acknowledgement does not match them.
 * 2. Acknowledging a rule at stack scope only covers findings on that exact node;
 *    it does not cascade to child resources (unlike v2 `addStackSuppressions` with
 *    `applyToChildren`).
 *
 * To keep tests resilient to CDK-generated logical IDs while still failing on any
 * unexpected rule, {@link acknowledgeFindings} discovers the concrete finding IDs
 * for an allowlist of accepted rules and acknowledges them on each violating
 * resource. Any finding whose rule is not in the allowlist is left in place and
 * will fail synthesis.
 */

/**
 * Register the AwsSolutions pack on a scope (stack) as a validation plugin.
 */
export function addAwsSolutionsChecks(scope: IConstruct): void {
  Validations.of(scope).addPlugins(new AwsSolutionsChecks(scope));
}

/**
 * Acknowledge every finding whose rule (ignoring any `[finding]` suffix) is in
 * `allowedRuleIds`, on the resource that produced it.
 *
 * @param scope the stack (or other construct) to scan
 * @param allowedRuleIds accepted rule IDs, e.g. `['AwsSolutions-IAM5', 'AwsSolutions-S1']`
 * @param reason acknowledgement reason recorded in metadata
 */
export function acknowledgeFindings(
  scope: IConstruct,
  allowedRuleIds: string[],
  reason: string
): void {
  const report = new AwsSolutionsChecks().validateScope(scope);
  const rulesByPath = new Map<string, Set<string>>();

  for (const violation of report.violations) {
    const baseRuleId = violation.ruleName.replace(/\[.*\]$/, '');
    if (!allowedRuleIds.includes(baseRuleId)) {
      continue; // leave unexpected rules unacknowledged so synth fails
    }
    for (const resource of violation.violatingResources) {
      const path = resource.constructPath;
      if (!path) {
        continue;
      }
      let ruleIds = rulesByPath.get(path);
      if (!ruleIds) {
        ruleIds = new Set<string>();
        rulesByPath.set(path, ruleIds);
      }
      ruleIds.add(violation.ruleName);
    }
  }

  const allConstructs = scope.node.findAll();
  for (const [path, ruleIds] of rulesByPath) {
    const node = allConstructs.find((construct) => construct.node.path === path);
    if (!node) {
      continue;
    }
    Validations.of(node).acknowledge(...[...ruleIds].map((id) => ({ id, reason })));
  }
}

/**
 * Assert that synthesizing the app produces no unacknowledged cdk-nag findings.
 * Throws (failing the test) if any finding remains.
 */
export function expectNoUnacknowledgedFindings(app: App): void {
  app.synth();
}
