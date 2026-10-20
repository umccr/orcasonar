# Architecture

OrcaSonar answers questions about UMCCR documentation. Release 1 has one caller, the chat panel on docs.umccr.org,
and one source, the pages docs.umccr.org publishes. Both are designed to grow: more callers join the authorizer's
client list, and more sources become more knowledge base data sources.

## Components

| Component              | Stack     | What it does                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AWS WAF                | stateless | AWS managed rule groups (IP reputation, common rules, known bad inputs) and a rate limit of 300 requests per five minutes per address, in front of the whole API. The common rules that look for paths, HTML and addresses in a request body only count: a question is text for the model, and they blocked questions about `../` links, HTML tags and internal URLs (dev, 2026-10-21).                |
| API Gateway REST API   | stateless | Regional, at `sonar.<stage zone>` on the stage's existing certificate. A REST API rather than the HTTP API OrcaBus services use, because HTTP APIs cannot stream and stop at 30 seconds. The default `execute-api` endpoint is disabled. Answers the open routes itself, from mock integrations: `/api/v1/health`, and the API docs at `/schema/swagger-ui/` and `/schema/openapi.json`.               |
| Lambda authorizer      | stateless | A TOKEN authorizer. Verifies a Cognito ID token from the `data-portal-<stage>` pool, issued to an allowed client, with `aws-jwt-verify`. Passes the caller's `sub` and client ID on; cached five minutes per token.                                                                                                                                                                                    |
| Chat Lambda            | stateless | `POST /chat`, invoked with response streaming. Holds the most an answer can cost against the budget, loads the conversation, retrieves passages (for a follow-up, with the question it follows), calls Claude with the guardrail (its version read from SSM every five minutes), streams server-sent events, then settles the hold at the answer's cost and records the exchange.                      |
| Query Lambda           | stateless | `/search`, `/documents/{id}` and `/feedback`, answered as JSON. Like the chat Lambda, it is reachable only through the authorizer.                                                                                                                                                                                                                                                                     |
| Ingestion Lambdas      | stateless | One marks the index stale when an object under `docs/` changes; the other runs every 15 minutes, follows the job it started last, and starts one if the index is still stale and no job is running.                                                                                                                                                                                                    |
| Budget backstop        | stateless | An AWS Budgets monthly budget on Bedrock that notifies at 80% and, at 100%, attaches a policy denying Bedrock to the chat role.                                                                                                                                                                                                                                                                        |
| Alarms and alerts      | stateless | Alarms on failed answers and on writes the chat Lambda logs rather than throws, the API's 5XX responses, Lambda crashes and timeouts, and ingestion. Each notifies one alerts topic as it fires and as it clears, as the budget's notices do. A team address subscribes by email (`ALERT_EMAILS` in `infrastructure/stage/config.ts`), or the topic joins the account's AWS Chatbot channel for Slack. |
| Sonar KMS key          | stateful  | Encrypts the buckets, the table and the knowledge base's index. Rotated yearly.                                                                                                                                                                                                                                                                                                                        |
| Ingest bucket          | stateful  | The knowledge base's only input. Only the docs platform's `docs-publisher` role writes, and only under `docs/`. Versioned.                                                                                                                                                                                                                                                                             |
| Managed knowledge base | stateful  | AWS-managed vector store, managed embeddings, hybrid search and the managed reranker. One data source, `docs`, on the ingest bucket's `docs/` prefix.                                                                                                                                                                                                                                                  |
| Guardrail              | stateful  | Denied topics (medical advice about a person, personal data about patients), personal-data masking, and a grounding check against the retrieved passages.                                                                                                                                                                                                                                              |
| Records bucket         | stateful  | One JSON record per exchange under `records/`, and feedback under `feedback/`, deleted after 30 days. `eval-set/` is kept.                                                                                                                                                                                                                                                                             |
| DynamoDB table         | stateful  | Spend counters, conversation turns (30 days) and the ingestion state.                                                                                                                                                                                                                                                                                                                                  |

