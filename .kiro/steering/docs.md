---
inclusion: fileMatch
fileMatchPattern: 'docs/**'
---

# Writing in `docs/`

- Plain British English (organisation, licence, authorisation), with AWS's names spelled as AWS spells them
  (authorizer).
- Dates are absolute. A fact checked in an account says where and when, as in "dev, 2026-10-15".
- Prose is wrapped by hand at about 120 columns. Prettier formats Markdown, tables included, and `make check` fails on
  a page it would change: run `make fix` or `pnpm prettier-fix` after editing.
- Each page has one job; link to the page that owns a topic rather than repeating it:

  | Page              | Owns                                                                          |
  | ----------------- | ----------------------------------------------------------------------------- |
  | `project.md`      | purpose, callers, scope, status, open items, vocabulary                       |
  | `tech.md`         | stack, layout, code conventions, "change these together", deliberate oddities |
  | `design.md`       | decisions and their reasons, diagrams, costs                                  |
  | `architecture.md` | deployed components, request flow, ingestion, budget, privacy, open items     |
  | `api.md`          | the API as a client sees it; kept in step with `app/schema/openapi.yaml`      |
  | `deploy.md`       | deploying and manual account steps, troubleshooting                           |
  | `runbook.md`      | operating: alarms, budget, model and guardrail changes, the index, records    |

- Use the vocabulary in `project.md` (reader, caller, exchange, conversation, hold, settle, allowance, cap).
- Never paste account IDs, ARNs, bucket names, tokens or a person's email address into a page.
- Changing only `docs/` or Markdown starts neither pipeline.
