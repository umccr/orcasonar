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
`Authorization: Bearer <token>`. Two clients are allowed: the docs platform's `docs-app`, for the chat panel, and
OrcaUI's app client, for portal.umccr.org and orcaui.umccr.org and their dev hosts. Beta also allows the dev pool's
`localhost` client, for portal apps such as the OrcaSonar Console run on a developer's machine; their dev server
proxies the calls, since CORS allows only the deployed hosts. A token from any other client, such as a machine token
from the OrcaBus token service, gets `401`. `/health` and the
API docs under `/schema/` need no token; API Gateway answers them itself, so no function runs without a token. A
missing, expired or foreign token gets `401`; refresh it and retry once. In prod, the [audit log](#the-audit-log) also needs
the token's `cognito:groups` to include the audit group, `admin`; in beta, for now, any accepted token reads it.

The authorizer passes on the reader's `sub`, client ID, email and groups. The email is kept only in the audit log,
never in logs or records.

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

| Field            | Meaning                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `query`          | the question, 1 to 2,000 characters                                                                                       |
| `conversationId` | optional: the `conversationId` from an earlier answer, to ask a follow-up; it is searched for with the question before it |
| `sites`          | optional: limit to these docs sites (slugs)                                                                               |
| `mode`           | optional: `ask`, the only mode in release 1                                                                               |

With `Accept: text/event-stream`, the answer streams as server-sent events, in this order:

```text
event: meta
data: {"exchangeId":"x_…","conversationId":"c_…"}

event: delta
data: {"text":"Add one entry to the site registry"}

event: citations
data: [{"id":"platform:onboarding","title":"Onboarding a repository","url":"https://docs.umccr.org/platform/onboarding/","site":"platform","snippet":"…","score":0.82,"ref":1}]

event: done
data: {"usage":{"inputTokens":4920,"outputTokens":388},"costUsd":0.0213}
```

`delta` repeats. An `error` event (`{"code","message"}`) ends the stream early; keep what arrived and show the
error. Without the `Accept` header, the response is one JSON object with `exchangeId`, `conversationId`, `answer`,
`citations`, `usage` and `costUsd`. `costUsd` is what the answer cost in US dollars, as the reader's daily allowance
counts it: the model's tokens, the guardrail's checks and the retrieval.

Deltas arrive in bursts. The guardrail checks the answer about 1,000 characters at a time before releasing them, so a
short answer often arrives at once, several seconds after the question. A client that wants the answer to appear as
it is written should pace the text itself.

The answer is Markdown: paragraphs, lists, emphasis, code, links and now and then a small table. `[n]` in it cites
the citation whose `ref` is n; citations are listed in the order the answer first cites them, so `ref` is not their
position. Render the answer with a Markdown renderer that builds elements and passes no raw HTML through, or show it
as text; never insert it into a page as HTML. Titles and snippets are plain text. Citation URLs point at
`docs.umccr.org`; a client on another docs host (dev, stg) should rewrite the origin to its own.

## Other endpoints

| Endpoint              | Request                                                         | Response                                                           |
| --------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `POST /search`        | `{query, topK?, sites?}`; `topK` 1 to 20, default 8             | `{results: [{id, title, url, site, snippet, score}]}`              |
| `GET /documents/{id}` | a citation's `id`, URL-encoded, such as `platform%3Aonboarding` | `{id, site, title, url, updated, markdown}`                        |
| `POST /feedback`      | `{exchangeId, rating: "up" or "down", comment?}`                | `204`                                                              |
| `GET /health`         | no token; answered by API Gateway, never reaches a function     | `{status: "ok", version, stage}`; `version` is the deployed commit |

## Your history

A reader's own conversations from the last 30 days, so a chat panel can list them and show one again. The caller is
the token's, never a parameter, so no one reads another reader's history. History holds the conversation and nothing
the audit log adds about it: no email, client, cost, tokens or model. Questions that failed are left out, as they are
from the turns a follow-up sends the model.

| Endpoint                             | Query                                      | Response                                                                                                                                                                                                |
| ------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /chat/history`                  | `limit?` (1 to 100, default 50), `cursor?` | `{items: [{conversationId, title, startedAt, lastAt, questions}], nextCursor?}`, most recently active first; `title` is the conversation's first question                                               |
| `GET /chat/history/{conversationId}` |                                            | `{conversationId, exchanges: [{exchangeId, at, question, sites?, answer, citations: [{ref, id, title, url, site, snippet, score}]}]}`, oldest first; `403` for another reader's, `404` for one it lacks |

Citations are the ones the reader was shown, and `[n]` in a saved answer cites the citation whose `ref` is n, as in a
live one; answers saved before the whole citation was kept cite `{id, url, score}` only. To continue a conversation,
send its `conversationId` with the next question to `POST /chat`. For the next page of the list, pass `nextCursor` as
`cursor`. The cursor keeps the first page's window, but a page never reaches back past 30 days.

## The audit log

For administrators: who asked what, how it was answered, and what it cost, kept 30 days. Who may read it is
`AUDIT_GROUP` in `infrastructure/stage/config.ts`. In prod, only members of the `admin` group in the
`data-portal-prod` pool may, and anyone else gets `403 forbidden`. In beta it is `*` for now: any token the API
accepts, as for chat and search. It holds answered, not-covered and failed exchanges. Requests refused before an
answer started, over the budget or invalid, are not in it.

| Endpoint                                    | Query                                                                                                                | Response                                                                                                                                                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /audit/exchanges`                      | `from?`, `to?`, `caller?` (a `sub` or an email, in any case), `outcome?`, `limit?` (1 to 100, default 50), `cursor?` | `{from, to, items: [{exchangeId, conversationId, at, caller: {id, email, clientId}, outcome, errorCode?, question, answerPreview, sites, citations, costUsd, guardrail, latencyMs}], nextCursor?}`, newest first  |
| `GET /audit/conversations`                  | the same as `/audit/exchanges`                                                                                       | `{from, to, total, items: [{conversationId, caller, startedAt, lastAt, firstQuestion, questions, answered, notCovered, failed, sites, inputTokens, outputTokens, guardrailInterventions, costUsd}], nextCursor?}` |
| `GET /audit/conversations/{conversationId}` |                                                                                                                      | `{conversationId, exchanges: [...]}`, oldest first, each with its caller, the whole answer, its sources, model, tokens and cost; `404` for a conversation the audit log does not hold                             |
| `GET /audit/usage`                          | `from?`, `to?`                                                                                                       | `{from, to, totals: {people, questions, costUsd}, callers: [{id, email, questions, answered, notCovered, failed, costUsd, inputTokens, outputTokens, lastAt}]}`, readers with the most questions first            |

`from` and `to` are UTC dates or ISO times in UTC. A date alone is the start of that day for `from`, and its end for
`to`. The window defaults to the week up to now, and can span at most 31 days. `answerPreview` is the answer's first
280 characters; a failed exchange has its `errorCode` and no answer. For the next page, pass `nextCursor` as `cursor`
with the same `caller`, `outcome` and `limit`. The cursor keeps the first page's window, so there is no need to pass
`from` or `to` again.

An exchange is one question and its answer (`x_…`). A conversation (`c_…`) is the exchanges one reader asked as
follow-ups of each other: the first question starts it, and each follow-up sends its `conversationId`.
`/audit/conversations` lists the window's conversations, most recently active first, with what their exchanges in the
window add up to; a conversation that began before the window counts only the exchanges inside it, and
`/audit/conversations/{conversationId}` has all of it. There, `outcome` keeps the conversations with at least one
exchange that ended that way, and `total` counts every conversation that matches, across pages. Sources are the
citations the reader was shown, from the day the whole citation was first kept; older ones carry `{id, url, score}`.

```http
GET /api/v1/audit/exchanges?caller=someone%40umccr.org&limit=20 HTTP/1.1
Host: sonar.prod.umccr.org
Authorization: Bearer eyJraWQiOi…
```

## Errors

Every error has one shape: `{"error": {"code", "message", "retryAfter"?}}`, including those API Gateway returns
itself, such as for a missing token, a request WAF blocked, throttling or an unknown endpoint.

| Status | `code`            | When                                                                                                                |
| ------ | ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid-request` | the body or the query fails validation                                                                              |
| 401    | `unauthorized`    | no token, an expired one, or one from a client that is not allowed                                                  |
| 403    | `forbidden`       | WAF blocked the request, the conversation belongs to another caller, or the caller is not in the audit group        |
| 404    | `not-found`       | no such document, conversation or endpoint                                                                          |
| 429    | `over-budget`     | the caller's or the team's allowance for today is used; `Retry-After` gives the seconds until midnight in Melbourne |
| 429    | `throttled`       | too many requests per second                                                                                        |
| 503    | `unavailable`     | Bedrock is throttling, the answer stopped early, or too many answers were starting at once                          |

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
