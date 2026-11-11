---
inclusion: always
---

# OrcaSonar: what it is

OrcaSonar answers questions about UMCCR's documentation for the chat panel on docs.umccr.org, and for OrcaUI. A
signed-in reader asks; the chat function retrieves passages from a Bedrock managed knowledge base and Claude writes a
short answer with numbered citations that link to the pages. Search returns the passages without a model. Everything
goes through one API, `https://sonar.<stage>.umccr.org/api/v1`.

The full picture is in `docs/`. Read the page that covers the area before changing it:

| Page                      | For                                                                         |
| ------------------------- | --------------------------------------------------------------------------- |
| `docs/project.md`         | purpose, callers, release 1 scope, status, open items, vocabulary           |
| `docs/tech.md`            | stack, layout, conventions, "change these together", deliberate oddities    |
| `docs/design.md`          | decisions, diagrams, costs and the reasons for them                         |
| `docs/architecture.md`    | each deployed component, the request flow, ingestion, budget, privacy       |
| `docs/api.md`             | requests, the event stream, errors and limits                               |
| `docs/deploy.md`          | deploying, manual steps per account, troubleshooting                        |
| `docs/runbook.md`         | alarms, the budget, changing the model or guardrail, the index, the records |
| `app/schema/openapi.yaml` | the API contract                                                            |

## Principles every change keeps

1. **Data stays in Australia, under our own key.** Everything runs in ap-southeast-2 and is encrypted with the Sonar
   KMS key. Claude is called only through the `au.` inference profiles (Sydney and Melbourne). The knowledge base reads
   only the ingest bucket, and OrcaSonar calls nothing outside AWS.
2. **No code of ours runs without a valid token.** WAF filters first. API Gateway answers the open routes (`/health`,
   `/schema/openapi.json`, `/schema/swagger-ui/`) from mock integrations. Every route that reaches a Lambda needs the
   authorizer. A stack test fails if an open route reaches a Lambda.
3. **Answers come from the documentation, with sources.** No passages means no model call: the answer says the
   documentation does not cover the question.
4. **The budget counts dollars, not questions.** $50 a month in prod, $10 in beta. The chat function holds $0.10
   before an answer and settles it at the real cost. A daily team allowance, a $0.40 daily cap per caller and
   per-request limits keep any answer under about 8 cents; AWS Budgets is the backstop. Search keeps working when the
   allowance is spent.
5. **Questions are kept 30 days, and never logged.** Logs hold the caller's Cognito `sub` and the `outcome`, never the
   question, the answer or the email. The audit log (with email) is readable only by the audit group.
6. **The data outlives the API.** The stateful stack holds the key, buckets, table, knowledge base and guardrail. The
   stateless stack holds everything else and can be replaced without touching data or the index.
7. **People make the decisions that bind UMCCR.** Model licence agreements, Bedrock data-retention mode and alert
   subscribers are decided by administrators, never by a deploy. The chat role has no AWS Marketplace permissions.

## Stages

| Stage | Account | API                                   | Docs hosts                              | Budget |
| ----- | ------- | ------------------------------------- | --------------------------------------- | ------ |
| beta  | dev     | `https://sonar.dev.umccr.org/api/v1`  | `docs.dev.umccr.org`                    | $10    |
| prod  | prod    | `https://sonar.prod.umccr.org/api/v1` | `docs.umccr.org`, `docs.prod.umccr.org` | $50    |

There is no stg stage (dropped 2026-10-21). Two pipelines in the toolchain account, `UMCCR-OrcaSonarStateful` and
`UMCCR-OrcaSonarStateless`, deploy to beta, then to prod after the `PromoteToProd` approval. As of 2026-10-21, beta is
deployed by hand from a branch and answers; nothing is deployed to prod. `docs/project.md` lists the open items.

## Vocabulary

Use these terms consistently in code, tests and docs.

| Term                | Meaning                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| reader              | a person asking through the chat panel                                                          |
| caller              | whoever the token belongs to (a reader's `sub`, later a machine client ID); caps are per caller |
| site, slug          | one docs site, such as `platform`; its documents live under `docs/<slug>/` in the ingest bucket |
| `doc_id`            | a page's ID, `<slug>:<path>`, such as `platform:onboarding`                                     |
| passage             | a piece of a page returned by retrieval, with its `doc_id`, `title`, `url` and `site`           |
| citation            | a passage the answer cites; `[n]` in the answer is the citation whose `ref` is n                |
| exchange            | one question and its answer, `x_` + 32 hex characters                                           |
| conversation, turn  | exchanges that follow one another, `c_` + 32 hex characters; the last six turns go to the model |
| Ask, Search, Plan   | Ask answers with Claude; Search returns passages only; Plan is a later mode                     |
| hold, settle        | the $0.10 held before an answer, and replacing it with what the answer cost                     |
| allowance, cap      | the team's spend allowed today, and one caller's ($0.40)                                        |
| stale mark          | the table item saying documents changed since the index was last updated                        |
| stateful, stateless | the two stacks in each stage: the data, and everything else                                     |