The stateful stack keeps everything that holds data, so API changes never touch it. The stateless stack finds the
stateful resources through SSM parameters under `/orcasonar/`.

## A question

1. The chat panel posts `{query, conversationId?, sites?}` to `/api/v1/chat` with the reader's ID token and
   `Accept: text/event-stream`.
2. WAF applies its rules; API Gateway answers CORS preflight for the docs hosts; the authorizer verifies the token.
3. The chat Lambda checks today's spend against the team's allowance and the reader's cap, and holds the most an
   answer can cost against both in one conditional write. Over either, it answers `429` with `Retry-After` until
   midnight in Melbourne.
4. It sends `meta` (`exchangeId`, `conversationId`), loads the conversation's last six turns, and retrieves the top
   eight passages, filtered on `site` when the panel limits the question to one site. A follow-up such as "and in
   prod?" names little to search for, so it is searched for with the question it follows.
5. With no passages, it says the documentation does not cover the question, without calling the model.
6. Otherwise it calls Claude through `ConverseStream` with the guardrail, the passages as the grounding source and
   the question as the query, and streams each piece of the answer as a `delta` event.
7. It prices the exchange from the tokens used and settles the hold at that cost, sends `citations` (the passages
   the answer cites, by number), saves the turn and writes the record, then sends `done` (token usage). A turn or
   record that fails to save is logged as `write-error` and raises an alarm, but cannot fail an answer the reader
   already has: `done` still follows.
8. If answering fails, the hold settles at what is known to be spent: nothing before retrieval, the retrieval until
   Bedrock accepts the model call, and the whole hold once it has. A call Bedrock refuses, as for missing model access
   or throttling, bills nothing, so it costs the reader only the retrieval.

## Ingestion

The docs platform's publish steps upload each site's pages as processed Markdown with metadata files under
`docs/<slug>/`, and delete documents for removed pages. Every change marks the index stale, with the change's event
ID. Every 15 minutes, if it is stale and no job is running, one ingestion job starts, and the mark it covers is kept
with it. The mark is cleared only when that job completes, and only if no newer change has marked the index since;
otherwise the next run starts another job. A job that fails or is stopped leaves the mark, so the next run tries
again, and raises `IngestJobsFailedAlarm`. Jobs on one data source cannot overlap, and many sites can publish at once,
so jobs are never started per change. A push is usually searchable within about 20 minutes.

Later sources (OrcaBus API docs, OrcaHouse schemas) get their own data sources and their own access rules rather
than sharing `docs`.

## Budget

The chat Lambda counts dollars, not questions: Bedrock returns the tokens each answer used, and the Lambda prices
them with the model's rates, plus retrieval and the guardrail.

- **Team allowance per day**: what is left of the month's budget, divided by the days left in the month, today
  included. Unused budget carries forward.
- **Caller cap per day**: $0.40, about 20 answers.
- **Per-request limits**: 2,000 characters of question, six turns of history, eight passages and 1,000 output
  tokens keep the most expensive answer under about 8 cents.
- **Holds**: before an answer, $0.10, more than any answer can cost, is added to the caller's and the team's spend in
  one DynamoDB transaction, conditional on both being under their limits; the answer's cost then replaces it. Answers
  asked at the same moment, on any number of Lambda instances, cannot all pass a check that each would pass alone, so
  a caller goes over a limit by one answer at most. An answer that fails once Bedrock has accepted the model call
  keeps the whole hold, because its tokens may be billed without being reported; a call Bedrock refuses bills
  nothing, and costs only the retrieval.
- **Backstop**: the AWS Budgets action. Budgets data updates only a few times a day, so the Lambda's own counters
  are the real control.

The month's budget is $50 in prod and $10 in beta (`infrastructure/stage/config.ts`).

## Records and evaluation

Each exchange is written to `records/date=YYYY-MM-DD/<exchangeId>.json`: the question, the answer, the cited
documents and scores, the model, tokens, cost, response time, whether the guardrail intervened, and the caller's
`sub`. Feedback is written separately under `feedback/`. Both are deleted after 30 days. A weekly review copies
thumbs-down answers and good examples, without caller IDs, into `eval-set/`, which is kept and used to test changes
to the model, the prompt or retrieval before they ship.

