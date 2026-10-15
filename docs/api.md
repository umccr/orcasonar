# API

Version 1 lives under `https://sonar.<stage>.umccr.org/api/v1`. The OpenAPI contract is
[app/schema/openapi.yaml](../app/schema/openapi.yaml); a test keeps it in step with the routes the API serves.

## Browsing the API

Each stage serves its contract beside the API, as the OrcaBus services do, with no token:

| Page                                                                                               | What it is                                                |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [`https://sonar.dev.umccr.org/schema/swagger-ui/`](https://sonar.dev.umccr.org/schema/swagger-ui/) | Swagger UI: every endpoint, its request and its responses |
| `https://sonar.<stage>.umccr.org/schema/openapi.json`                                              | the contract as JSON, for clients and code generators     |

The served contract names one server, `/api/v1` on the same host, so "Try it out" calls the stage that served the
page. To call an endpoint that needs a token, choose **Authorize** and paste an ID token from an allowed client;
the page keeps it only until you close it. Swagger UI loads from jsDelivr at a pinned version, checked against its
hashes, under a Content-Security-Policy that allows nothing else (`infrastructure/stage/api-docs.ts`).

## Authentication

Send a Cognito ID token from the `data-portal-<stage>` pool, issued to an allowed app client, as
`Authorization: Bearer <token>`. Release 1 allows the docs platform's `docs-app` client only. `/health` and the
API docs under `/schema/` need no token; API Gateway answers them itself, so no function runs without a token. A
missing, expired or foreign token gets `401`; refresh it and retry once.

## Asking a question

```http
POST /api/v1/chat HTTP/1.1
Host: sonar.prod.umccr.org
Origin: https://docs.umccr.org
Authorization: Bearer eyJraWQiOi…
Accept: text/event-stream
Content-Type: application/json

{"query": "How do I add a site to docs.umccr.org?", "sites": ["platform"]}
```

| Field            | Meaning                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| `query`          | the question, 1 to 2,000 characters                                       |
| `conversationId` | optional: the `conversationId` from an earlier answer, to ask a follow-up |
| `sites`          | optional: limit to these docs sites (slugs)                               |
| `mode`           | optional: `ask`, the only mode in release 1                               |

With `Accept: text/event-stream`, the answer streams as server-sent events, in this order:

```text
event: meta
data: {"exchangeId":"x_…","conversationId":"c_…"}

event: delta
data: {"text":"Add one entry to the site registry"}

event: citations
data: [{"id":"platform:onboarding","title":"Onboarding a repository","url":"https://docs.umccr.org/platform/onboarding/","site":"platform","snippet":"…","score":0.82}]

event: done
data: {"usage":{"inputTokens":4920,"outputTokens":388}}
```

`delta` repeats. An `error` event (`{"code","message"}`) ends the stream early; keep what arrived and show the
error. Without the `Accept` header, the response is one JSON object with `exchangeId`, `conversationId`, `answer`,
`citations` and `usage`.

Answers, snippets and titles are plain text. Render them as text, never as HTML. Citation URLs point at
`docs.umccr.org`; a client on another docs host (dev, stg) should rewrite the origin to its own.

## Other endpoints

| Endpoint              | Request                                                         | Response                                                           |
| --------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `POST /search`        | `{query, topK?, sites?}`; `topK` 1 to 20, default 8             | `{results: [{id, title, url, site, snippet, score}]}`              |
| `GET /documents/{id}` | a citation's `id`, URL-encoded, such as `platform%3Aonboarding` | `{id, site, title, url, updated, markdown}`                        |
| `POST /feedback`      | `{exchangeId, rating: "up" or "down", comment?}`                | `204`                                                              |
| `GET /health`         | no token; answered by API Gateway, never reaches a function     | `{status: "ok", version, stage}`; `version` is the deployed commit |

## Errors

Every error has one shape: `{"error": {"code", "message", "retryAfter"?}}`.

| Status | `code`            | When                                                                                                                |
| ------ | ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid-request` | the body fails validation                                                                                           |
| 401    | `unauthorized`    | no token, an expired one, or one from a client that is not allowed                                                  |
| 403    | `forbidden`       | WAF blocked the request, or the conversation belongs to another caller                                              |
| 404    | `not-found`       | no such document or endpoint                                                                                        |
| 429    | `over-budget`     | the caller's or the team's allowance for today is used; `Retry-After` gives the seconds until midnight in Melbourne |
| 429    | `throttled`       | too many requests per second                                                                                        |
| 503    | `unavailable`     | Bedrock is throttling, or the answer stopped early                                                                  |

## Limits

| Limit                | Value                                                              |
| -------------------- | ------------------------------------------------------------------ |
| Question length      | 2,000 characters                                                   |
| Conversation history | the last 6 turns                                                   |
| Passages per answer  | 8                                                                  |
| Answer length        | 1,000 output tokens                                                |
| Search results       | `topK` up to 20                                                    |
| Stream duration      | 5 minutes                                                          |
| Rate                 | 20 requests per second per stage, 300 per five minutes per address |
