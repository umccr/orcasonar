# Runbook

Operating OrcaSonar. Deploying it, the first time and after, is in [deploy.md](deploy.md): changes are pull
requests that the two pipelines deploy to beta, then to prod after approval.

## An alarm fired

Every alarm tells the alerts topic when it fires and when it clears. In the stage account, its name starts with
`UMCCR-OrcaSonarStatelessStack-` and the alarm's name below.

| Alarm                                                                 | What it means                                                                                                                                             | Where to look                                                                                                                                                                                                                            |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AnswersFailedAlarm`                                                  | Three answers failed within 15 minutes: readers saw "The answer stopped early" or another error.                                                          | The chat function's log lines with `outcome` `stream-error`, `answer-error` or `error`: `error` and `detail` name the call that failed and why. The usual causes are in the deploy guide's [troubleshooting](deploy.md#troubleshooting). |
| `WritesFailedAlarm`                                                   | A reader got an answer, but its cost could not be settled (`settle-error`), or its turn or record could not be saved (`write-error`; `write` says which). | The chat function's logs. An unsettled answer keeps its whole hold; a lost turn leaves the next follow-up without it; a lost record leaves the exchange out of evaluation.                                                               |
| `ApiServerErrorsAlarm`                                                | Three 5XX responses within 15 minutes: searches, documents or feedback that failed, or answers that failed before they started streaming.                 | The query function's log lines with `outcome` `error`, and the chat function's for answers.                                                                                                                                              |
| `ChatErrorsAlarm`, `QueryErrorsAlarm`                                 | A function crashed or timed out; its own errors are answered, so they never count here.                                                                   | The function's logs, and its `Duration` against its timeout.                                                                                                                                                                             |
| `IngestMarkErrorsAlarm`, `IngestErrorsAlarm`, `IngestJobsFailedAlarm` | Changed documents may not reach the index.                                                                                                                | [The index is stale](#the-index-is-stale).                                                                                                                                                                                               |

The failures, newest first, in CloudWatch Logs Insights on the function's log group:

```text
fields @timestamp, outcome, code, error, detail, write, exchangeId
| filter outcome in ["stream-error", "answer-error", "error", "settle-error", "write-error"]
| sort @timestamp desc
```

## Give back a reader's allowance

When readers were refused because of a fault of ours, or a tester needs more answers today, lower what they have
spent. To give every reader more, raise `CALLER_DAILY_USD` in `infrastructure/stage/config.ts` instead.

Spend lives in the Sonar table (`/orcasonar/table-name`) as items under `pk` `spend`, each with its `usd`:
`caller#<sub>#<date>` for one reader's day, `day#<date>` for the team's and `month#<month>` for the month's, with
dates in Melbourne. A reader's `sub` is the `caller` in the chat function's log lines. Lower all three by the same
amount in one transaction, so they still agree:

```sh
TABLE=$(aws ssm get-parameter --name /orcasonar/table-name --query Parameter.Value --output text)
USD=0.30   # what to give back
item() { printf '{"Update":{"TableName":"%s","Key":{"pk":{"S":"spend"},"sk":{"S":"%s"}},"UpdateExpression":"ADD #usd :usd","ExpressionAttributeNames":{"#usd":"usd"},"ExpressionAttributeValues":{":usd":{"N":"-%s"}}}}' "$TABLE" "$1" "$USD"; }
aws dynamodb transact-write-items --transact-items \
  "[$(item 'caller#<sub>#2026-10-21'),$(item 'day#2026-10-21'),$(item 'month#2026-10')]"
```

## The budget ran out

Readers see "Today's allowance for answers is used up". Search keeps working.

- **Today's team allowance**: it renews at midnight in Melbourne. Nothing to do unless the month's budget should
  change: `MONTHLY_BUDGET_USD` in `infrastructure/stage/config.ts`.
- **AWS Budgets action fired** (the chat role has the `BudgetDenyPolicy` attached, and answers fail with
  `unavailable`): the month's Bedrock spend passed the budget. Raise the budget, or detach the policy from the chat
  role once the next month starts.

## Move to another Claude model

For example, from Claude Haiku 4.5 to Claude Haiku 5.5, or from Claude Sonnet 5 to Claude Sonnet 5.5. Each model
needs its own Marketplace agreement in every stage account. The stacks cannot accept it, so do that first: otherwise
every answer fails once the change deploys.

