---
inclusion: always
---

# Tech stack, commands and rules

## Stack

- TypeScript `~5.9.3`, strict in both packages; the app adds `noUncheckedIndexedAccess`.
- Node.js 24 (`nodejs24.x` on arm64). pnpm `10.34.5` through Corepack.
- AWS CDK v2 (`aws-cdk-lib`), `cdk-nag` v3 (AwsSolutions pack) as a validation plugin in the tests.
- Hono on Lambda (`@hono/aws-lambda`) and locally (`@hono/node-server`); zod v4 for request bodies and environment;
  `aws-jwt-verify` for Cognito ID tokens; AWS SDK v3.
- Jest + ts-jest for the infrastructure; Vitest + `aws-sdk-client-mock` for the app.
- ESLint 9 with typescript-eslint; Prettier 3; esbuild through `NodejsFunction`.
- Everything runs in ap-southeast-2; the `au.` profiles also send model calls to ap-southeast-4.

Versions are the ranges in `package.json`; `pnpm-lock.yaml` pins them. Functions bundle with `externalModules: []`, so
the AWS SDK they run is the one the tests ran. Dependency build scripts are off (`allowBuilds`, `--ignore-scripts`).

## Commands

| Command          | What it does                                                                 |
| ---------------- | ---------------------------------------------------------------------------- |
| `make install`   | install the workspace from the lockfile, and the pre-commit git hook         |
| `make check`     | `pnpm audit`, Prettier and ESLint outside `app/`, then every pre-commit hook |
| `make check-all` | `make check`, plus the app's type check, lint and format check               |
| `make test`      | infrastructure tests: `tsc --noEmit`, then Jest with cdk-nag                 |
| `make test-all`  | `make test`, plus the app's Vitest tests                                     |
| `make cdk-synth` | synthesize both toolchain stacks and every stage stack                       |
| `make fix`       | Prettier and ESLint fixes in both packages                                   |
| `make dev`       | the API on `http://127.0.0.1:8787/api/v1`, in memory, no AWS (long-running)  |

- Run `make check-all && make test-all` before declaring work done.
- One test file: `pnpm exec jest test/stage.test.ts` at the root, or `pnpm exec vitest run src/services/budget.test.ts`
  in `app/`. Never run Vitest in watch mode.
- `make dev` is a long-running server: ask the user to run it rather than running it yourself.
- No test calls AWS or needs credentials. Do not run `cdk deploy`, `cdk destroy` or any AWS command that changes an
  account unless the user explicitly asks.

## Style

- Prettier, the same in both packages: 100 columns, single quotes, semicolons, ES5 trailing commas, two spaces. It
  formats Markdown too, tables included, and `make check` fails on any file it would change, including files under
  `.kiro/`. Run `make fix` (or `pnpm prettier-fix`) after editing Markdown.
- ESLint: typescript-eslint recommended. The app requires `import type` for types (`consistent-type-imports`); the
  root warns on unused names unless they start with `_`.
- Comments say why, in full sentences, on exported names and on anything surprising, and name the document or finding
  behind a choice.
- Test names are sentences that say what the code does, such as "keeps the whole hold when the answer fails after the
  model accepted the request".

## Safety rules

- **Never commit** a real ARN, bucket name, token, or a person's email address. Account IDs appear only in
  `infrastructure/shared/platform.ts`. Deployed names come from SSM. `ALERT_EMAILS` takes team addresses only.
- Subresource Integrity hashes look like secrets to detect-secrets: mark them `// pragma: allowlist secret`, as
  `api-docs.ts` does.
- pre-commit blocks commits to `main`, `master` and `release/*`, AWS credentials, private keys, large files, invalid
  YAML, trailing whitespace and missing final newlines, and runs detect-secrets against `.secrets.baseline`, ESLint and
  Prettier. Work on a branch and open a pull request.
- Logs never hold the question, the answer or the reader's email (see the app steering for `log()` and `errorDetail`).

## CI and pipelines

- GitHub Actions (`.github/workflows/pr-tests.yml`) on pull requests and pushes to `main`: `make check` (without
  `no-commit-to-branch`), `make test`, `make cdk-synth`; `cd app && pnpm check && pnpm test`; a detect-secrets scan.
  Actions are pinned by commit SHA.
- The CodePipelines deploy `main`. Push filters choose the pipeline: `app/` starts only the stateless one; one stack's
  file starts only that stack's pipeline; `docs/` or Markdown starts neither; anything else (such as `config.ts` or the
  lockfile) starts both. In every account the stateful stack deploys first.