## Data and privacy

| Data                            | Where it lives                         | Control                                                                                   |
| ------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| Source documents                | the ingest bucket, Sydney              | public access blocked; Sonar KMS key; only `docs-publisher` writes                        |
| The index                       | Bedrock's managed vector store, Sydney | encrypted with the Sonar KMS key; AWS-managed storage, not a resource in this account     |
| Embedding and reranking         | service-managed models                 | AWS does not say where these run; confirm before indexing anything sensitive              |
| Questions and answers in flight | Claude through the `au.` profile       | Sydney and Melbourne only; Bedrock keeps no prompts or answers and does not train on them |
| Records, turns, spend           | the records bucket and the table       | Sonar KMS key; deleted after 30 days                                                      |
| Logs                            | CloudWatch                             | the caller's `sub`, the outcome and the cost; never the question or the answer            |

Outside this repository, an administrator should set the account's Bedrock data-retention mode to `none` in
ap-southeast-2 and add an SCP that stops anyone changing it, so models that require retention refuse to run. The
chat role may call only the `au.` profiles for Claude Sonnet 5 and Haiku 4.5 and the models behind them in Sydney and
Melbourne.

The API is internet-facing because readers' browsers call it, but every endpoint except `/health` and the API docs
needs a token, behind WAF and throttling. API Gateway answers the open routes itself, from mock integrations, so no
function runs for a request without a valid token: Security Hub flags a Lambda that an API Gateway method reaches
without authorization, and a stack test keeps every Lambda integration behind the authorizer.

## Open items

- The inference profile IDs (`ANSWER_MODEL_ID`, `ALLOWED_MODEL_IDS`) are confirmed in dev (2026-10-12). Confirm
  them in prod with `aws bedrock list-inference-profiles`.
- Answers stream with the guardrail applied in sync mode (dev, 2026-10-15). Still confirm that its grounding check
  stops an answer the passages do not support.
- The knowledge base and the guardrail create with the Sonar key, and the first ingestion jobs indexed `/platform/`'s
  documents from the KMS-encrypted bucket (dev, 2026-10-13).
- API Gateway access and execution logs need the account-level CloudWatch role. dev has one, set by another stack
  (2026-10-12), and writes access logs; `ACCESS_LOGS` in `infrastructure/stage/config.ts` keeps them off in prod
  until `aws apigateway get-account` shows the role there.
- The budget backstop filters on the service `Amazon Bedrock`, but Anthropic's models are billed through AWS
  Marketplace under their own names, so the budget may never see Claude's cost. Check where the first answers' cost
  appears in Cost Explorer and filter on that; AWS Budgets can also filter on Bedrock's model and provider since
  October 2026.
- Nobody subscribes to the alerts topic yet, which carries every alarm and the budget's notices: set a team address
  in `ALERT_EMAILS` (`infrastructure/stage/config.ts`), or add the topic, the stateless stack's `AlertsTopicArn`
  output, to the account's AWS Chatbot channel for Slack.
- The account's Bedrock data-retention mode is `inherit` in dev, not `none` (2026-10-12): an administrator's
  decision, with the SCP described under [Data and privacy](#data-and-privacy).
- Answers work in dev since 2026-10-15, after three fixes: the organisation's region policy allows ap-southeast-4,
  which the `au.` profiles need ([deploy guide](deploy.md#the-organisations-region-policy)); an account
  administrator accepted Anthropic's agreements for both models ([model access](deploy.md#model-access)); and the
  chat function no longer sends `temperature`, which Claude Sonnet 5 refuses. prod needs the agreements before its
  first answer: Claude Sonnet 5's was `NOT_AVAILABLE` there on 2026-10-21.
- A Synthetics canary on `/health`, which shows the domain, WAF and API Gateway are up but runs no function, and a
  deeper one once a machine client exists to call `/chat`.
