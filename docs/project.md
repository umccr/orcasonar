# Project

What OrcaSonar is for, who uses it, what release 1 covers, where it stands and what is still open. Start here;
[tech.md](tech.md) covers the code and its conventions, and [design.md](design.md) the decisions behind it.

## What OrcaSonar is

OrcaBus runs the pipelines and workflows, OrcaHouse holds the data, and OrcaSonar finds the knowledge and
documentation behind them.

Release 1 answers questions about UMCCR's documentation in the chat panel on [docs.umccr.org](https://docs.umccr.org)
and in OrcaUI. A signed-in reader asks, and Claude writes a short answer from the matching passages, with numbered
citations that link to their pages. Search returns the passages without a model. Both go through one API,
`https://sonar.<stage>.umccr.org/api/v1` ([api.md](api.md)).

OrcaSonar answers only from what it has indexed: when retrieval finds nothing, it says so and calls no model. A
[guardrail](guardrail.md) refuses medical advice about a person and requests for personal data about patients, and its grounding
check flags answers the passages do not support.

## Who uses it

| Who                       | How                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Readers of docs.umccr.org | Signed in through the `data-portal-<stage>` Cognito pool; the chat panel sends their ID token. Each has a daily cap and their own history. |
| OrcaUI users              | The same pool, through OrcaUI's app client, on portal.umccr.org and orcaui.umccr.org.                                                      |
| The docs platform         | Each site's publish step exports its pages, with a metadata file each, into the ingest bucket as `docs-publisher`, the only writer.        |
| The platform team         | Deploys OrcaSonar, answers its alarms, holds its budget, reads the audit log and reviews the records weekly for the evaluation set.        |

## Release 1, and what comes later

|           | Release 1                                                                                                         | Later, when someone needs it                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Callers   | the docs chat panel and OrcaUI; in beta, also the `localhost` client for portal apps run locally                  | other portal apps, a machine client, AgentCore Gateway offering the API to agents as MCP tools |
| Sources   | the documentation docs.umccr.org exports, in one data source, `docs`                                              | OrcaBus API docs, OrcaHouse schemas, OrcaBus APIs, each with its own access rules              |
| Modes     | Ask, answered by Claude; Search, passages without a model                                                         | Plan: Claude with agentic retrieval, at about three times the cost of Ask                      |
| Endpoints | `/chat`, `/chat/history`, `/search`, `/documents/{id}`, `/feedback`, `/audit/*`; `/health` and the API docs, open | `/sources`, what is indexed; `/usage`, the caller's allowance left today                       |
| Watching  | alarms on one alerts topic per stage, and the AWS Budgets backstop                                                | a Synthetics canary                                                                            |

## Where it fits

