---
inclusion: always
---

# Repository structure

Two packages in one pnpm workspace, with different module systems and test runners:

| Package         | Where  | What                                             | Modules    | Tests          |
| --------------- | ------ | ------------------------------------------------ | ---------- | -------------- |
| root (CDK app)  | `/`    | the infrastructure and its tests, run by ts-node | CommonJS   | Jest + cdk-nag |
| `orcasonar-app` | `app/` | the API and Lambda code, bundled by esbuild      | ES modules | Vitest         |

Each has its own `tsconfig.json`, ESLint and Prettier configuration. The root's configuration leaves `app/` out, so
only `make check-all` and `make test-all` cover both.

```text
orcasonar/
├── app/
│   ├── schema/openapi.yaml       # the API contract
│   └── src/
│       ├── app.ts                # Hono app: ROUTES, zod request schemas, errors, CORS, the SSE stream
│       ├── server.ts             # `make dev`: the app on 127.0.0.1:8787 with in-memory stores
│       ├── handlers/             # Lambda entry points: chat, query, audit, authorizer, ingest-mark, ingest-run
│       ├── services/             # the logic, behind interfaces, with no AWS imports
│       ├── aws/                  # AWS implementations of the interfaces; deps.ts wires them from the environment
│       ├── config/env.ts         # the functions' environment, parsed with zod
│       ├── lib/                  # error shape (errors.ts), IDs (ids.ts), Melbourne time (time.ts)
│       └── testing/fakes.ts      # in-memory implementations, sample passages, a scripted answer
├── bin/deploy.ts                 # CDK app: one toolchain stack per run, chosen by -c deployMode=stateful|stateless
├── infrastructure/
│   ├── environments.ts           # accounts: beta (dev), prod, toolchain
│   ├── shared/                   # platform.ts (accounts, shared SSM names, OrcaUI hosts), git-commit.ts
│   ├── stage/
│   │   ├── config.ts             # per-stage settings: origins, models, budget, access logs, alert emails
│   │   ├── constants.ts          # names both stacks share: SSM parameters, docs/ prefix, publisher role
│   │   ├── stateful-stack.ts     # KMS key, buckets, table, knowledge base, guardrail
│   │   ├── stateless-stack.ts    # API, WAF, authorizer, functions, ingestion schedule, alarms, budget
│   │   └── api-docs.ts           # OpenAPI JSON and Swagger UI served by API Gateway
│   └── toolchain/                # the two CodePipelines (deployment-pipeline.ts, stateful/stateless stacks)
├── test/                         # Jest: stage stacks with cdk-nag, toolchain stacks, pipeline construct
├── docs/                         # project, tech, design, architecture, api, deploy, runbook
└── .github/workflows/pr-tests.yml
```

## Where new code goes

- **Logic** goes in `app/src/services/`, behind a small interface (`Retriever`, `Answerer`, `SpendStore`,
  `ConversationStore`, `RecordStore`, `DocumentStore`, `IngestState`, `Ingestion`). Services import nothing from AWS.
- **A new AWS call** goes in `app/src/aws/`, behind an interface in `services/`, wired in `aws/deps.ts`, with an
  in-memory fake beside the others in `testing/fakes.ts`.
- **A route** is served by `createApp(deps)` in `app.ts`. The chat function runs it with `streamHandle`, the query and
  audit functions with `handle`; API Gateway decides which function gets which route.
- **Only the chat function has a model.** Only its environment names `ANSWER_MODEL_ID`, so other functions never build
  a Bedrock runtime client.
- The authorizer and the two ingestion functions are plain Lambda handlers, without Hono.
- **Per-stage settings** go in `infrastructure/stage/config.ts`, and names both stacks share in `constants.ts`, never
  inline in a stack.
- **Anything that holds data** goes in the stateful stack; everything else in the stateless stack. The stateless stack
  finds stateful resources through SSM parameters under `/orcasonar/`.
