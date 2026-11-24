# OrcaSonar

OrcaBus runs the pipelines and workflows, OrcaHouse holds the data, and OrcaSonar finds the knowledge and
documentation behind them. Release 1 answers questions about UMCCR's documentation for the chat panel on
[docs.umccr.org](https://docs.umccr.org) and for OrcaUI, through one API at `https://sonar.<stage>.umccr.org/api/v1`.
Claude writes each answer from passages that a Bedrock managed knowledge base retrieves, with numbered citations that
link to the pages. Everything stays in Australia under OrcaSonar's own KMS key, and questions are kept 30 days and
never logged ([data and privacy](docs/architecture.md#data-and-privacy)).

## How it fits together

```text
docs.umccr.org chat panel, OrcaUI ──HTTPS──▶ AWS WAF ─▶ API Gateway REST API ─▶ Lambda authorizer (Cognito ID token)
                                                  │
                                                  ├─ POST /chat (streamed) ─▶ chat Lambda ─▶ budget (DynamoDB)
                                                  │                                       ─▶ knowledge base: Retrieve
                                                  │                                       ─▶ Claude on Bedrock, with the guardrail
                                                  │                                       ─▶ 30-day records (S3)
                                                  ├─ /search, /documents/{id}, /feedback, /chat/history ─▶ query Lambda
                                                  ├─ /audit/* (audit group only) ─▶ audit Lambda ─▶ audit log (DynamoDB)
                                                  └─ /health, /schema/* ─▶ API Gateway itself: no token, no Lambda

docs site pipeline ─▶ ingest bucket docs/<slug>/ ─▶ (every 15 minutes, if changed) ingestion job ─▶ knowledge base
```

| Piece                                                                       | Where                                                                 |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| API, WAF, authorizer, functions, ingestion schedule, alarms, budget         | `OrcaSonarStatelessStack` (`infrastructure/stage/stateless-stack.ts`) |
| Sonar KMS key, ingest and records buckets, table, knowledge base, guardrail | `OrcaSonarStatefulStack` (`infrastructure/stage/stateful-stack.ts`)   |
| The API and functions: Hono on Node.js 24                                   | `app/`                                                                |
| Two pipelines, one per stack: beta, then prod after approval                | `infrastructure/toolchain/`                                           |

Every route but `/health` and the API docs needs a Cognito ID token from an allowed app client. The contract is
[app/schema/openapi.yaml](app/schema/openapi.yaml), browsable on each stage at `/schema/swagger-ui/`, as on
[sonar.dev.umccr.org](https://sonar.dev.umccr.org/schema/swagger-ui/).

## Documentation

| Page                                    | For                                                     |
| --------------------------------------- | ------------------------------------------------------- |
| [project.md](docs/project.md)           | purpose, callers, scope, status, open items, vocabulary |
| [design.md](docs/design.md)             | decisions and their reasons, diagrams, costs            |
| [architecture.md](docs/architecture.md) | what is deployed, the request flow, budget, privacy     |
| [guardrail.md](docs/guardrail.md)       | what the guardrail checks, how, and testing it          |
| [api.md](docs/api.md)                   | requests, the event stream, errors and limits           |
| [tech.md](docs/tech.md)                 | the stack, the layout, conventions for changing it      |
| [deploy.md](docs/deploy.md)             | deploying, manual steps per account, troubleshooting    |
| [runbook.md](docs/runbook.md)           | alarms, the budget, the model, the index                |

## Contract with docs.umccr.org

| Interface     | Value                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Ingest bucket | in SSM as `/orcasonar/ingest-bucket-name`, which the docs publish steps read                                              |
| Writer        | the docs platform's `role/docs/docs-publisher`, in the same account, under `docs/` only; its own policy grants the access |
| Documents     | `docs/<slug>/<path>.md`, each with `<path>.md.metadata.json`: `doc_id`, `site`, `title`, `url`, `commit`, `updated`       |
| API URL       | `https://sonar.<stage>.umccr.org/api/v1`, also in SSM as `/orcasonar/api-url`                                             |
| CORS          | `docs.dev.umccr.org` in beta; `docs.umccr.org` and `docs.prod.umccr.org` in prod                                          |

## Development

Node.js 24, pnpm through Corepack, and [pre-commit](https://pre-commit.com):

```sh
corepack enable
make install          # the pnpm workspace, app included, and the pre-commit git hook
make check-all        # dependency audit, formatting, lint and type checks, both packages
make test-all         # jest with cdk-nag for the infrastructure, vitest for the app
make dev              # the API on http://127.0.0.1:8787/api/v1, in memory, with no AWS access
```

`make dev` answers from sample passages with a scripted answer, so the chat panel can be developed against it:

```sh
curl -N -H 'Accept: text/event-stream' -H 'Content-Type: application/json' \
  -d '{"query":"How do I add a site?"}' http://127.0.0.1:8787/api/v1/chat
```

[docs/tech.md](docs/tech.md#commands) lists every command.

## Published site

`docs/` is published at <https://docs.umccr.org/orcasonar/> for UMCCR staff, and its pages are in the knowledge base
the chat panel answers from. docs.umccr.org's own pipeline publishes each push to `main` that changes `docs/` or
`mkdocs.yml`; a failed build leaves the site as it was. [project.md](docs/project.md) is the front page, and a link
from `docs/` to a file outside it opens the file on GitHub. To preview, install the docs toolkit
([onboarding](https://docs.umccr.org/platform/onboarding/#2-add-the-configuration)) and run `umccr-docs serve`.
