---
inclusion: always
---

# Change these together

Many things in OrcaSonar are coupled across files, and sometimes across repositories. When a change touches the left
column, make the matching changes in the right column in the same change, or tell the user what remains. The full
table, with reasons, is in `docs/tech.md#change-these-together`.

| When you change                                                       | Also change                                                                                                                                                                                   |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a route                                                               | `ROUTES` in `app/src/app.ts`, `app/schema/openapi.yaml`, the method in `infrastructure/stage/stateless-stack.ts`, and `docs/api.md`. A route without a token must be a mock integration.      |
| an error code                                                         | `ErrorCode` in `app/src/lib/errors.ts`, the enum in `openapi.yaml`, `GATEWAY_ERRORS` in `stateless-stack.ts` if API Gateway can return it, and `docs/api.md#errors`                           |
| a per-request limit (question length, history, passages, tokens)      | keep `ANSWER_HOLD_USD` in `app/src/services/budget.ts` above the most an answer can then cost; update `openapi.yaml` and `docs/api.md#limits`                                                 |
| a log `outcome`                                                       | the metric filters in `stateless-stack.ts` and the Logs Insights query in `docs/runbook.md#an-alarm-fired`. A renamed outcome silently stops its alarm.                                       |
| `ANSWER_MODEL_ID` or `ALLOWED_MODEL_IDS`                              | the model's rates in `MODEL_PRICES` (`app/src/services/pricing.ts`), in USD per million tokens at the `au.` price. Its Marketplace agreement must be accepted by hand in every account first. |
| the model, the prompt or retrieval                                    | compare answers on `eval-set/` before the change reaches readers                                                                                                                              |
| the audit index                                                       | `AUDIT_INDEX` in both `app/src/aws/dynamodb.ts` and `infrastructure/stage/constants.ts`; the index must be `ACTIVE` before stateless code queries it. One index change per table update.      |
| the guardrail's policies                                              | nothing in the stateless stack (it reads `/orcasonar/guardrail-version`); run the stateless pipeline afterwards, then delete old versions (`docs/runbook.md#change-the-guardrail`)            |
| the knowledge base or its data source                                 | check the stateful diff for a replacement: a new knowledge base starts empty and needs an ingestion job                                                                                       |
| a calling app                                                         | its client ID parameter in `ALLOWED_CLIENT_ID_PARAMETERS` and hosts in `corsAllowOrigins` (`infrastructure/stage/config.ts`); OrcaUI's are in `infrastructure/shared/platform.ts`             |
| a UMCCR account, a shared SSM parameter name, or OrcaUI's hosts       | `infrastructure/shared/platform.ts`, in step with `OrcaBus/platform-cdk-constructs` (copied from 1.9.11, followed by hand)                                                                    |
| a docs host                                                           | `DOCS_ORIGINS` here and `DOCS_DOMAIN_NAMES` in `umccr/docs-platform`'s `infrastructure/config.ts`                                                                                             |
| `API_DOMAIN_PREFIX` or `API_BASE_PATH`                                | `SONAR_API_URLS` in `umccr/docs-platform`'s `infrastructure/config.ts`                                                                                                                        |
| the stateful stack's name, or the `IngestBucket` construct ID         | `ORCASONAR_INGEST_BUCKET_NAME_PREFIX` in `umccr/docs-platform`'s `infrastructure/config.ts`                                                                                                   |
| the publisher role's name or path, or `/orcasonar/ingest-bucket-name` | the same names in `umccr/docs-platform`'s `infrastructure/config.ts`                                                                                                                          |
| `infrastructure/toolchain/deployment-pipeline.ts`                     | the same file in `umccr/docs-platform`                                                                                                                                                        |
| a pipeline's push filters                                             | keep each list to 8 patterns (`MAX_TRIGGER_FILE_PATHS`, CodePipeline's limit)                                                                                                                 |
| the Swagger UI version                                                | both of its hashes in `infrastructure/stage/api-docs.ts`, using the command in the comment there                                                                                              |
| behaviour described in `docs/`                                        | the page that describes it, so the docs stay true                                                                                                                                             |

Changes in `umccr/docs-platform` cannot be made from this repository: name them to the user as follow-ups.
