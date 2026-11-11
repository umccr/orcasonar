---
inclusion: fileMatch
fileMatchPattern: 'app/**'
---

# Working in `app/`

The app is ES modules, bundled by esbuild into six Lambdas, and tested with Vitest. Run its checks with
`cd app && pnpm check && pnpm test`, or `make check-all && make test-all` from the root.

## Functions

| Function             | Entry point               | Invoked by                                                  | Memory, timeout |
| -------------------- | ------------------------- | ----------------------------------------------------------- | --------------- |
| `ChatFunction`       | `handlers/chat.ts`        | `POST /api/v1/chat`, with response streaming                | 1,024 MB, 5 min |
| `QueryFunction`      | `handlers/query.ts`       | `/search`, `/documents/{id}`, `/feedback`, `/chat/history…` | 512 MB, 29 s    |
| `AuditFunction`      | `handlers/audit.ts`       | `/audit/*`, for the audit group only                        | 512 MB, 29 s    |
| `AuthorizerFunction` | `handlers/authorizer.ts`  | API Gateway TOKEN authorizer, cached five minutes per token | 256 MB, 10 s    |
| `IngestMarkFunction` | `handlers/ingest-mark.ts` | EventBridge: an object created or deleted under `docs/`     | 256 MB, 10 s    |
| `IngestRunFunction`  | `handlers/ingest-run.ts`  | EventBridge: every 15 minutes                               | 256 MB, 30 s    |

## Conventions

- **Requests** are validated with a zod schema per body in `app.ts`; the first problem becomes `400 invalid-request`.
  The environment is parsed the same way in `config/env.ts`.
- **Errors** are thrown as `ApiError(status, code, message, retryAfter?)` from `lib/errors.ts`. Every error has the
  shape `{"error": {"code", "message", "retryAfter"?}}`. Anything else thrown is logged for the operator and becomes
  `500 internal` for the client, or `503 unavailable` when an answer fails.
- **The stream** is `meta`, `delta`…, `citations`, `done`; an `error` event ends it early. Catch errors inside the
  stream's callback, not in `streamSSE`'s `onError`, which would also send the raw error message (with account IDs and
  ARNs) to the client.
- **The caller** comes from `requestContext.authorizer`: `sub`, `clientId`, `email`, `groups` (space-separated). Only
  `server.ts` sets `devCaller`.
- **Logs** are one JSON line per event through `log()`, with an `outcome`. Never log the question, the answer or the
  email; use `errorDetail(error, [question, answer])` to cut them out of an error message before logging it.
- **The audit log** is read only by members of `AUDIT_GROUP`, which only the audit function is given. Each read is
  logged as `audit-read` with the viewer's `sub`, never what it returned.
- **History** (`/chat/history…`) is always the token's own `sub`, never a parameter. It maps audit entries field by
  field, so nothing the audit log adds (email, client, cost, tokens, model, guardrail) reaches it.
- **Writes after an answer are best-effort.** A turn, record or audit entry that fails to save is logged as
  `write-error`, and `done` still follows.
- **Budget time** is Melbourne's (`lib/time.ts`): allowances renew at midnight there. Records are filed by UTC date.
- **IDs** are `c_` (conversation) and `x_` (exchange) plus 32 hex characters (`lib/ids.ts`); requests are checked
  against that pattern.
- **`ConverseStream` gets no `temperature`** or other sampling parameter: Claude Sonnet 5 refuses it.
- **Spend is read with three consistent `GetItem` calls**, not a batch: a throttled batch can drop counters and read
  as nothing spent.
- **`/documents/{id}` does not decode its ID**: Hono already has.
- **Holds:** if answering fails, settle at what is known to be spent: nothing before retrieval, the retrieval until
  Bedrock accepts the model call, the whole hold after. A call Bedrock refuses bills nothing.

## Log outcomes are an interface

Alarms count `outcome` values through metric filters. Renaming one silently stops its alarm; see the change-together
steering.

| `outcome`                                | Logged by                                | Counted by                                        |
| ---------------------------------------- | ---------------------------------------- | ------------------------------------------------- |
| `answered`, `not-covered`                | chat, for each answer                    |                                                   |
| `stream-error`, `answer-error`           | chat, with the error's `code`            | `AnswersFailedAlarm` when `code` is `unavailable` |
| `error`                                  | either API function, an unexpected error | `AnswersFailedAlarm`, for the chat function's     |
| `settle-error`, `write-error`            | chat, after an answer                    | `WritesFailedAlarm`                               |
| `audit-read`                             | audit, for each read                     |                                                   |
| `parameter-error`                        | chat, when SSM cannot be read            |                                                   |
| `started`, `job-running`, `job-complete` | ingest run                               |                                                   |
| `job-failed`                             | ingest run                               | `IngestJobsFailedAlarm`                           |

## The Sonar table

One DynamoDB table, `OrcaSonarTable-<stage>`, keyed `pk` and `sk`, with TTL on `expiresAt` (epoch seconds).

| Item                         | `pk`                 | `sk`                               | Expires                    |
| ---------------------------- | -------------------- | ---------------------------------- | -------------------------- |
| a caller's spend today       | `spend`              | `caller#<sub>#<YYYY-MM-DD>`        | 40 days after last change  |
| the team's spend today       | `spend`              | `day#<YYYY-MM-DD>`                 | 40 days after last change  |
| the month's spend            | `spend`              | `month#<YYYY-MM>`                  | 400 days after last change |
| a conversation's turn        | `conversation#<c_…>` | `turn#<ISO time>`, with `owner`    | 30 days                    |
| an exchange in the audit log | `audit#<c_…>`        | `<ISO time>#<x_…>`, with `auditPk` | 30 days                    |
| the stale mark               | `ingest`             | `stale`, with `at` and `revision`  | never                      |
| the job started for the mark | `ingest`             | `job`, with `jobId` and `revision` | never                      |

- The three spend counters change together in one transaction; a hold is conditional on the caller's and the day's
  counters being under their limits.
- Index `audit-by-time` (`auditPk`, `at`) lists audit entries by time. Index `audit-by-caller` (`callerId`, `at`)
  lists one caller's entries for history, projects only `conversationId`, `question` and `outcome`, and only the query
  function may query it.

## Tests

- Route, stream, budget and accounting tests run the Hono app on `fakeDeps()` from `testing/fakes.ts`.
- AWS adapters are tested against `aws-sdk-client-mock` in `aws/adapters.test.ts`.
- `openapi.test.ts` fails when `openapi.yaml` and `ROUTES` disagree, or when an error code is missing from the
  contract.
- No test calls AWS.
