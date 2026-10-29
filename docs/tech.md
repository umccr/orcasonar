# Tech stack and conventions

How OrcaSonar is built, how the code is laid out, and the conventions for changing it, for anyone working in this
repository, a person or a coding agent. What the project is for and where it stands is in [project.md](project.md);
what is deployed, component by component, is in [architecture.md](architecture.md).

## The stack

| Part                  | What                                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language              | TypeScript `~5.9.3`, strict, in both packages                                                                                                                                                                        |
| Runtime               | Node.js 24 (`engines: >=24`): Lambda's `nodejs24.x` on arm64, CodeBuild and GitHub Actions                                                                                                                           |
| Package manager       | pnpm `10.34.5` through Corepack, in one workspace: the CDK app at the root, and `app/` as the package `orcasonar-app`                                                                                                |
| Infrastructure        | AWS CDK: `aws-cdk-lib` `^2.269.0`, the `aws-cdk` CLI `^2.1141.0` and `constructs` `^10.8.0`                                                                                                                          |
| Shared constructs     | `@orcabus/platform-cdk-constructs` `^1.9.8`: UMCCR's accounts, the SSM names of shared resources, the commit-ID stack output                                                                                         |
| Infrastructure checks | `cdk-nag` `^3.0.2`: the AwsSolutions pack, as a CDK validation plugin in the tests                                                                                                                                   |
| API                   | Hono `^4.12.27`, run in Lambda by `@hono/aws-lambda` and locally by `@hono/node-server`                                                                                                                              |
| Validation            | zod `^4.4.3`: request bodies and the functions' environment                                                                                                                                                          |
| Tokens                | `aws-jwt-verify` `^5.2.1`: Cognito ID tokens, in the authorizer                                                                                                                                                      |
| AWS SDK               | v3, `^3.1141.0`: `client-bedrock-runtime` (`ConverseStream`), `client-bedrock-agent-runtime` (`Retrieve`), `client-bedrock-agent` (ingestion jobs), `client-dynamodb` with `lib-dynamodb`, `client-s3`, `client-ssm` |
| Tests                 | Jest `^30.5.1` with ts-jest for the infrastructure; Vitest `^4.0.0` with `aws-sdk-client-mock` for the app                                                                                                           |
| Lint and format       | ESLint `^9.39.5` with typescript-eslint, and Prettier `^3.9.6`                                                                                                                                                       |
| Bundling              | esbuild `^0.28.2`, through CDK's `NodejsFunction`                                                                                                                                                                    |
| Local server          | tsx `^4.20.6`, in watch mode                                                                                                                                                                                         |

The versions are the ranges in `package.json`. `pnpm-lock.yaml` pins what is installed, and the functions bundle
exactly that, the AWS SDK included. Everything runs in ap-southeast-2; the `au.` inference profiles also send model
calls to ap-southeast-4.

## Layout

```text
orcasonar/
├── app/                          # the API and the functions: ES modules, bundled into the Lambdas
│   ├── schema/openapi.yaml       # the API contract, served at /schema/openapi.json
│   └── src/
│       ├── app.ts                # the Hono app: routes, request validation, errors, CORS and the stream
│       ├── server.ts             # make dev: the app on 127.0.0.1:8787, with in-memory stores
│       ├── handlers/             # Lambda entry points: chat, query, authorizer, ingest-mark, ingest-run
│       ├── services/             # the logic, behind interfaces, with no AWS imports
│       ├── aws/                  # the interfaces' AWS implementations; deps.ts wires them from the environment
│       ├── config/env.ts         # the functions' environment, parsed with zod
│       ├── lib/                  # the error shape, IDs, Melbourne time
│       └── testing/fakes.ts      # in-memory implementations, sample passages and a scripted answer
├── bin/deploy.ts                 # the CDK app: one toolchain stack per run, by -c deployMode=stateful|stateless
├── infrastructure/
│   ├── environments.ts           # the accounts: beta (dev) and prod, and the toolchain account
│   ├── stage/                    # what each stage account runs
│   │   ├── config.ts             # settings per stage: origins, models, budget, access logs, alert addresses
│   │   ├── constants.ts          # names both stacks share: SSM parameters, the docs/ prefix, the publisher role
│   │   ├── stateful-stack.ts     # key, buckets, table, knowledge base, guardrail
│   │   ├── stateless-stack.ts    # API, WAF, authorizer, functions, ingestion schedule, alarms, budget backstop
│   │   └── api-docs.ts           # the OpenAPI JSON and the Swagger UI page that API Gateway serves
│   └── toolchain/                # the two pipelines, in the toolchain account
│       ├── deployment-pipeline.ts  # the pipeline construct; umccr/docs-platform has the same file
│       ├── stateful-stack.ts     # the stateful pipeline: its push filters, tests and synth
│       ├── stateless-stack.ts    # the stateless pipeline, likewise
│       └── build-spec.ts         # CodeBuild on Node.js 24
├── test/                         # Jest: the stage stacks with cdk-nag, the toolchain stacks, the pipeline construct
├── docs/                         # project, tech, design, architecture, API, deploy, runbook
├── Makefile                      # the commands below
└── .github/workflows/pr-tests.yml  # checks on pull requests and on main
```

