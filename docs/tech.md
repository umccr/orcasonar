# Tech stack and conventions

How OrcaSonar is built and laid out, and the conventions for changing it, for a person or a coding agent. What the
project is for is in [project.md](project.md); what is deployed, in [architecture.md](architecture.md).

## The stack

| Part                  | What                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Language              | TypeScript `~5.9.3`, strict in both packages                                                                               |
| Runtime               | Node.js 24: Lambda's `nodejs24.x` on arm64, CodeBuild and GitHub Actions                                                   |
| Package manager       | pnpm through Corepack, at the version `packageManager` pins in `package.json` (12.15.0)                                    |
| Infrastructure        | AWS CDK: `aws-cdk-lib` `^2.269.0`, the `aws-cdk` CLI `^2.1141.0`, `constructs` `^10.8.0`                                   |
| Infrastructure checks | `cdk-nag` `^3.0.2`: the AwsSolutions pack, as a CDK validation plugin in the tests                                         |
| API                   | Hono `^4.12.27`, run by `@hono/aws-lambda` in Lambda and `@hono/node-server` locally                                       |
| Validation and tokens | zod `^4.4.3` for request bodies and the environment; `aws-jwt-verify` `^5.2.1` for Cognito ID tokens                       |
| AWS SDK               | v3, `^3.1141.0`: Bedrock runtime, agent runtime and agent, DynamoDB with `lib-dynamodb`, S3, SSM                           |
| Tests                 | Jest `^30.5.1` with ts-jest for the infrastructure; Vitest `^4.0.0` with `aws-sdk-client-mock` for the app                 |
| Lint, format, bundle  | ESLint `^9.39.5` with typescript-eslint; Prettier `^3.9.6`; esbuild `^0.28.2` through `NodejsFunction`; tsx for `make dev` |

