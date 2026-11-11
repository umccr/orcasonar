---
inclusion: fileMatch
fileMatchPattern: ['infrastructure/**', 'bin/**', 'test/**', 'cdk.json']
---

# Working in `infrastructure/`, `bin/` and `test/`

The CDK app is CommonJS, run by ts-node, and tested with Jest and cdk-nag. Run `make check && make test`, and
`make cdk-synth` when a stack changes.

## How the stacks fit together

- `bin/deploy.ts` synthesizes one toolchain stack per run, chosen by `-c deployMode=stateful|stateless`
  (`pnpm cdk-stateful …`, `pnpm cdk-stateless …`). Without it the app throws.
- Each toolchain stack is a self-mutating CDK pipeline that builds its stage stack per stage at
  `<toolchain stack>/DeploymentPipeline/<Beta|Prod>/<stack>`.
- In every account the stage stacks are `UMCCR-OrcaSonarStatefulStack` and `UMCCR-OrcaSonarStatelessStack`, tagged
  `umccr-org:Product: OrcaSonar`.
- SSM is the interface between them. The stateful stack writes `/orcasonar/*` (`SSM_PARAMETERS` in `constants.ts`);
  the stateless stack reads them at deploy time and writes `/orcasonar/api-url`. The stateful stack always deploys
  first.
- Per-stage settings live in `infrastructure/stage/config.ts` (`DOCS_ORIGINS`, `ANSWER_MODEL_ID`, `ALLOWED_MODEL_IDS`,
  `MODEL_REGIONS`, `MONTHLY_BUDGET_USD`, `CALLER_DAILY_USD`, `ACCESS_LOGS`, `ALERT_EMAILS`, `AUDIT_GROUP`). Change a
  setting there, not in a stack.
- In prod, data is `RETAIN_ON_UPDATE_OR_DELETE` and the table has deletion protection; in beta it is deleted with the
  stack.

## Patterns to keep

- **Open routes never reach a function.** `/api/v1/health`, `/schema/openapi.json` and `/schema/swagger-ui/` are mock
  integrations built by `staticGet` in `stateless-stack.ts`, with the body base64-encoded in the mapping template.
  Every Lambda integration has the authorizer. The test "reaches a function only through the authorizer" enforces it.
- **API Gateway's own errors** are gateway responses in the API's error shape, with CORS headers.
- **The guardrail is versioned by its policies' hash.** A policy change publishes a new version and writes it to
  `/orcasonar/guardrail-version`. Replaced versions are kept until the runbook's clean-up.
- **The chat role may call only the allowed models**: the `ALLOWED_MODEL_IDS` profiles and the models behind them in
  `MODEL_REGIONS`. The stack refuses an `ANSWER_MODEL_ID` not in that list. The chat role has no Marketplace
  permissions.
- **Nothing is named for OrcaBus** in the pipeline construct; `test/deployment-pipeline.test.ts` checks it.
- **cdk-nag findings** fail synth unless acknowledged. Accepted AwsSolutions rules are in `ACCEPTED_RULES` in
  `test/stage.test.ts`, each with its reason; adding one needs a reason there too. `test/cdk-nag-helpers.ts` explains
  v3 acknowledgements.
- **Tests** build both stage stacks for beta and prod and assert on the templates: only the open routes and CORS
  preflight are unauthenticated, the chat role can call only the `au.` profiles, the WAF body rules only count, and
  every alarm notifies the alerts topic.

## Deliberate, though it can look wrong

Do not "fix" these without checking `docs/tech.md#deliberate-though-it-can-look-wrong` and asking the user.

- The alerts topic's construct ID is `BudgetTopic` (renaming replaces the topic, the budget and its action).
- The two default gateway responses keep their original construct IDs (replacing one resets it).
- The `docs` data source has no `metadataFilesPrefix` (with one, metadata is looked up in the wrong place).
- The data source names `bucketOwnerAccountId` for a bucket in its own account (the connector refuses null).
- Four AWS common rules only count: `GenericLFI_BODY`, `GenericRFI_BODY`, `CrossSiteScripting_BODY`,
  `EC2MetaDataSSRF_BODY` (they blocked legitimate questions in dev, 2026-10-21).
- A REST API, not an HTTP API (HTTP APIs cannot stream and stop at 30 seconds).
- The authorizer allows every route of the stage (its answer is cached per token, not per route).
- The functions run outside a VPC (Bedrock VPC endpoints would nearly double the budget).
- Prod data is `RETAIN_ON_UPDATE_OR_DELETE`, not `RETAIN` (a failed first create would leave orphans blocking retry).
- The budget backstop filters on `Amazon Bedrock`, `ALERT_EMAILS` is empty and `MIN_SCORE` is 0: open items awaiting a
  decision (`docs/project.md#open-items`), not oversights.

## Care when changing

- **Knowledge base or data source**: some property changes replace the knowledge base, which then starts empty.
- **A table index**: one create or delete per update, projections are immutable, and CloudFormation does not wait for
  `ACTIVE`.
- **Account IDs** appear only in `infrastructure/shared/platform.ts`, copied from `@orcabus/platform-cdk-constructs`
  1.9.11 and followed by hand.