The root package is the CDK app and its tests: CommonJS, run by ts-node and tested with Jest. `app/` is the code that
runs in Lambda: ES modules, bundled by esbuild and tested with Vitest. Each has its own `tsconfig.json`, ESLint and
Prettier configuration, and the root's leave `app/` out, so `make check-all` and `make test-all` are what cover both.

## The app

### How it is put together

- **Ports and adapters.** `services/` holds the logic behind small interfaces (`Retriever`, `Answerer`,
  `SpendStore`, `ConversationStore`, `RecordStore`, `DocumentStore`, `IngestState`, `Ingestion`) and imports nothing
  from AWS. `aws/` implements them, `aws/deps.ts` builds them from the environment, and `testing/fakes.ts` implements
  them in memory. A new AWS call goes into `aws/`, behind an interface in `services/`, with a fake beside the others.
- **One app, two functions.** `createApp(deps)` in `app.ts` serves every route that needs a token. The chat function
  runs it with `streamHandle`, for response streaming, and the query function with `handle`; API Gateway decides
  which function gets which route. Tests run the same app with `fakeDeps()`, and `make dev` with `server.ts`.
- **Only the chat function has a model.** `answerer` is a factory, and only the chat function's environment names
  `ANSWER_MODEL_ID`, so the query function never builds a Bedrock runtime client.
- The authorizer and the two ingestion functions are plain Lambda handlers, without Hono.

### Functions

| Function             | Entry point               | Invoked by                                                                   | Memory and timeout  |
| -------------------- | ------------------------- | ---------------------------------------------------------------------------- | ------------------- |
| `ChatFunction`       | `handlers/chat.ts`        | `POST /api/v1/chat`, with response streaming                                 | 1,024 MB, 5 minutes |
| `QueryFunction`      | `handlers/query.ts`       | `POST /api/v1/search`, `GET /api/v1/documents/{id}`, `POST /api/v1/feedback` | 512 MB, 29 seconds  |
| `AuthorizerFunction` | `handlers/authorizer.ts`  | API Gateway, as a TOKEN authorizer cached five minutes per token             | 256 MB, 10 seconds  |
| `IngestMarkFunction` | `handlers/ingest-mark.ts` | EventBridge: an object created or deleted under `docs/`                      | 256 MB, 10 seconds  |
| `IngestRunFunction`  | `handlers/ingest-run.ts`  | EventBridge: every 15 minutes                                                | 256 MB, 30 seconds  |

All five run outside a VPC and call nothing but AWS APIs. `NodejsFunction` bundles each with esbuild to CommonJS for
`node24`, minified with source maps, and with `externalModules: []`, so that the AWS SDK a function runs is the one
the tests ran.

### Conventions in the code

- **Requests** are checked with a zod schema per body in `app.ts`, and the first problem becomes
  `400 invalid-request`. The functions' environment is parsed the same way, in `config/env.ts`.
- **Errors** are thrown as `ApiError(status, code, message, retryAfter?)` from `lib/errors.ts`. Every error, API
  Gateway's own included, has the shape `{"error": {"code", "message", "retryAfter"?}}`. Anything else thrown is a log
  line for the operator and, for the client, `500 internal`, or `503 unavailable` when an answer fails.
- **The stream** is `meta`, `delta`…, `citations`, `done`, and an `error` event ends it early. Errors are caught
  inside the stream's callback rather than in `streamSSE`'s `onError`, after which Hono would also send the raw error
  message, with account IDs and ARNs in it, as a second `error` event.
