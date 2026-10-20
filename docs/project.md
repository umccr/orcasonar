# Project

What OrcaSonar is for, who uses it, what release 1 covers, where it stands and what is still open: the place to start
for anyone joining the project, a person or a coding agent. [tech.md](tech.md) covers the stack and the conventions
for changing the code, and [design.md](design.md) the decisions and the reasons for them.

## What OrcaSonar is

OrcaBus runs the pipelines and workflows, OrcaHouse holds the data, and OrcaSonar finds the knowledge and
documentation behind them. A question goes down; passages and an answer come back, with links to where they came
from.

Release 1 does one job: it answers questions about UMCCR's documentation in the chat panel on
[docs.umccr.org](https://docs.umccr.org). A signed-in reader asks in the panel and gets a short answer that Claude
writes from the matching passages, with numbered citations that link to their pages. Search returns the passages
without writing an answer. Both go through one small API, `https://sonar.<stage>.umccr.org/api/v1`, described in
[api.md](api.md).

OrcaSonar answers only from the documentation it has indexed. When retrieval finds nothing, it says the documentation
does not cover the question, and no model is called. A guardrail refuses medical advice about a person and requests
for personal data about patients, and its grounding check flags answers the passages do not support.

## Who uses it

| Who                       | How                                                                                                                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Readers of docs.umccr.org | People signed in to the docs site through the `data-portal-<stage>` Cognito pool. The chat panel sends their ID token, issued to the `docs-app` client. Each reader has a daily cap and their own conversations, and the panel tells them questions are kept 30 days to improve answers. |
| The docs platform         | `umccr/docs-platform` builds docs.umccr.org and the chat panel. Each site's publish step exports its pages as Markdown, each with a metadata file, into OrcaSonar's ingest bucket as the `docs-publisher` role, the only writer.                                                         |
| The platform team         | Deploys OrcaSonar through its two pipelines, answers its alarms, holds its budget, and reviews the records each week for the evaluation set.                                                                                                                                             |
| Later callers             | Portal apps, a machine client, and AI agents through AgentCore Gateway. The design makes room for them; none is planned for a date.                                                                                                                                                      |

## Release 1, and what comes later

|             | Release 1                                                                           | Later, each when someone needs it                                                                                        |
| ----------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Callers     | the docs chat panel: ID tokens from the `docs-app` Cognito client                   | portal apps; a machine client, and AgentCore Gateway to offer the API to AI agents as MCP tools                          |
| Sources     | the UMCCR documentation docs.umccr.org exports, in one data source, `docs`          | OrcaBus API docs, OrcaHouse schemas or tables, OrcaBus APIs: each its own data source or tool, with its own access rules |
| Modes       | Ask, which answers with Claude, and Search, which returns passages without a model  | Plan: Claude Sonnet 5 with agentic retrieval, at about three times the cost of Ask                                       |
| Endpoints   | `/chat`, `/search`, `/documents/{id}`, `/feedback`; `/health` and the API docs open | `/sources`, what is indexed and when it was synced; `/usage`, the caller's allowance left today                          |
| Watching it | alarms on one alerts topic per stage, and the AWS Budgets backstop                  | a Synthetics canary, and a deeper one once a machine client can call `/chat`                                             |

## Where it fits

| Repository                        | What OrcaSonar takes from it, or gives it                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `umccr/docs-platform`             | The other side of the contract: the chat panel (`toolkit/src/umccr_docs/theme/assets/umccr/umccr.js`), the `export-kb` step that writes the documents and their metadata, the publish steps and the `docs-publisher` role. Its [ADR-0007](https://github.com/umccr/docs-platform/blob/main/docs/design/adr/0007-chat-through-orcasonar.md) records the decision to answer the chat through OrcaSonar. |
| `umccr/infrastructure`            | The Cognito user pool and the `docs-app` client (`cognito_aai`, `app_docs.tf`), and each account's CDK bootstrap (`scripts/aws_bootstrap`).                                                                                                                                                                                                                                                           |
| `OrcaBus/platform-cdk-constructs` | The npm package `@orcabus/platform-cdk-constructs`: UMCCR's account list, the SSM names of each account's certificate, hosted zone and user pool, and the stack output that names the deployed commit. The pipeline construct here is adapted from its `DeploymentStackPipeline` so that nothing is named for OrcaBus.                                                                                |
| OrcaBus and OrcaHouse             | The family OrcaSonar is named after, and the likely next sources of knowledge.                                                                                                                                                                                                                                                                                                                        |

The interfaces between OrcaSonar and docs.umccr.org, from the ingest bucket to CORS, are listed in the
[README](../README.md#contract-with-docsumccrorg). [tech.md](tech.md#change-these-together) lists what must change in
both repositories at once.

## Principles

Every change keeps to these. [design.md](design.md) has the reasons.

1. **The data stays in Australia, under our own key.** Everything runs in ap-southeast-2, and everything OrcaSonar
   stores, the index included, is encrypted with the Sonar KMS key. Answers come from Claude through the Australian
   (`au.`) inference profiles, which run in Sydney and Melbourne only. The knowledge base reads only the ingest
   bucket, and OrcaSonar calls nothing outside AWS.
2. **No code of ours runs without a valid token.** WAF filters first, API Gateway answers the open routes (`/health`
   and the API docs) itself, and every route that reaches a function needs the authorizer's approval. A stack test
   fails if an open route reaches a Lambda.
3. **Answers come from the documentation, with their sources.** With no passages there is no model call, and an
   answer's citations link to the pages it used.
4. **The budget counts dollars, not questions.** The month's budget is $50 in prod and $10 in beta. Before each answer
   the chat function holds the most it can cost, and settles the hold at the real cost afterwards. A team allowance
   per day and a cap of $0.40 a day per caller share the budget out, limits per request keep any one answer under
   about 8 cents, and AWS Budgets is the backstop. Search keeps working when the allowance is spent.
5. **Questions are kept 30 days, and never logged.** Each exchange is recorded for evaluation, then deleted after 30
   days. Logs hold the caller's Cognito `sub` and the outcome, never the question or the answer. The evaluation set
   keeps examples without reader IDs.
6. **The data outlives the API.** The stateful stack holds the key, the buckets, the table, the knowledge base and the
   guardrail. The stateless stack holds everything that changes often, and can be replaced without touching the data
   or the index.
7. **People make the decisions that bind UMCCR.** A model's licence terms, the account's Bedrock data-retention mode
   and who hears the alerts are decided by an administrator or the team, never by a deploy. The stacks cannot accept a
   model agreement, and the chat role has no permission to.

## Stages

| Stage | Account | API                                   | Docs hosts that call it                 | Month's budget |
| ----- | ------- | ------------------------------------- | --------------------------------------- | -------------- |
| beta  | dev     | `https://sonar.dev.umccr.org/api/v1`  | `docs.dev.umccr.org`                    | $10            |
| prod  | prod    | `https://sonar.prod.umccr.org/api/v1` | `docs.umccr.org`, `docs.prod.umccr.org` | $50            |

Two pipelines in the toolchain account, `UMCCR-OrcaSonarStateful` and `UMCCR-OrcaSonarStateless`, deploy one stack
each: to beta, then to prod after the `PromoteToProd` approval. The stg account runs no OrcaSonar stage: it was
dropped on 2026-10-21.

## Where it stands, on 2026-10-21

| Date       | Milestone                                                                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-09 | Designed: [design.md](design.md).                                                                                                                                                                                                                                                                                   |
| 2026-10-13 | The toolchain stacks and both pipelines deployed. In dev, the knowledge base and the guardrail created with the Sonar key, and the first ingestion jobs indexed `/platform/`'s documents.                                                                                                                           |
| 2026-10-15 | The chat panel answers in dev, after three fixes: the organisation's region policy allows ap-southeast-4, an account administrator accepted the Claude model agreements, and the chat function no longer sends `temperature`.                                                                                       |
| 2026-10-16 | The first release committed, on the branch `feat/orcasonar-initial`.                                                                                                                                                                                                                                                |
| 2026-10-21 | The stg stage dropped. A pre-production review stopped a call Bedrock refuses from keeping its hold, made the writes after an answer best-effort, searched for follow-ups with the question before them, added alarms on failed answers, writes, 5XX responses and ingestion, and set four WAF body rules to count. |

Today:

- **dev (beta)**: both stage stacks are deployed by hand from the branch, and the chat panel answers.
- **prod**: nothing is deployed. A read-only check on 2026-10-21 found no OrcaSonar resources there, and Claude
  Sonnet 5's agreement not yet accepted.
- **The pipelines** exist, but GitHub's `main` holds only the empty initial commit, so they have nothing to deploy
  until the branch is merged.

Next is the first deploy to prod, so that pilot users can try the chat panel on docs.umccr.org and give feedback. The
steps are in [deploy.md](deploy.md#step-7-prod); the open items below come first, or soon after.

## Open items

[architecture.md](architecture.md#open-items) has the details of each.

| Open item                                                                                                                                                            | Where it is decided                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| An administrator of the prod account accepts the Claude model agreements: Sonnet 5's was `NOT_AVAILABLE` on 2026-10-21. Until then every answer fails; search works. | [deploy.md](deploy.md#model-access)                                                                             |
| A team address or a Slack channel hears the alerts: nobody subscribes to the alerts topic yet.                                                                       | `ALERT_EMAILS` in `infrastructure/stage/config.ts`, or the AWS Chatbot channel ([deploy.md](deploy.md#alerts))  |
| Prod's API Gateway CloudWatch role is confirmed before its access logs are turned on.                                                                                | `ACCESS_LOGS` ([deploy.md](deploy.md#api-gateway-logging-optional))                                             |
| An organisation administrator sets the accounts' Bedrock data-retention mode to `none`, with an SCP that keeps it there. It is `inherit` in dev.                     | [deploy.md](deploy.md#data-retention)                                                                           |
| Whether the budget backstop sees Claude's cost, which AWS Marketplace bills under the model's name rather than as Amazon Bedrock.                                    | the `Budget` in `infrastructure/stage/stateless-stack.ts`                                                       |
| `MIN_SCORE`, the score below which passages are left out of an answer, is tuned on real questions. No stack sets it, so it is 0 and every passage counts.            | `app/src/config/env.ts`; set it in the chat function's environment in `infrastructure/stage/stateless-stack.ts` |
| Whether the guardrail keeps masking email addresses and phone numbers in answers, the contacts the documentation publishes included.                                 | the guardrail in `infrastructure/stage/stateful-stack.ts`                                                       |
| The guardrail's grounding check is confirmed to stop an answer the passages do not support.                                                                          | [architecture.md](architecture.md#open-items)                                                                   |
| AWS says where the managed knowledge base's embedding and reranking models run, before anything sensitive is indexed.                                                | [design.md](design.md#keeping-the-data-on-our-side)                                                             |
| A WAF allowlist of university and VPN ranges, or VPC endpoints for Bedrock, only if a security review asks.                                                          | [design.md](design.md#keeping-the-data-on-our-side)                                                             |

## Vocabulary

| Term                | Meaning                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| reader              | a person asking through the chat panel                                                                                                      |
| caller              | whoever a request's token belongs to: a reader's Cognito `sub`, or later a machine client's ID. Caps and conversations are per caller       |
| site, slug          | one docs site on docs.umccr.org, such as `platform`; its documents are under `docs/<slug>/` in the ingest bucket                            |
| `doc_id`            | a page's ID, `<slug>:<path>`, such as `platform:onboarding`: the same in the page's metadata, in citations and in `/documents/{id}`         |
| passage             | a piece of a page that retrieval returns, with its page's `doc_id`, `title`, `url` and `site`                                               |
| citation            | a passage the answer cites: `[n]` in the answer is the citation whose `ref` is n                                                            |
| exchange            | one question and its answer, `x_` and 32 hex characters; its record is kept 30 days                                                         |
| conversation, turn  | exchanges that follow one another, `c_` and 32 hex characters; each turn is kept 30 days, and the last six go to the model with a follow-up |
| Ask, Search, Plan   | Ask answers with Claude; Search returns passages without a model; Plan is a later mode                                                      |
| hold, settle        | the $0.10 held against the budget before an answer, and replacing it with what the answer cost                                              |
| allowance, cap      | what the team may spend today, the month's budget left over the days left; and what one caller may spend today, $0.40                       |
| stale mark          | the note in the table that documents changed since the index was last brought up to date                                                    |
| beta, prod          | the stages; beta runs in the dev account                                                                                                    |
| stateful, stateless | the two stacks in each stage: the data, and everything else                                                                                 |
| alerts topic        | the SNS topic that every alarm and the budget's notices go to                                                                               |

## Where to read more

| Page                               | For                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| [README](../README.md)             | the overview, the endpoints, the contract with docs.umccr.org and the `make` commands |
| [tech.md](tech.md)                 | the stack, how the code is laid out, and the conventions for changing it              |
| [design.md](design.md)             | the decisions, with their diagrams, costs and reasons                                 |
| [architecture.md](architecture.md) | what is deployed, component by component, and the open items                          |
| [api.md](api.md)                   | the API: requests, the stream, errors and limits                                      |
| [deploy.md](deploy.md)             | deploying, the manual steps in each account, and troubleshooting                      |
| [runbook.md](runbook.md)           | alarms, the budget, changing the model or the guardrail, the index, and the records   |
