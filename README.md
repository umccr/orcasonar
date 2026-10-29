# OrcaSonar

OrcaBus runs the pipelines and workflows, OrcaHouse holds the data, and OrcaSonar finds the knowledge and
documentation behind them. A question goes down; passages and an answer come back, with links to where they came
from.

The first release answers questions about UMCCR documentation for the chat panel on
[docs.umccr.org](https://docs.umccr.org), through one small API at `https://sonar.<stage>.umccr.org/api/v1`.

## How it fits together

```text
docs.umccr.org chat panel, OrcaUI ──HTTPS──▶ AWS WAF ─▶ API Gateway REST API ─▶ Lambda authorizer (Cognito ID token)
                                                  │
                                                  ├─ POST /chat (streamed) ─▶ chat Lambda ─▶ budget (DynamoDB)
                                                  │                                       ─▶ managed knowledge base: Retrieve
                                                  │                                       ─▶ Claude on Bedrock, with the guardrail
                                                  │                                       ─▶ 30-day records (S3)
                                                  ├─ /search, /documents/{id}, /feedback ─▶ query Lambda
                                                  ├─ /audit/* (admin group only) ─▶ audit Lambda ─▶ audit log (DynamoDB)
                                                  └─ /health, /schema/swagger-ui/, /schema/openapi.json ─▶ API Gateway itself:
                                                     no token and no Lambda

docs site pipeline ─▶ ingest bucket docs/<slug>/ ─▶ (every 15 minutes, if changed) ingestion job ─▶ knowledge base
```

| Piece                                                                                        | Where                                                                 |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| API, authorizer, Lambdas, WAF, ingestion scheduling, budget backstop                         | `OrcaSonarStatelessStack` (`infrastructure/stage/stateless-stack.ts`) |
| Sonar KMS key, ingest and records buckets, DynamoDB table, managed knowledge base, guardrail | `OrcaSonarStatefulStack` (`infrastructure/stage/stateful-stack.ts`)   |
| The API and functions (Hono on Node.js 24)                                                   | `app/`                                                                |
| Pipelines: beta, then prod after approval                                                    | `infrastructure/toolchain/`                                           |

See [docs/design.md](docs/design.md) for the design and its diagrams, [docs/architecture.md](docs/architecture.md)
for what is deployed, [docs/api.md](docs/api.md) for the API, [docs/deploy.md](docs/deploy.md) for deploying it and
[docs/runbook.md](docs/runbook.md) for operating it.

## The API

| Endpoint                     | What it does                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/chat`          | Answers a question from the documentation, with the pages it used. Streams server-sent events with `Accept: text/event-stream`. |
| `POST /api/v1/search`        | The best-matching passages, without writing an answer.                                                                          |
| `GET /api/v1/documents/{id}` | A page as the docs platform exported it; `id` is a citation's `<site>:<path>`.                                                  |
| `POST /api/v1/feedback`      | A thumbs up or down on an answer.                                                                                               |
| `GET /api/v1/health`         | Whether the API is up. No token.                                                                                                |
| `GET /schema/swagger-ui/`    | The API's documentation, in Swagger UI. No token.                                                                               |
| `GET /schema/openapi.json`   | The OpenAPI contract as JSON. No token.                                                                                         |

Every endpoint under `/api/v1` but `/health` needs a Cognito ID token from an allowed app client in
`Authorization: Bearer`. It accepts the docs platform's `docs-app` client and OrcaUI's app client. The open routes are answered by
API Gateway itself, so no Lambda runs without a token. The contract is
[app/schema/openapi.yaml](app/schema/openapi.yaml), browsable at
[sonar.dev.umccr.org/schema/swagger-ui/](https://sonar.dev.umccr.org/schema/swagger-ui/) and the same path on each
stage.

## Contract with docs.umccr.org

| Interface     | Value                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Ingest bucket | written to SSM as `/orcasonar/ingest-bucket-name`; the docs publish steps read it                                                       |
| Writer        | the docs platform's `role/docs/docs-publisher` in the same account, under `docs/` only; its own policy grants the access                |
| Documents     | `docs/<slug>/<path>.md` with `<path>.md.metadata.json` (`doc_id`, `site`, `title`, `url`, `commit`, `updated`, typed string attributes) |
| API URL       | `https://sonar.<stage>.umccr.org/api/v1`, also written to SSM as `/orcasonar/api-url`                                                   |
| CORS          | `docs.dev.umccr.org` in beta, `docs.umccr.org` and `docs.prod.umccr.org` in prod                                                        |

## Pipelines

Each stack has its own pipeline in the toolchain account, `UMCCR-OrcaSonarStateful` and `UMCCR-OrcaSonarStateless`,
built by `infrastructure/toolchain/deployment-pipeline.ts`: the construct docs.umccr.org's pipeline uses too, adapted
from the OrcaBus service template's so that nothing is named for OrcaBus. Each deploys its stack,
`UMCCR-OrcaSonarStatefulStack` or `UMCCR-OrcaSonarStatelessStack`, to beta (dev), then prod after a `PromoteToProd`
approval, and posts failures to Slack. The stg account runs no OrcaSonar stage.

## Development

Node.js 24 and pnpm through Corepack, and [pre-commit](https://pre-commit.com):

```sh
corepack enable
make install          # the whole pnpm workspace, app included, and the git hook for the pre-commit hooks
make check            # dependency audit, formatting, lint and the pre-commit hooks
make check-all        # the same, plus the app's lint, formatting and type checks
make test-all         # jest with cdk-nag for the infrastructure, vitest for the app
make cdk-list         # the toolchain stacks and the stage stacks they deploy
make cdk-synth        # both toolchain stacks
make dev              # the API locally, with in-memory stores, on http://127.0.0.1:8787/api/v1
make fix              # formatting and lint fixes, infrastructure and app
make audit-fix        # overrides forcing patched dependency versions
```

`make dev` needs no AWS access: it uses sample passages and a scripted answer, so the chat panel and the stream
can be developed against it.

```sh
curl -N -H 'Accept: text/event-stream' -H 'Content-Type: application/json' \
  -d '{"query":"How do I add a site?"}' http://127.0.0.1:8787/api/v1/chat
```

## Data and privacy

Everything OrcaSonar stores is encrypted with one Sonar KMS key, in ap-southeast-2. Answers come from Claude through
the Australian cross-Region inference profile, which runs in Sydney and Melbourne only. Questions and answers are
kept 30 days for evaluation and then deleted; logs hold the caller's Cognito `sub` and the outcome, never the
question. See [docs/architecture.md](docs/architecture.md#data-and-privacy).