- **The caller** comes from the authorizer, as `sub`, `clientId`, `email` and `groups` (one string, separated by
  spaces) in `requestContext.authorizer`. Only `server.ts` sets `devCaller`, the fixed caller for local development.
- **Logs** are one JSON line per event, through `log()`, with an `outcome`. They never hold the question, the answer
  or the reader's email: `errorDetail(error, [question, answer])` cuts the question and the answer out of an error's
  message before it is logged.
- **The audit log** is read only by members of `AUDIT_GROUP`, which only the audit function is given, so the audit
  routes refuse everyone on any other function. Each read is logged as `audit-read`, with the viewer's `sub` and
  never what it returned.
- **Writes after an answer** are best-effort. A turn, record or audit entry that fails to save is logged as
  `write-error`, and
  `done` still follows, because the reader already has the answer.
- **Time** for the budget is Melbourne's (`lib/time.ts`), so allowances renew at midnight there. Records are filed
  under their UTC date.
- **IDs** are `c_` for conversations and `x_` for exchanges, each with 32 hex characters (`lib/ids.ts`), and requests
  are checked against that pattern.

### Log outcomes are an interface

Alarms count `outcome` values through metric filters, and the runbook's Logs Insights query filters on them, so a
renamed outcome silently stops its alarm.

| `outcome`                                | Logged by                                  | Counted by                                         |
| ---------------------------------------- | ------------------------------------------ | -------------------------------------------------- |
| `answered`, `not-covered`                | the chat function, for each answer         |                                                    |
| `stream-error`, `answer-error`           | the chat function, with the error's `code` | `AnswersFailedAlarm`, when `code` is `unavailable` |
| `error`                                  | either API function: an unexpected error   | `AnswersFailedAlarm`, for the chat function's      |
| `settle-error`, `write-error`            | the chat function, after an answer         | `WritesFailedAlarm`                                |
| `audit-read`                             | the audit function, for each read          |                                                    |
| `parameter-error`                        | the chat function, when SSM cannot be read |                                                    |
| `started`, `job-running`, `job-complete` | the ingest run function                    |                                                    |
| `job-failed`                             | the ingest run function                    | `IngestJobsFailedAlarm`                            |

The query function's failures also reach `ApiServerErrorsAlarm`, which counts the API's 5XX responses.

### Where the app keeps state

The Sonar table, `OrcaSonarTable-<stage>`, is one DynamoDB table keyed `pk` and `sk`, paid per request and encrypted
with the Sonar key. Items expire through `expiresAt`, in seconds since the epoch.

| Item                         | `pk`                 | `sk`                               | Expires                        |
| ---------------------------- | -------------------- | ---------------------------------- | ------------------------------ |
| a caller's spend today       | `spend`              | `caller#<sub>#<YYYY-MM-DD>`        | 40 days after its last change  |
| the team's spend today       | `spend`              | `day#<YYYY-MM-DD>`                 | 40 days after its last change  |
| the month's spend            | `spend`              | `month#<YYYY-MM>`                  | 400 days after its last change |
| a conversation's turn        | `conversation#<c_…>` | `turn#<ISO time>`, with `owner`    | after 30 days                  |
| an exchange in the audit log | `audit#<c_…>`        | `<ISO time>#<x_…>`, with `auditPk` | after 30 days                  |
| the stale mark               | `ingest`             | `stale`, with `at` and `revision`  | never                          |
| the job started for the mark | `ingest`             | `job`, with `jobId` and `revision` | never                          |

Audit entries also carry `auditPk`, always `exchange`, and `at`, the keys of the one index, `audit-by-time`, which
lists them by time; only audit items have `auditPk`, so the index holds nothing else. A caller or an outcome is
filtered as the entries are read, which reads every entry in the window; the budget keeps that to about a hundred a
day. A table update can create one index at most, so a second index, such as one by caller, needs a deploy of its
own.

The three spend counters change together in one transaction, so they always agree, and a hold is conditional on the
caller's and the day's counters being under their limits. The records bucket holds
`records/date=YYYY-MM-DD/<exchangeId>.json` and `feedback/date=YYYY-MM-DD/…`, both deleted after 30 days, and
`eval-set/`, which is kept.

## The infrastructure

- `bin/deploy.ts` synthesizes one toolchain stack per run, chosen by context: `pnpm cdk-stateful …` sets
  `-c deployMode=stateful`, and `pnpm cdk-stateless …` sets `stateless`. Without it, the app throws.