| Repository                        | What OrcaSonar takes from it, or gives it                                                                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `umccr/docs-platform`             | The publish steps and the `docs-publisher` role. Its [ADR-0007](https://github.com/umccr/docs-platform/blob/main/docs/design/adr/0007-chat-through-orcasonar.md) chose to answer through OrcaSonar. |
| `umccr/docs-toolkit`              | The chat panel (`src/umccr_docs/theme/assets/umccr/umccr.js`) and `export-kb`, which writes the documents and their metadata.                                                                       |
| `umccr/infrastructure`            | The Cognito user pool and its app clients (`cognito_aai`), and each account's CDK bootstrap (`scripts/aws_bootstrap`).                                                                              |
| `OrcaBus/platform-cdk-constructs` | UMCCR's accounts, shared SSM names and OrcaUI's hosts, copied from 1.9.11 into `infrastructure/shared/platform.ts` and followed by hand; the pipeline construct is adapted from it.                 |

The interfaces with docs.umccr.org are in the [README](../README.md#contract-with-docsumccrorg), and what must change
in both repositories at once is in [tech.md](tech.md#change-these-together).

## Principles

Every change keeps to these; [design.md](design.md) has the reasons.

1. **The data stays in Australia, under our own key.** Everything runs in ap-southeast-2 and is encrypted with the
   Sonar KMS key, the index included. Claude is called only through the `au.` inference profiles, which run in Sydney
   and Melbourne. The knowledge base reads only the ingest bucket, and nothing outside AWS is called.
2. **No code of ours runs without a valid token.** WAF filters first, API Gateway answers the open routes itself, and
   every route that reaches a function needs the authorizer. A stack test fails if an open route reaches a Lambda.
3. **Answers come from the documentation, with their sources.** No passages means no model call.
4. **The budget counts dollars, not questions.** $50 a month in prod and $10 in beta, shared out by a team allowance
   per day, a cap of $0.40 a day per caller and per-request limits that keep any answer under about 8 cents. AWS
   Budgets is the backstop, and Search keeps working when the allowance is spent.
5. **Questions are kept 30 days, and never logged.** Logs hold the caller's `sub` and the outcome, never the question,
   the answer or the email. The audit log keeps the email for the audit group only.
6. **The data outlives the API.** The stateful stack holds the key, buckets, table, knowledge base and guardrail; the
   stateless stack holds everything else and can be replaced without touching them.
7. **People make the decisions that bind UMCCR.** Model licence terms, Bedrock's data-retention mode and who hears the
   alerts are decided by an administrator or the team, never by a deploy; the chat role has no AWS Marketplace
   permissions.

## Stages

| Stage | Account | API                                   | Docs hosts that call it                 | Month's budget |
| ----- | ------- | ------------------------------------- | --------------------------------------- | -------------- |
| beta  | dev     | `https://sonar.dev.umccr.org/api/v1`  | `docs.dev.umccr.org`                    | $10            |
| prod  | prod    | `https://sonar.prod.umccr.org/api/v1` | `docs.umccr.org`, `docs.prod.umccr.org` | $50            |

Each stack's pipeline deploys to beta, then to prod after approval ([deploy.md](deploy.md)). There is no stg stage.

## Where it stands

| Date       | Milestone                                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-09 | Designed ([design.md](design.md)).                                                                                                                                     |
| 2026-10-13 | The pipelines deployed; in dev, the knowledge base and guardrail created and the first documents indexed.                                                              |
| 2026-10-15 | The chat panel answers in dev, once the region policy allowed ap-southeast-4, the Claude agreements were accepted and the chat function stopped sending `temperature`. |
| 2026-10-21 | stg dropped; a pre-production review fixed holds, made writes after an answer best-effort, added alarms and set four WAF body rules to count.                          |
| 2026-10-27 | The first release merged to `main` (pull request #2).                                                                                                                  |
| 2026-10-29 | The audit log API (#3); OrcaUI as a caller, with UMCCR's platform names copied into this repository (#4).                                                              |
| 2026-10-30 | `docs/` published at docs.umccr.org/orcasonar/ (#5).                                                                                                                   |
| 2026-11-12 | Readers' chat history, audit conversations, and the `localhost` client in beta (#6).                                                                                   |

The accounts were last checked on 2026-10-21, before the merge to `main`. dev (beta) had both stage stacks, deployed
by hand from the branch, and answered; prod had nothing deployed, and Claude Sonnet 5's agreement was not accepted.
Each merge since starts the pipelines, so check both accounts before relying on this. Next is the first deploy to
prod, for pilot users ([deploy.md](deploy.md#step-7-prod)), with the open items below first or soon after.

## Open items

[architecture.md](architecture.md#open-items) has the details.

| Open item                                                                                                                            | Where it is decided                                            |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| An administrator accepts the Claude model agreements in prod. Until then every answer fails; search works.                           | [deploy.md](deploy.md#model-access)                            |
| A team address or a Slack channel hears the alerts; nobody subscribes to the alerts topic yet.                                       | `ALERT_EMAILS`, or AWS Chatbot ([deploy.md](deploy.md#alerts)) |
| An organisation administrator sets Bedrock's data-retention mode to `none`, with an SCP; it is `inherit` in dev.                     | [deploy.md](deploy.md#data-retention)                          |
| Whether the budget backstop sees Claude's cost, which AWS Marketplace bills under the model's name.                                  | the `Budget` in `stateless-stack.ts`                           |
| `MIN_SCORE`, below which passages are left out, is tuned on real questions; unset, every passage counts.                             | the chat function's environment                                |
| Whether the guardrail keeps masking email addresses and phone numbers in answers, the contacts the docs publish included.            | [guardrail.md](guardrail.md#open-items)                        |
| The grounding check is confirmed to stop an answer the passages do not support.                                                      | [guardrail.md](guardrail.md#open-items)                        |
| The chat panel's notice says administrators can review questions with the reader's email, before the audit log reaches prod readers. | `umccr/docs-toolkit`                                           |
| Beta's audit log returns to the `admin` group before readers outside the platform team use beta.                                     | `AUDIT_GROUP` in `config.ts`                                   |
| AWS says where the managed knowledge base's embedding and reranking models run, before anything sensitive is indexed.                | [design.md](design.md#keeping-the-data-on-our-side)            |
| A WAF allowlist of university and VPN ranges, or VPC endpoints for Bedrock, only if a security review asks.                          | [design.md](design.md#keeping-the-data-on-our-side)            |

## Vocabulary

| Term                | Meaning                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| reader              | a person asking through the chat panel                                                                             |
| caller              | whoever a token belongs to: a reader's Cognito `sub`, later a machine client's ID; caps are per caller             |
| site, slug          | one docs site, such as `platform`; its documents are under `docs/<slug>/` in the ingest bucket                     |
| `doc_id`            | a page's ID, `<slug>:<path>`, such as `platform:onboarding`, the same in metadata, citations and `/documents/{id}` |
| passage             | a piece of a page that retrieval returns, with its page's `doc_id`, `title`, `url` and `site`                      |
| citation            | a passage the answer cites: `[n]` in the answer is the citation whose `ref` is n                                   |
| exchange            | one question and its answer, `x_` and 32 hex characters                                                            |
| conversation, turn  | exchanges that follow one another, `c_` and 32 hex characters; the last six turns go to the model                  |
| Ask, Search, Plan   | Ask answers with Claude; Search returns passages without a model; Plan is a later mode                             |
| hold, settle        | the $0.10 held against the budget before an answer, and replacing it with what the answer cost                     |
| allowance, cap      | what the team may spend today, the month's budget left over the days left; what one caller may spend, $0.40        |
| stale mark          | the note in the table that documents changed since the index was last brought up to date                           |
| beta, prod          | the stages; beta runs in the dev account                                                                           |
| stateful, stateless | the two stacks in each stage: the data, and everything else                                                        |
| alerts topic        | the SNS topic that every alarm and the budget's notices go to                                                      |
