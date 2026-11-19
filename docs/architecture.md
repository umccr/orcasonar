# Architecture

What runs in each stage, component by component, and how a question, ingestion, the budget and the records work.

## Components

| Component              | Stack     | What it does                                                                                                                                                                                                                                               |
| ---------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS WAF                | stateless | AWS managed rule groups (IP reputation, common rules, known bad inputs) and a rate limit of 300 requests per five minutes per address. Four common rules that inspect the body only count ([why](tech.md#deliberate-though-it-can-look-wrong)).            |
| API Gateway REST API   | stateless | Regional, at `sonar.<stage zone>` on the stage's existing certificate, with the default `execute-api` endpoint disabled and a limit of 20 requests per second. Answers `/api/v1/health` and the API docs itself, from mock integrations.                   |
| Lambda authorizer      | stateless | A TOKEN authorizer: verifies a Cognito ID token from the `data-portal-<stage>` pool, issued to an allowed client, with `aws-jwt-verify`. Passes on the caller's `sub`, client ID, email and groups; cached five minutes per token.                         |
| Chat Lambda            | stateless | `POST /chat`, with response streaming: holds the budget, retrieves, calls Claude with the guardrail, streams the answer, settles the hold and records the exchange ([a question](#a-question)). Reads the guardrail's version from SSM every five minutes. |
| Query Lambda           | stateless | `/search`, `/documents/{id}`, `/feedback`, and the reader's own history (`/chat/history…`), which it reads through the audit log's index by caller.                                                                                                        |
| Audit Lambda           | stateless | `/audit/*`, for members of the audit group (`admin` in the data-portal pool) only. Reads only the table, and logs every read with who made it.                                                                                                             |
| Ingestion Lambdas      | stateless | One marks the index stale when an object under `docs/` changes; the other runs every 15 minutes and starts a job when one is needed ([ingestion](#ingestion)).                                                                                             |
| Alarms and alerts      | stateless | Alarms on failed answers, writes the chat Lambda logs rather than throws, 5XX responses, Lambda crashes and timeouts, and ingestion. Each tells one alerts topic as it fires and as it clears, as the budget's notices do.                                 |
| Budget backstop        | stateless | An AWS Budgets monthly budget on Bedrock that notifies at 80% and, at 100%, attaches a policy denying Bedrock to the chat role.                                                                                                                            |
| Sonar KMS key          | stateful  | Encrypts the buckets, the table, the guardrail and the knowledge base's index. Rotated yearly.                                                                                                                                                             |
| Ingest bucket          | stateful  | The knowledge base's only input. Only the docs platform's `docs-publisher` role writes, and only under `docs/`. Versioned, with replaced versions kept 30 days.                                                                                            |
| Managed knowledge base | stateful  | AWS-managed vector store, embeddings, hybrid search and reranker. One data source, `docs`, on the ingest bucket's `docs/` prefix.                                                                                                                          |
| Guardrail              | stateful  | Denied topics (medical advice about a person, personal data about patients), masking of emails and phone numbers, blocking of AWS keys and passwords, and a grounding check against the retrieved passages.                                                |
| Records bucket         | stateful  | One JSON record per exchange under `records/`, and feedback under `feedback/`, deleted after 30 days. `eval-set/` is kept.                                                                                                                                 |
| DynamoDB table         | stateful  | Spend counters, conversation turns, the audit log (with an index by time and one by caller) and the ingestion state, with point-in-time recovery.                                                                                                          |

The stateful stack keeps everything that holds data, so API changes never touch it. The stateless stack finds the
stateful resources through SSM parameters under `/orcasonar/`.

## A question

1. The chat panel posts the question to `/api/v1/chat` with the reader's ID token; WAF and the authorizer let it
   through.
2. The chat Lambda holds $0.10 against the reader's cap and the team's allowance in one conditional write. Over
   either, it answers `429 over-budget`, with `Retry-After` until midnight in Melbourne.
3. It sends `meta` (`exchangeId`, `conversationId`), loads the conversation's last six turns, and retrieves the top
   eight passages, filtered on `site` when the question is limited to sites. A follow-up such as "and in prod?" names
   little to search for, so it is searched for with the question before it.
4. With no passages, it says the documentation does not cover the question, without calling the model.
5. Otherwise it calls Claude through `ConverseStream` with the guardrail, the passages as the grounding source and the
   question as the query, and streams each piece of the answer as a `delta` event.
6. It prices the exchange from the tokens used, settles the hold at that cost, and sends `citations`, the passages the
   answer cites. It saves the turn, the record and the audit entry, then sends `done` with the usage and cost. A write
   that fails is logged as `write-error` and raises an alarm, but cannot fail an answer the reader already has.
7. If answering fails, the hold settles at what is known to be spent: nothing before retrieval, the retrieval until
   Bedrock accepts the model call, and the whole hold once it has, since a failed stream can still bill tokens. A call
   Bedrock refuses, as for missing model access or throttling, bills nothing.

## Ingestion

The docs platform's publish steps upload each site's pages under `docs/<slug>/`, and delete removed pages. Every
change marks the index stale, with the change's event ID as its revision. Every 15 minutes, if the index
is stale and no job is running, one ingestion job starts, and the revision it covers is kept with it. The mark is
cleared only when that job completes and no newer change has marked the index since; otherwise the next run starts
another job. A job that fails or is stopped leaves the mark, so the next run tries again, and raises
`IngestJobsFailedAlarm`.

Each page's metadata file sits beside it, as `<page>.md.metadata.json`, which is where the S3 connector looks when
the data source names no metadata prefix. The docs toolkit's `export-kb` writes this one for
`docs/platform/onboarding.md`:

```json
{
  "metadataAttributes": {
    "doc_id": "platform:onboarding",
    "site": "platform",
    "title": "Onboarding a site",
    "url": "https://docs.umccr.org/platform/onboarding/",
    "commit": "3f2c9e1",
    "updated": "2026-10-09"
  }
}
```

Each passage keeps its page's `doc_id`, `site`, `title` and `url`, so sources become links and retrieval can filter on
`site` when a question names sites.

## Budget

The chat Lambda prices each answer from the tokens Bedrock reports, at the model's rates, plus the retrieval and the
guardrail's checks.

- **Team allowance per day**: what is left of the month's budget, divided by the days left in the month, today
  included.
- **Caller cap per day**: $0.40.
- **Per-request limits** ([api.md](api.md#limits)) keep any answer under about 8 cents.
- **Holds**: before an answer, $0.10 is added to the caller's, the day's and the month's spend in one DynamoDB
  transaction, conditional on the caller's and the day's being under their limits; the answer's cost then replaces it.
  Answers asked at the same moment, on any number of Lambda instances, cannot all pass a check that each would pass
  alone, so a caller goes over a limit by one answer at most.
- **Backstop**: the AWS Budgets action. Budgets data updates only a few times a day, so the Lambda's own counters are
  the real control.

Both limits renew at midnight in Melbourne; the month's budget is in `infrastructure/stage/config.ts`.

## Records and evaluation

Each exchange is written to `records/date=YYYY-MM-DD/<exchangeId>.json`: the question, the answer, the cited sources
and their scores, the model, tokens, cost, response time, whether the guardrail intervened, and the caller's `sub`.
Feedback goes under `feedback/`. Both are deleted after 30 days; `eval-set/` keeps chosen examples without caller IDs
([runbook](runbook.md#read-the-records)). The table keeps the same exchanges, failed ones too, as the audit log, with
the reader's email ([audit API](api.md#the-audit-log)).

## Data and privacy

| Data                            | Where it lives                         | Control                                                                                                                                                  |
| ------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source documents                | the ingest bucket, Sydney              | public access blocked; Sonar KMS key; only `docs-publisher` writes                                                                                       |
| The index: chunks and vectors   | Bedrock's managed vector store, Sydney | encrypted with the Sonar KMS key, chosen when the knowledge base is created; AWS-managed storage, not a resource in this account                         |
| Embedding and reranking         | service-managed models                 | AWS does not say where they run: confirm before indexing anything sensitive. Bringing Titan Text Embeddings V2 instead switches off the managed reranker |
| Questions and answers in flight | Claude, through the `au.` profile      | Sydney and Melbourne only. Bedrock keeps no prompts or answers and does not train on them; model providers cannot reach the accounts where models run    |
| Records, turns, spend           | the records bucket and the table       | Sonar KMS key; deleted after 30 days                                                                                                                     |
| The audit log, with emails      | the table                              | Sonar KMS key; deleted after 30 days; read through the API by the audit group only                                                                       |
| Logs                            | CloudWatch                             | the caller's `sub`, the outcome and the cost; never the question, the answer or the email                                                                |

[design.md](design.md#keeping-the-data-on-our-side) says how each control is enforced.

## Open items

The details behind [project.md](project.md#open-items)'s list, where it needs them.

- **Model access in prod.** Confirm the profile IDs there with `aws bedrock list-inference-profiles`; they were
  confirmed in dev on 2026-10-12.
- **The guardrail.** Answers stream with it in sync mode (dev, 2026-10-15). Confirm that its grounding check stops an
  answer the passages do not support.
- **The budget backstop** filters on the service `Amazon Bedrock`, but Anthropic's models are billed through AWS
  Marketplace under their own names. Check where the first answers' cost appears in Cost Explorer, and filter on that;
  AWS Budgets can filter on Bedrock's model and provider since October 2026.
- **A canary** on `/health` would show that the domain, WAF and API Gateway are up, but runs no function; a deeper
  one waits for a machine client that can call `/chat`.