1. Check the model has an active Australian profile:
   `aws bedrock list-inference-profiles --query "inferenceProfileSummaries[?starts_with(inferenceProfileId, 'au.anthropic')].inferenceProfileId"`.
2. Accept its agreement in dev and prod, following [the manual steps](deploy.md#accepting-the-manual-steps)
   with its model ID: the profile ID without `au.`, for example `anthropic.claude-haiku-5-5`.
3. In `infrastructure/stage/config.ts`, add the profile to `ALLOWED_MODEL_IDS`, and set `ANSWER_MODEL_ID` if it should
   answer. The chat role's permissions follow `ALLOWED_MODEL_IDS`.
4. Add its rates to `app/src/services/pricing.ts`, in US dollars per million tokens at the Australian profile's
   prices, so that the budget counts it.
5. Before it answers readers, compare it with the current model on the evaluation set in `eval-set/`.
6. Merge. The stateless pipeline deploys it to beta, and to prod after approval.

## The index is stale

- Check the ingestion jobs: `aws bedrock-agent list-ingestion-jobs --knowledge-base-id <id> --data-source-id <id>`.
  The IDs are in SSM under `/orcasonar/`.
- Check the `IngestRunFunction` logs: `started`, `job-running`, `job-complete`, `job-failed` with the job's failure
  reasons, or errors. `IngestErrorsAlarm` fires on repeated errors, and `IngestJobsFailedAlarm` when a job fails. The
  index stays marked stale until a job completes, so the next run starts another job; a failure that repeats, such as
  missing permissions, needs fixing at its cause.
- To force a job: `aws bedrock-agent start-ingestion-job --knowledge-base-id <id> --data-source-id <id>`. The
  scheduler waits for it, then starts one of its own if the index is still marked stale.

## Sources have no titles, or "This site only" finds nothing

Both mean the index has no metadata: each passage's `site`, `title`, `url` and `doc_id` come from the page's
`<page>.md.metadata.json`. Without them a source's link is empty, and a `site` filter matches no page, so every
scoped question gets "I couldn't find this in UMCCR's documentation".

- Check the last ingestion job: its `numberOfMetadataDocumentsScanned` should equal `numberOfDocumentsScanned`, one
  metadata file per page. 0 means the connector read none.
- Check a passage. Its `metadata` should hold `site`, `title`, `url` and `doc_id` beside the service's own `_` fields,
  such as `_source_uri`:

  ```sh
  aws bedrock-agent-runtime retrieve --knowledge-base-id <id> --retrieval-query text=onboarding \
    --retrieval-configuration '{"managedSearchConfiguration":{"numberOfResults":1}}' \
    --query 'retrievalResults[0].metadata'
  ```

- The `docs` data source must have no `metadataFilesPrefix`. With one, the connector looks for
  `<prefix><document key>.metadata.json` rather than beside the page. After changing the data source, force a job
  (above): no change under `docs/` marks the index stale, and the job reads the metadata files it now finds.

## Change the guardrail

The guardrail's policies are in `infrastructure/stage/stateful-stack.ts`. A change publishes a new guardrail version
through the stateful pipeline and writes its number to `/orcasonar/guardrail-version`. Chat functions read that
parameter every five minutes, so they move to the new version without a deploy of the stateless stack.

The version it replaces is kept rather than deleted: running functions use it until they read the parameter again,
and the stateless stack names it as their fallback until its next deploy. Old versions do nothing, but they count
towards the guardrail's quota of versions. Once the stateless stack has deployed since the change, delete the older
ones:

```sh
aws bedrock list-guardrails --guardrail-identifier <id> --query 'guardrails[].version'
aws bedrock delete-guardrail --guardrail-identifier <id> --guardrail-version <old version>
```

The guardrail's ID is in `/orcasonar/guardrail-id`.

## Remove a site's documents

When a site is unregistered or must not be quoted any more, delete its documents and their versions under
`docs/<slug>/` in the ingest bucket. The next ingestion job removes them from the index.

## Read the records

Records are under `records/date=YYYY-MM-DD/` and feedback under `feedback/` in the records bucket (its name is in
`/orcasonar/records-bucket-name`). Only the platform team should have read access. Copy examples for the evaluation
set into `eval-set/` without the `callerId` field.
