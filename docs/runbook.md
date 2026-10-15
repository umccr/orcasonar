# Runbook

Operating OrcaSonar. Deploying it, the first time and after, is in [deploy.md](deploy.md): changes are pull
requests that the two pipelines deploy to beta and gamma, then to prod after approval.

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
2. Accept its agreement in dev, stg and prod, following [the manual steps](deploy.md#accepting-the-manual-steps)
   with its model ID: the profile ID without `au.`, for example `anthropic.claude-haiku-5-5`.
3. In `infrastructure/stage/config.ts`, add the profile to `ALLOWED_MODEL_IDS`, and set `ANSWER_MODEL_ID` if it should
   answer. The chat role's permissions follow `ALLOWED_MODEL_IDS`.
4. Add its rates to `app/src/services/pricing.ts`, in US dollars per million tokens at the Australian profile's
   prices, so that the budget counts it.
5. Before it answers readers, compare it with the current model on the evaluation set in `eval-set/`.
6. Merge. The stateless pipeline deploys it to beta and gamma, and to prod after approval.

## The index is stale

- Check the ingestion jobs: `aws bedrock-agent list-ingestion-jobs --knowledge-base-id <id> --data-source-id <id>`.
  The IDs are in SSM under `/orcasonar/`.
- Check the `IngestRunFunction` logs: `started`, `job-running`, or errors. `IngestErrorsAlarm` fires on repeated
  errors.
- To force a job: `aws bedrock-agent start-ingestion-job --knowledge-base-id <id> --data-source-id <id>`.

## Remove a site's documents

When a site is unregistered or must not be quoted any more, delete its documents and their versions under
`docs/<slug>/` in the ingest bucket. The next ingestion job removes them from the index.

## Read the records

Records are under `records/date=YYYY-MM-DD/` and feedback under `feedback/` in the records bucket (its name is in
`/orcasonar/records-bucket-name`). Only the platform team should have read access. Copy examples for the evaluation
set into `eval-set/` without the `callerId` field.
