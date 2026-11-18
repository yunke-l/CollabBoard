# API foundation

Base URL: `http://127.0.0.1:3001/api`.

The runtime OpenAPI reference is available at `/api/reference` with its JSON document at `/api/openapi.json`. It documents the implemented foundation endpoints. Shared request schemas in `packages/contracts` are validated by the API independently of browser forms.

| Method | Path                     | Access and result                                                   |
| ------ | ------------------------ | ------------------------------------------------------------------- |
| GET    | `/health/live`           | Process liveness, independent of the database                       |
| GET    | `/health/ready`          | Database and initial schema readiness; returns 503 when unavailable |
| GET    | `/demo`                  | Synthetic read-only board; no private file links                    |
| GET    | `/auth/local-identities` | Synthetic local account options                                     |
| POST   | `/auth/local-session`    | `{ userId }`; one-hour local bearer session                         |
| DELETE | `/auth/session`          | Discard the presented local session                                 |
| GET    | `/me`                    | Current authenticated synthetic profile                             |
| GET    | `/projects`              | Current member's projects; bounded by existing project quotas       |
| POST   | `/projects`              | Create project and Owner atomically                                 |
| GET    | `/projects/{id}/board`   | Authorized board snapshot and board revision                        |
| POST   | `/projects/{id}/tasks`   | Owner/Editor task creation with version 1 and appended position     |

Private endpoints use `Authorization: Bearer <accessToken>`. API responses carry `Cache-Control: no-store` and a server-generated `X-Request-Id`. Errors use `{ code, message, requestId, fieldErrors? }` and do not expose SQL, internal paths, tokens, or stack traces.

Create requests contain a UUID `requestId`. Retrying unchanged input uses the same request ID and returns the same result. Reusing an ID with different input returns `409 IDEMPOTENCY_KEY_REUSED`. Records expire after at least 24 hours. The browser preserves the logical request ID for unchanged input after a failed submission and never automatically retries writes.

Projects accept a required 1–80 character name and an optional description of up to 1,000 characters. Tasks accept a required 1–120 character title, description up to 10,000 characters, status (`todo`, `in_progress`, `done`), priority (`low`, `medium`, `high`), and an optional ISO date-only due date. Unicode limits count code points. Default task status is `todo` and priority is `medium`.

Non-members receive 404 without resource details. A Viewer may read but receives 403 when attempting a write. Archived projects reject task creation. Current project membership is checked on each board read and task write, including idempotency replay.

The initial project list returns `{ items, nextCursor: null }`; its bounded foundation scope has no membership management yet. Cursor pagination must be implemented before unbounded incoming project memberships are enabled. Comment and attachment counts are zero for private foundation tasks because these resources are not implemented; the public sample has illustrative counts only.