- Each toolchain stack is a pipeline that builds its stage stack once per stage, at the construct path
  `<toolchain stack>/DeploymentPipeline/<Beta|Prod>/<stack>`. `cdk deploy` selects a stage stack by that path to
  deploy it by hand.
- In every account the stage stacks are the CloudFormation stacks `UMCCR-OrcaSonarStatefulStack` and
  `UMCCR-OrcaSonarStatelessStack`, tagged `umccr-org:Product: OrcaSonar`; the pipeline adds `umccr-org:Creator`,
  `umccr-org:Service` and `umccr-org:Source`.
- SSM is the interface between the stacks. The stateful stack writes `/orcasonar/*` (`SSM_PARAMETERS` in
  `constants.ts`), and the stateless stack reads them when it deploys, so in every account the stateful stack
  deploys first. The stateless stack also reads parameters other repositories write (the certificate, the hosted
  zone, the user pool and the `docs-app` client), and writes `/orcasonar/api-url`.
- Settings per stage are in `infrastructure/stage/config.ts`, and names both stacks share are in `constants.ts`.
  Change a setting there, not in a stack.

| Setting                                 | beta                                                               | prod                                                                       |
| --------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `DOCS_ORIGINS`: the origins CORS allows | `https://docs.dev.umccr.org`                                       | `https://docs.umccr.org`, `https://docs.prod.umccr.org`                    |
| `ANSWER_MODEL_ID`                       | `au.anthropic.claude-sonnet-5`                                     | the same                                                                   |
| `ALLOWED_MODEL_IDS`                     | the answer model and `au.anthropic.claude-haiku-4-5-20251001-v1:0` | the same                                                                   |
| `MODEL_REGIONS`                         | ap-southeast-2, ap-southeast-4                                     | the same                                                                   |
| `MONTHLY_BUDGET_USD`                    | 10                                                                 | 50                                                                         |
| `CALLER_DAILY_USD`                      | 0.40                                                               | 0.40                                                                       |
| `ACCESS_LOGS`                           | on                                                                 | on                                                                         |
| `ALERT_EMAILS`                          | none yet                                                           | none yet                                                                   |
| Data when a stack is deleted            | deleted                                                            | kept (`RETAIN_ON_UPDATE_OR_DELETE`), and the table has deletion protection |
| Log retention                           | one month                                                          | three months                                                               |

Patterns to know before changing a stack:

- **Open routes never reach a function.** `/api/v1/health`, `/schema/openapi.json` and `/schema/swagger-ui/` are API
  Gateway mock integrations, built by `staticGet` in `stateless-stack.ts`. The body is base64-encoded in the mapping
  template, so `$` and `#` are never read as template syntax, and synth refuses one over API Gateway's 300 KB template
  limit. Every Lambda integration has the authorizer.
- **API Gateway's own errors** (no token, WAF, throttling, an unknown route as 404, other 4XX and 5XX) are gateway
  responses in the API's error shape, with CORS headers so that the browser shows them to the panel.
- **The contract** is `app/schema/openapi.yaml`. `api-docs.ts` serves it as JSON, with this stage's API as its only
  server, and serves Swagger UI from jsDelivr at a pinned version, checked against its hashes, under a
  Content-Security-Policy.
- **The guardrail is versioned by its policies' hash.** A change to its policies publishes a new version and writes
  its number to `/orcasonar/guardrail-version`, which the chat function reads every five minutes. Replaced versions
  are kept until the runbook's clean-up.
- **The chat role may call only the allowed models**: the `ALLOWED_MODEL_IDS` profiles, and the models behind them in
  `MODEL_REGIONS`. The stack refuses an `ANSWER_MODEL_ID` that is not in that list.

## Pipelines and CI

GitHub Actions checks pull requests, and the pipelines in the toolchain account deploy `main`.

**GitHub Actions** (`.github/workflows/pr-tests.yml`) runs on pull requests to `main` and on pushes to it:

| Job                                  | Runs                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| Infrastructure tests, lint and synth | `make check`, with `no-commit-to-branch` skipped; `make test`; `make cdk-synth`      |
| App tests, lint and type checks      | `cd app && pnpm check && pnpm test`                                                  |
| Secrets scan                         | detect-secrets over every tracked file but the lockfile, against `.secrets.baseline` |

The actions are pinned by commit SHA, with read-only permissions and no persisted credentials.