The versions are the ranges in `package.json`; `pnpm-lock.yaml` pins what is installed, and the functions bundle
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
│       ├── handlers/             # Lambda entry points: chat, query, audit, authorizer, ingest-mark, ingest-run
│       ├── services/             # the logic, behind interfaces, with no AWS imports
│       ├── aws/                  # the interfaces' AWS implementations; deps.ts wires them from the environment
│       ├── config/env.ts         # the functions' environment, parsed with zod
│       ├── lib/                  # the error shape, IDs, paging and Melbourne time
│       └── testing/fakes.ts      # in-memory implementations, sample passages and a scripted answer
├── bin/deploy.ts                 # the CDK app: one toolchain stack per run, by -c deployMode=stateful|stateless
├── infrastructure/
│   ├── environments.ts           # the accounts: beta (dev), prod and the toolchain account
│   ├── shared/                   # platform.ts (accounts, shared SSM names, OrcaUI's hosts) and git-commit.ts
│   ├── stage/                    # config.ts (settings per stage), constants.ts (names both stacks share),
│   │                             # stateful-stack.ts, stateless-stack.ts, api-docs.ts (OpenAPI JSON, Swagger UI)
│   └── toolchain/                # the pipelines: deployment-pipeline.ts, as in umccr/docs-platform, and a stack each
├── test/                         # Jest: the stage stacks with cdk-nag, the toolchain stacks, the pipeline construct
├── docs/                         # these pages, published at docs.umccr.org/orcasonar/
└── .github/workflows/pr-tests.yml  # checks on pull requests and on main
```

The root package is the CDK app: CommonJS, run by ts-node and tested with Jest. `app/` runs in Lambda: ES modules,
bundled by esbuild and tested with Vitest. Each has its own `tsconfig.json`, ESLint and Prettier configuration, and
the root's leave `app/` out, so only `make check-all` and `make test-all` cover both.

## The app

- **Ports and adapters.** `services/` holds the logic behind small interfaces (`Retriever`, `Answerer`,
  `SpendStore`, `ConversationStore`, `RecordStore`, `AuditStore`, `DocumentStore`, `IngestState`, `Ingestion`) and
  imports nothing from AWS. `aws/` implements them, `aws/deps.ts` wires them from the environment, and
  `testing/fakes.ts` implements them in memory. A new AWS call goes in `aws/`, behind an interface, with a fake.
- **One app, three functions.** `createApp(deps)` in `app.ts` serves every route that needs a token: the chat function
  runs it with `streamHandle`, the query and audit functions with `handle`, and API Gateway picks the function per
  route. Tests run it on `fakeDeps()`, and `make dev` through `server.ts`.
- **Only the chat function has a model**: only its environment names `ANSWER_MODEL_ID`, and `answerer` is a factory.
- The authorizer and the two ingestion functions are plain Lambda handlers, without Hono.

| Function             | Entry point               | Invoked by                                                       | Memory and timeout  |
| -------------------- | ------------------------- | ---------------------------------------------------------------- | ------------------- |
| `ChatFunction`       | `handlers/chat.ts`        | `POST /api/v1/chat`, with response streaming                     | 1,024 MB, 5 minutes |
| `QueryFunction`      | `handlers/query.ts`       | `/search`, `/documents/{id}`, `/feedback`, `/chat/history…`      | 512 MB, 29 seconds  |
| `AuditFunction`      | `handlers/audit.ts`       | `/audit/…`, for the audit group only                             | 512 MB, 29 seconds  |
| `AuthorizerFunction` | `handlers/authorizer.ts`  | API Gateway, as a TOKEN authorizer cached five minutes per token | 256 MB, 10 seconds  |
| `IngestMarkFunction` | `handlers/ingest-mark.ts` | EventBridge: an object created or deleted under `docs/`          | 256 MB, 10 seconds  |
| `IngestRunFunction`  | `handlers/ingest-run.ts`  | EventBridge: every 15 minutes                                    | 256 MB, 30 seconds  |

All six run outside a VPC. `NodejsFunction` bundles each to CommonJS for `node24`, minified with source maps, with
`externalModules: []`, so a function runs the AWS SDK the tests ran.

### Conventions in the code

- **Requests** are checked with a zod schema per body in `app.ts`; the first problem becomes `400 invalid-request`.
  The environment is parsed the same way, in `config/env.ts`.
- **Errors** are thrown as `ApiError(status, code, message, retryAfter?)` from `lib/errors.ts`, in the shape
  `{"error": {"code", "message", "retryAfter"?}}`. Anything else thrown is logged and becomes `500 internal`, or
  `503 unavailable` when an answer fails.
- **The stream** is `meta`, `delta`…, `citations`, `done`; an `error` event ends it early. Errors are caught inside
  the stream's callback, not in `streamSSE`'s `onError`, after which Hono would also send the raw error message, with
  account IDs and ARNs, as a second `error` event.
- **The caller** comes from `requestContext.authorizer`: `sub`, `clientId`, `email` and `groups` (space-separated).
  Only `server.ts` sets `devCaller`.
- **Logs** are one JSON line per event through `log()`, with an `outcome`, and never hold the question, the answer or
  the email: `errorDetail(error, [question, answer])` cuts both out of an error's message.
- **The audit log** is read only by members of `AUDIT_GROUP`, which only the audit function is given. Each read is
  logged as `audit-read` with the viewer's `sub`, never with what it returned.
- **History** is always the token's own `sub`, never a parameter, and maps audit entries field by field, so nothing
  the audit log adds (email, client, cost, tokens, model, guardrail) reaches it.
- **Writes after an answer** are best-effort: a turn, record or audit entry that fails is logged as `write-error`, and
  `done` still follows.
- **Time** for the budget is Melbourne's (`lib/time.ts`); records are filed by UTC date.
- **IDs** are `c_` (conversation) and `x_` (exchange) and 32 hex characters (`lib/ids.ts`), and requests are checked
  against that pattern.

### Log outcomes are an interface

Alarms count `outcome` values through metric filters, and the runbook's query filters on them, so a renamed outcome
silently stops its alarm.

| `outcome`                                | Logged by                                  | Counted by                                         |
| ---------------------------------------- | ------------------------------------------ | -------------------------------------------------- |
| `answered`, `not-covered`                | the chat function, for each answer         |                                                    |
| `stream-error`, `answer-error`           | the chat function, with the error's `code` | `AnswersFailedAlarm`, when `code` is `unavailable` |
| `error`                                  | any API function: an unexpected error      | `AnswersFailedAlarm`, for the chat function's      |
| `settle-error`, `write-error`            | the chat function, after an answer         | `WritesFailedAlarm`                                |
| `audit-read`                             | the audit function, for each read          |                                                    |
| `parameter-error`                        | the chat function, when SSM cannot be read |                                                    |
| `started`, `job-running`, `job-complete` | the ingest run function                    |                                                    |
| `job-failed`                             | the ingest run function                    | `IngestJobsFailedAlarm`                            |

The query and audit functions' failures reach `ApiServerErrorsAlarm`, which counts the API's 5XX responses.

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

- The three spend counters change together in one transaction, and a hold is conditional on the caller's and the
  day's being under their limits.
- Index `audit-by-time` (`auditPk`, always `exchange`, and `at`) lists audit entries by time. The audit routes filter
  as they read, so they read the whole window, which the budget keeps to about a hundred entries a day.
- Index `audit-by-caller` (`callerId`, `at`) lists one caller's entries for their history. It projects only
  `conversationId`, `question` and `outcome`, and only the query function may query it.
- A table update can create or delete one index at most, and a projection cannot change, so each needs a deploy of
  its own. An index must be `ACTIVE` before the stateless code that queries it deploys; CloudFormation does not wait.

The records bucket holds `records/date=YYYY-MM-DD/<exchangeId>.json` and `feedback/date=YYYY-MM-DD/…`, both deleted
after 30 days, and `eval-set/`, which is kept.

## The infrastructure

`bin/deploy.ts` synthesizes one toolchain stack per run: `pnpm cdk-stateful …` and `pnpm cdk-stateless …` set
`-c deployMode`, without which the app throws. Each toolchain stack is a pipeline that builds its stage stack per
stage, at `<toolchain stack>/DeploymentPipeline/<Beta|Prod>/<stack>` ([deploy.md](deploy.md#what-gets-deployed)).

SSM is the interface between the stacks: the stateful stack writes `/orcasonar/*` (`SSM_PARAMETERS` in
`constants.ts`), and the stateless stack reads them, and other repositories' parameters
([deploy.md](deploy.md#parameters)), when it deploys. Settings per stage are in `infrastructure/stage/config.ts`:
change them there, not in a stack.

| Setting                      | beta                                                               | prod                                                                       |
| ---------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `DOCS_ORIGINS`, for CORS     | `https://docs.dev.umccr.org`                                       | `https://docs.umccr.org`, `https://docs.prod.umccr.org`                    |
| `ANSWER_MODEL_ID`            | `au.anthropic.claude-sonnet-5`                                     | the same                                                                   |
| `ALLOWED_MODEL_IDS`          | the answer model and `au.anthropic.claude-haiku-4-5-20251001-v1:0` | the same                                                                   |
| `MODEL_REGIONS`              | ap-southeast-2, ap-southeast-4                                     | the same                                                                   |
| `MONTHLY_BUDGET_USD`         | 10                                                                 | 50                                                                         |
| `CALLER_DAILY_USD`           | 0.40                                                               | 0.40                                                                       |
| `AUDIT_GROUP`                | `*`, every accepted token, for now                                 | `admin`                                                                    |
| `ACCESS_LOGS`                | on                                                                 | on                                                                         |
| `ALERT_EMAILS`               | none yet                                                           | none yet                                                                   |
| Data when a stack is deleted | deleted                                                            | kept (`RETAIN_ON_UPDATE_OR_DELETE`), and the table has deletion protection |
| Log retention                | one month                                                          | three months                                                               |

CORS also allows OrcaUI's hosts, `ORCAUI_ORIGINS` in `infrastructure/shared/platform.ts`. Before changing a stack:

- **Open routes never reach a function.** `/api/v1/health` and the two `/schema/` routes are mock integrations built
  by `staticGet` in `stateless-stack.ts`, with the body base64-encoded in the mapping template so that `$` and `#` are
  never template syntax; synth refuses a body over API Gateway's 300 KB template limit.
- **API Gateway's own errors** are gateway responses in the API's error shape, with CORS headers so that the browser
  shows them to the panel.
- **The guardrail is versioned by its policies' hash**: a policy change publishes a new version and writes it to
  `/orcasonar/guardrail-version`, which the chat function reads every five minutes.
- **The chat role may call only the allowed models**, the `ALLOWED_MODEL_IDS` profiles and the models behind them in
  `MODEL_REGIONS`, and the stack refuses an `ANSWER_MODEL_ID` outside that list.

## Pipelines and CI

**GitHub Actions** (`.github/workflows/pr-tests.yml`) runs on pull requests to `main` and on pushes to it, with
actions pinned by commit SHA, read-only permissions and no persisted credentials:

| Job                                  | Runs                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| Infrastructure tests, lint and synth | `make check`, with `no-commit-to-branch` skipped; `make test`; `make cdk-synth`      |
| App tests, lint and type checks      | `cd app && pnpm check && pnpm test`                                                  |
| Secrets scan                         | detect-secrets over every tracked file but the lockfile, against `.secrets.baseline` |

**The pipelines** are self-mutating CDK pipelines (CodePipeline V2), one per stack, built by
`infrastructure/toolchain/deployment-pipeline.ts`, adapted from OrcaBus's `DeploymentStackPipeline` so that nothing is
named for OrcaBus ([diagram](design.md#deploying)). Steps run on CodeBuild's ARM Amazon Linux 2023 image with Node.js
24 and install with `pnpm install --frozen-lockfile --ignore-scripts`. The stateful pipeline tests with `pnpm test`;
the stateless one adds `cd app && pnpm check && pnpm test`. A failed run posts to the alerts Slack channel.

## Commands

| Command           | What it does                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `corepack enable` | once, so that `pnpm` is the version `package.json` names                                             |
| `make install`    | installs the workspace from the lockfile, and the git hook that runs pre-commit                      |
| `make check`      | `pnpm audit` for the whole workspace, Prettier and ESLint outside `app/`, then every pre-commit hook |
| `make check-all`  | `make check`, and the app's type check, lint and format check                                        |
| `make test`       | the infrastructure tests: `tsc --noEmit`, then Jest with cdk-nag                                     |
| `make test-all`   | `make test`, and the app's Vitest tests                                                              |
| `make cdk-list`   | both toolchain stacks and, by construct path, the stage stacks each deploys                          |
| `make cdk-synth`  | synthesizes both toolchain stacks, and with them every stage stack                                   |
| `make dev`        | the API on `http://127.0.0.1:8787/api/v1`, in memory, with no AWS access; `PORT` changes the port    |
| `make fix`        | Prettier and ESLint fixes, in both packages                                                          |
| `make audit-fix`  | `pnpm audit --fix`: overrides that force patched versions                                            |
| `make clean`      | removes `cdk.out`                                                                                    |

Run `make check-all && make test-all` before pushing. One test file: `pnpm exec jest test/stage.test.ts` at the root,
or `pnpm exec vitest run src/services/budget.test.ts` in `app/`. `make dev` allows CORS from
`http://127.0.0.1:8000` and `http://localhost:8000`, for a docs site served locally.

## Tests

- **The infrastructure tests** in `test/` build both stage stacks for beta and prod and assert on their templates:
  only `/health`, the API docs and CORS preflight are open, every Lambda integration is behind the authorizer, the
  chat role can call only the Australian profiles, the WAF body rules only count, and every alarm tells the alerts
  topic. `test/deployment-pipeline.test.ts` checks that nothing in the pipeline construct is named for OrcaBus.
- **cdk-nag** v3 runs as a validation plugin, so an unacknowledged finding fails synth. The accepted AwsSolutions
  rules are in `ACCEPTED_RULES` in `test/stage.test.ts`, each with its reason; `test/cdk-nag-helpers.ts` explains v3's
  acknowledgements.
- **The app tests** run the Hono app on `fakeDeps()` for the routes, the stream and the budget, and test the AWS
  adapters against `aws-sdk-client-mock`. `openapi.test.ts` fails when `openapi.yaml` and `ROUTES` disagree, or an
  error code is missing from the contract.
- No test calls AWS. Test names are sentences that say what the code does, such as "keeps the whole hold when the
  answer fails after the model accepted the request".

## Style and safety

- **Prettier**, the same in both packages: 100 columns, single quotes, semicolons, ES5 trailing commas, two spaces. It
  formats Markdown and its tables too, and `make check` fails on any file it would change. Prose in `docs/` is wrapped
  by hand at about 120 columns.
- **ESLint**: typescript-eslint's recommended rules. The app requires `import type` for types; the root warns on
  unused names unless they start with `_`. **TypeScript** is strict, and the app adds `noUncheckedIndexedAccess`.
- **Comments** say why, in full sentences, on exported names and anything surprising, and name the document or
  finding behind a choice.
- **Docs** are plain British English, with AWS's names as AWS spells them (authorizer). Dates are absolute, and a
  fact checked in an account says where and when, as in "dev, 2026-10-15".
- **pre-commit** blocks commits to `main`, `master` and `release/*`, AWS credentials, private keys, large files,
  invalid YAML, trailing whitespace and missing final newlines, and runs detect-secrets, ESLint and Prettier. Work on
  a branch and open a pull request.
- **Never commit** a real ARN, bucket name, token or a person's email address. Account IDs appear only in
  `infrastructure/shared/platform.ts`, as OrcaBus publishes them; deployed names come from SSM. `ALERT_EMAILS` takes
  team addresses only.
- **Subresource Integrity hashes** look like secrets to detect-secrets: mark them `// pragma: allowlist secret`, as
  `api-docs.ts` does.
- **Dependency build scripts** are off (`allowBuilds` in `pnpm-workspace.yaml`, and `--ignore-scripts` in the
  pipelines). The workspace ignores two advisories with no fix that reach only the infrastructure tests' Jest:
  GHSA-hp3w-g68c-fv3c (`sprintf-js`) and GHSA-gcqx-w48m-w2h4 (`deepmerge`). Remove each once a fix exists.

## Change these together

| When you change                                                                 | Also change                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a model in `ANSWER_MODEL_ID` or `ALLOWED_MODEL_IDS`                             | its rates in `MODEL_PRICES` (`app/src/services/pricing.ts`), in US dollars per million tokens at the `au.` price, or the budget prices it as the most expensive model. Accept its agreement in every account first ([runbook](runbook.md#move-to-another-claude-model)). |
| the model, the prompt or retrieval                                              | compare the answers on `eval-set/` before the change reaches readers                                                                                                                                                                                                     |
| a route                                                                         | `ROUTES` in `app/src/app.ts`, `app/schema/openapi.yaml`, the method in `stateless-stack.ts` and [api.md](api.md). A route without a token must be a mock integration.                                                                                                    |
| an error code                                                                   | `ErrorCode` in `app/src/lib/errors.ts`, the enum in `openapi.yaml`, `GATEWAY_ERRORS` in `stateless-stack.ts` if API Gateway can return it, and [api.md](api.md#errors)                                                                                                   |
| a limit per request: question length, history, passages or answer tokens        | keep `ANSWER_HOLD_USD` (`app/src/services/budget.ts`) above the most an answer can then cost, and update `openapi.yaml` and [api.md](api.md#limits)                                                                                                                      |
| a log `outcome`                                                                 | the metric filters in `stateless-stack.ts`, and the query in [runbook.md](runbook.md#an-alarm-fired)                                                                                                                                                                     |
| the audit index                                                                 | `AUDIT_INDEX` in both `app/src/aws/dynamodb.ts` and `infrastructure/stage/constants.ts`. Deploy the stateful stack, and wait until a new index is `ACTIVE`, before the stateless stack that queries it.                                                                  |
| the guardrail's policies                                                        | nothing in the stateless stack, which reads the new version from SSM; run the stateless pipeline afterwards so its fallback version moves too, then delete old versions ([runbook](runbook.md#change-the-guardrail))                                                     |
| the knowledge base or its data source                                           | check the stateful diff for a replacement: a new knowledge base starts empty, so start an ingestion job after the deploy                                                                                                                                                 |
| a calling app                                                                   | its client ID parameter in `ALLOWED_CLIENT_ID_PARAMETERS` and its hosts in `corsAllowOrigins` (`infrastructure/stage/config.ts`); OrcaUI's are in `infrastructure/shared/platform.ts`. Its Content-Security-Policy must allow `sonar.<stage>.umccr.org`.                 |
| a UMCCR account, a shared SSM parameter's name, or OrcaUI's hosts               | `infrastructure/shared/platform.ts`, in step with `OrcaBus/platform-cdk-constructs`, where OrcaBus changes them first                                                                                                                                                    |
| a docs host                                                                     | `DOCS_ORIGINS` here and `DOCS_DOMAIN_NAMES` in `umccr/docs-platform`'s `infrastructure/config.ts`                                                                                                                                                                        |
| the API's domain or base path (`API_DOMAIN_PREFIX`, `API_BASE_PATH`)            | `SONAR_API_URLS` in `umccr/docs-platform`'s `infrastructure/config.ts`, which the chat panel and its Content-Security-Policy use; the docs platform does not read `/orcasonar/api-url`                                                                                   |
| the stateful stack's name, or the ingest bucket's construct ID (`IngestBucket`) | `ORCASONAR_INGEST_BUCKET_NAME_PREFIX` in `umccr/docs-platform`'s `infrastructure/config.ts`: the publisher role's policy matches the bucket by the name CloudFormation generates from both                                                                               |
| the publisher role's name or path, or `/orcasonar/ingest-bucket-name`           | the same names in `umccr/docs-platform`'s `infrastructure/config.ts`                                                                                                                                                                                                     |
| `infrastructure/toolchain/deployment-pipeline.ts`                               | the same file in `umccr/docs-platform`                                                                                                                                                                                                                                   |
| a pipeline's push filters                                                       | keep each list to 8 patterns, CodePipeline's limit (`MAX_TRIGGER_FILE_PATHS`); the pipeline construct refuses more                                                                                                                                                       |
| the Swagger UI version                                                          | both of its hashes in `api-docs.ts`, with the command in the comment there                                                                                                                                                                                               |

## Deliberate, though it can look wrong

Each of these has a reason. Check it before changing one.

| What                                                                                                                   | Why                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The alerts topic's construct ID is `BudgetTopic`.                                                                      | Kept from when it carried only the budget's notices, so that neither the topic nor the budget and action that name it are replaced.                                                 |
| The two default gateway responses keep the construct IDs they had before they had bodies.                              | CloudFormation updates them in place; replacing one would reset it to API Gateway's default.                                                                                        |
| The `docs` data source has no `metadataFilesPrefix`.                                                                   | With one, the connector looks for `<prefix><document key>.metadata.json`: `docs/` sent it to `docs/docs/…`, so citations lost their titles and links, and no `site` filter matched. |
| The data source names `bucketOwnerAccountId`, for a bucket in its own account.                                         | The connector refuses a null value, although its documentation says it is needed only for a bucket in another account.                                                              |
| `ConverseStream` gets no `temperature` or other sampling parameter.                                                    | Claude Sonnet 5 refuses `temperature` as deprecated; the prompt and the grounding check keep answers to the passages.                                                               |
| Four common rules only count: `GenericLFI_BODY`, `GenericRFI_BODY`, `CrossSiteScripting_BODY`, `EC2MetaDataSSRF_BODY`. | They blocked questions about `../` links, HTML and internal addresses in dev (2026-10-21). A question is text for the model, never a path, page or address the API opens.           |
| The chat role has no AWS Marketplace permissions.                                                                      | A service role must not accept licence terms or start billing for UMCCR; an administrator accepts each model's agreement by hand.                                                   |
| `/health` is a mock integration, not a function.                                                                       | Security Hub flagged a function reachable through API Gateway without authorisation.                                                                                                |
| The authorizer allows every route of the stage.                                                                        | API Gateway caches its answer five minutes per token, not per route.                                                                                                                |
| A REST API, not the HTTP API the OrcaBus services use.                                                                 | HTTP APIs cannot stream, and stop at 30 seconds.                                                                                                                                    |
| The functions run outside a VPC.                                                                                       | They call only AWS APIs; Bedrock VPC endpoints would cost about $35 to $40 a month, nearly doubling the budget, so they wait for a security review that asks.                       |
| Prod's data is `RETAIN_ON_UPDATE_OR_DELETE`, not `RETAIN`.                                                             | After a failed first create, a kept resource would be an orphan, and its fixed name, such as the table's or the key alias, would block the retry.                                   |
| Replaced guardrail versions are kept.                                                                                  | Running functions use the old version until they read the new one, and the stateless stack names it as their fallback until its next deploy.                                        |
| Spend is read with three consistent `GetItem` calls, not one batch.                                                    | A throttled batch can come back without some counters, which would read as nothing spent.                                                                                           |
| `/documents/{id}` does not decode its ID.                                                                              | Hono has decoded it already; decoding it again would change or refuse IDs that contain `%`.                                                                                         |
| The budget backstop filters on `Amazon Bedrock`; `ALERT_EMAILS` is empty; `MIN_SCORE` is 0.                            | Open items waiting on a check or a decision, not oversights: [project.md](project.md#open-items).                                                                                   |