**The pipelines** are built by `infrastructure/toolchain/deployment-pipeline.ts`: a self-mutating CDK pipeline
(CodePipeline V2) per stack, adapted from OrcaBus's `DeploymentStackPipeline` so that nothing is named for OrcaBus.

```text
Source (umccr/orcasonar main) ─▶ tests, in parallel ─▶ synth ─▶ self-update ─▶ assets
  ─▶ Beta (dev account) ─▶ PromoteToProd approval, 60 minutes ─▶ Prod (prod account)
```

- Steps run on CodeBuild's ARM Amazon Linux 2023 image, Node.js 24, and install with
  `pnpm install --frozen-lockfile --ignore-scripts`.
- The stateful pipeline tests with `pnpm test`; the stateless one adds `cd app && pnpm check && pnpm test`.
- An unanswered `PromoteToProd` fails the run after 60 minutes, so it never holds back newer runs.
- A failed run posts to the alerts Slack channel.
- Push filters choose the pipeline: a change under `app/` starts only the stateless one, a change to one stack's file
  only that stack's pipeline, and `docs/` or any Markdown neither; anything else, such as `config.ts` or the lockfile,
  starts both. [deploy.md](deploy.md#what-gets-deployed) has the table.

## Commands

| Command           | What it does                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `corepack enable` | once, so that `pnpm` is the version `package.json` names                                                            |
| `make install`    | installs the whole workspace from the lockfile, and the git hook that runs pre-commit                               |
| `make check`      | `pnpm audit` for the whole workspace, Prettier and ESLint for everything outside `app/`, then every pre-commit hook |
| `make check-all`  | `make check`, and the app's type check, lint and format check                                                       |
| `make test`       | the infrastructure tests: `tsc --noEmit`, then Jest with cdk-nag                                                    |
| `make test-all`   | `make test`, and the app's Vitest tests                                                                             |
| `make cdk-list`   | lists both toolchain stacks and, by construct path, the stage stacks each deploys                                   |
| `make cdk-synth`  | synthesizes both toolchain stacks, and with them every stage stack                                                  |
| `make dev`        | the API on `http://127.0.0.1:8787/api/v1`, in memory, with no AWS access                                            |
| `make fix`        | Prettier and ESLint fixes, in both packages                                                                         |
| `make audit-fix`  | `pnpm audit --fix`: overrides that force patched versions                                                           |
| `make clean`      | removes `cdk.out`                                                                                                   |

Run `make check-all && make test-all` before pushing. To run one test file: `pnpm exec jest test/stage.test.ts` at
the root, or `pnpm exec vitest run src/services/budget.test.ts` in `app/`. `make dev` takes `PORT` to change its port
and allows CORS from `http://127.0.0.1:8000` and `http://localhost:8000`, for a docs site served locally. To deploy
beta by hand from a branch, with dev credentials, see [deploy.md](deploy.md#step-3-try-it-in-dev-by-hand-optional).

## Tests

- **The infrastructure tests** in `test/` build both stage stacks for beta and prod and assert on their templates.
  They hold the guards that matter most: only `/health`, the API docs and CORS preflight are open, and every Lambda
  integration is behind the authorizer; the chat role can call only the Australian profiles; the WAF body rules only
  count; every alarm tells the alerts topic. `test/deployment-pipeline.test.ts` checks the pipeline construct,
  including that nothing in it is named for OrcaBus.
- **cdk-nag** v3 runs as a CDK validation plugin, so an unacknowledged finding fails synth. The AwsSolutions rules
  OrcaSonar accepts are in `ACCEPTED_RULES` in `test/stage.test.ts`, each with its reason; accepting another needs
  its reason there too. `test/cdk-nag-helpers.ts` explains how v3's acknowledgements differ from v2's suppressions.
- **The app tests** (`app/src/**/*.test.ts`) run the Hono app on `fakeDeps()` for the routes, the stream, the budget
  and the accounting, and test the AWS adapters against `aws-sdk-client-mock` in `aws/adapters.test.ts`.
  `openapi.test.ts` fails when `openapi.yaml` and `ROUTES` disagree, or when an error code is missing from the
  contract.
- No test calls AWS or needs credentials.
- Test names are sentences that say what the code does, such as "keeps the whole hold when the answer fails after the
  model accepted the request".

## Style and safety

- **Prettier**, the same in both packages: 100 columns, single quotes, semicolons, ES5 trailing commas and two
  spaces. It formats Markdown too, tables included, and `make check` fails on a doc it would change. Prose in `docs/`
  is wrapped by hand at about 120 columns.
- **ESLint** uses typescript-eslint's recommended rules. The app requires `import type` for types
  (`consistent-type-imports`); the root warns on unused names unless they start with `_`.
- **TypeScript** is strict in both packages, and the app adds `noUncheckedIndexedAccess`.
- **Comments** say why, in full sentences, on exported names and on anything surprising, and name the document or the
  finding behind a choice, such as the Security Hub finding behind the open routes.
- **Docs** are plain British English (organisation, licence), with AWS's names spelled as AWS spells them
  (authorizer). Dates are absolute, and a fact checked in an account says where and when, as in "dev, 2026-10-15".
- **pre-commit** runs on every commit: no commits to `main`, `master` or `release/*`; no AWS credentials, private keys
  or large files; valid YAML; no trailing whitespace, and a newline at the end of each file; detect-secrets against
  `.secrets.baseline`; ESLint and Prettier. Work on a branch and open a pull request.
- **Never commit** a real account ID, ARN, bucket name or token, or a person's email address. Account IDs come from
  `@orcabus/platform-cdk-constructs`, and deployed names from SSM. `ALERT_EMAILS` takes team addresses only.
- **Subresource Integrity hashes** look like secrets to detect-secrets; mark them `// pragma: allowlist secret`, as
  `api-docs.ts` does.
- **Dependency scripts** are off: `pnpm-workspace.yaml` turns down the build scripts of the packages that have them
  (`allowBuilds`), since tests, synth and bundling need none, and the pipelines install with `--ignore-scripts`. The
  workspace ignores one advisory, GHSA-hp3w-g68c-fv3c in `sprintf-js`, which has no fix and reaches only Jest's
  coverage tooling; remove the exception once a fix exists.

## Change these together

| When you change                                                                 | Also change                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a model in `ANSWER_MODEL_ID` or `ALLOWED_MODEL_IDS`                             | its rates in `MODEL_PRICES` (`app/src/services/pricing.ts`), in US dollars per million tokens at the `au.` profile's prices, or the budget prices it as the most expensive model. Accept its agreement in every stage account first ([runbook](runbook.md#move-to-another-claude-model)). |
| the model, the prompt or retrieval                                              | compare the answers on `eval-set/` before the change reaches readers                                                                                                                                                                                                                      |
| a route                                                                         | `ROUTES` in `app/src/app.ts`, `app/schema/openapi.yaml`, the method in `stateless-stack.ts` and [api.md](api.md). A route without a token must be a mock integration.                                                                                                                     |
| an error code                                                                   | `ErrorCode` in `app/src/lib/errors.ts`, the enum in `openapi.yaml`, `GATEWAY_ERRORS` in `stateless-stack.ts` if API Gateway can return it, and [api.md](api.md#errors)                                                                                                                    |
| a limit per request: question length, history, passages or answer tokens        | keep `ANSWER_HOLD_USD` (`app/src/services/budget.ts`) above the most an answer can then cost, and update `openapi.yaml` and [api.md](api.md#limits)                                                                                                                                       |
| a log `outcome`                                                                 | the metric filters in `stateless-stack.ts`, and the query in [runbook.md](runbook.md#an-alarm-fired)                                                                                                                                                                                      |
| the audit index                                                                 | `AUDIT_INDEX` in both `app/src/aws/dynamodb.ts` and `infrastructure/stage/constants.ts`. Deploy the stateful stack to prod before the stateless stack that queries a new index.                                                                                                           |
| the guardrail's policies                                                        | nothing in the stateless stack, which reads the new version from SSM; run the stateless pipeline afterwards so its fallback version moves too, then delete old versions ([runbook](runbook.md#change-the-guardrail))                                                                      |
| the knowledge base or its data source                                           | check the stateful diff for a replacement: a new knowledge base starts empty, so start an ingestion job after the deploy                                                                                                                                                                  |
| a docs host                                                                     | `DOCS_ORIGINS` here and `DOCS_DOMAIN_NAMES` in `umccr/docs-platform`'s `infrastructure/config.ts`                                                                                                                                                                                         |
| the API's domain or base path (`API_DOMAIN_PREFIX`, `API_BASE_PATH`)            | `SONAR_API_URLS` in `umccr/docs-platform`'s `infrastructure/config.ts`, which the chat panel and its Content-Security-Policy use; the docs platform does not read `/orcasonar/api-url`                                                                                                    |
| the stateful stack's name, or the ingest bucket's construct ID (`IngestBucket`) | `ORCASONAR_INGEST_BUCKET_NAME_PREFIX` in `umccr/docs-platform`'s `infrastructure/config.ts`: the publisher role's policy matches the bucket by the name CloudFormation generates from both                                                                                                |
| the publisher role's name or path, or `/orcasonar/ingest-bucket-name`           | the same names in `umccr/docs-platform`'s `infrastructure/config.ts`                                                                                                                                                                                                                      |
| `infrastructure/toolchain/deployment-pipeline.ts`                               | the same file in `umccr/docs-platform`                                                                                                                                                                                                                                                    |
| a pipeline's push filters                                                       | keep each list to 8 patterns, CodePipeline's limit (`MAX_TRIGGER_FILE_PATHS`); the pipeline construct refuses more when it is built                                                                                                                                                       |
| the Swagger UI version                                                          | both of its hashes in `api-docs.ts`, with the command in the comment there                                                                                                                                                                                                                |

## Deliberate, though it can look wrong

Each of these has a reason. Check it before changing one.

| What                                                                                                                                          | Why                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The alerts topic's construct ID is `BudgetTopic`.                                                                                             | It is kept from when the topic carried only the budget's notices, so that neither the topic nor the budget and the action that name it are replaced.                                    |
| The two default gateway responses keep the construct IDs they had before they had bodies.                                                     | CloudFormation updates them in place; replacing one would reset it to API Gateway's default.                                                                                            |
| The `docs` data source has no `metadataFilesPrefix`.                                                                                          | With one, the connector looks for `<prefix><document key>.metadata.json`. `docs/` sent it to `docs/docs/…`: citations lost their titles and links, and no page matched a `site` filter. |
| The data source names `bucketOwnerAccountId`, for a bucket in its own account.                                                                | The connector refuses a null value, although its documentation says it is needed only for a bucket in another account.                                                                  |
| `ConverseStream` gets no `temperature`, or any other sampling parameter.                                                                      | Claude Sonnet 5 refuses `temperature` as deprecated for the model; the prompt and the grounding check keep answers to the passages.                                                     |
| Four rules of the AWS common rule set only count: `GenericLFI_BODY`, `GenericRFI_BODY`, `CrossSiteScripting_BODY` and `EC2MetaDataSSRF_BODY`. | They blocked questions about `../` links, HTML and internal addresses in dev (2026-10-21). A question is text for the model, never a path, page or address the API opens.               |
| The chat role has no AWS Marketplace permissions.                                                                                             | A service role must not accept licence terms or start billing for UMCCR. An administrator accepts each model's agreement by hand.                                                       |
| `/health` is a mock integration, not a function.                                                                                              | Security Hub flagged a function reachable through API Gateway without authorisation.                                                                                                    |
| The authorizer allows every route of the stage.                                                                                               | API Gateway caches its answer five minutes per token, not per route.                                                                                                                    |
| A REST API, not the HTTP API the OrcaBus services use.                                                                                        | HTTP APIs cannot stream, and stop at 30 seconds.                                                                                                                                        |
| The functions run outside a VPC.                                                                                                              | They call only AWS APIs. VPC endpoints for Bedrock would cost about $35 to $40 a month, nearly doubling the budget, so they wait for a security review that asks for them.              |
| Prod's data is `RETAIN_ON_UPDATE_OR_DELETE`, not `RETAIN`.                                                                                    | After a failed first create, a kept resource would be an orphan, and its fixed name, such as the table's or the key alias, would block the retry.                                       |
| Replaced guardrail versions are kept.                                                                                                         | Running functions use the old version until they read the new one, and the stateless stack names it as their fallback until its next deploy.                                            |
| Spend is read with three consistent `GetItem` calls, not one batch.                                                                           | A throttled batch can come back without some counters, which would read as nothing spent.                                                                                               |
| `/documents/{id}` does not decode its ID.                                                                                                     | Hono has decoded it already; decoding it again would change or refuse IDs that contain `%`.                                                                                             |
| The budget backstop filters on the service `Amazon Bedrock`; `ALERT_EMAILS` is empty; `MIN_SCORE` is 0.                                       | Open items waiting on a check or a decision, not oversights: [project.md](project.md#open-items).                                                                                       |
