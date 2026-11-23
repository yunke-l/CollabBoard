# API foundation

Base URL: `http://127.0.0.1:3001/api`.

The runtime OpenAPI reference is available at `/api/reference` with its JSON document at `/api/openapi.json`. It documents the implemented foundation endpoints. Shared request schemas in `packages/contracts` are validated by the API independently of browser forms.

| Method | Path                                               | Access and result                                                           |
| ------ | -------------------------------------------------- | --------------------------------------------------------------------------- |
| GET    | `/health/live`                                     | Process liveness, independent of the database                               |
| GET    | `/health/ready`                                    | Database and current schema readiness; returns 503 when unavailable         |
| GET    | `/demo`                                            | Synthetic read-only board; no private file links                            |
| GET    | `/auth/local-identities`                           | Synthetic local account options                                             |
| POST   | `/auth/local-session`                              | `{ userId }`; One-hour bearer session and seven-day HttpOnly refresh cookie |
| DELETE | `/auth/session`                                    | Revoke the presented session and clear its refresh cookie                   |
| GET    | `/me`                                              | Current authenticated profile                                               |
| GET    | `/projects`                                        | Current member's projects; 20-item cursor pages                             |
| POST   | `/projects`                                        | Create project and Owner atomically                                         |
| GET    | `/projects/{id}`                                   | Authorized project settings snapshot                                        |
| PATCH  | `/projects/{id}`                                   | Owner updates details with expected board revision                          |
| POST   | `/projects/{id}/archive`                           | Owner archives; expected board revision required                            |
| POST   | `/projects/{id}/restore`                           | Owner restores after checking active project quota                          |
| POST   | `/projects/{id}/ownership`                         | Owner transfers to a current member after checking target quotas            |
| POST   | `/projects/{id}/leave`                             | Non-Owner withdraws access and clears active assignments                    |
| GET    | `/projects/{id}/archived-tasks`                    | Member read; 20-item cursor pages                                           |
| GET    | `/projects/{id}/board`                             | Authorized board snapshot and board revision                                |
| POST   | `/projects/{id}/tasks`                             | Owner/Editor task creation with version 1 and appended position             |
| GET    | `/tasks/{id}`                                      | Independent task read with current project authorization                    |
| PATCH  | `/tasks/{id}`                                      | Owner/Editor edit and assignment; expected task version required            |
| POST   | `/tasks/{id}/move`                                 | Versioned ordered movement; expected board revision required                |
| POST   | `/tasks/{id}/archive`                              | Owner/Editor archives using expected task version                           |
| POST   | `/tasks/{id}/restore`                              | Owner/Editor restores, checking quota and current assignee eligibility      |
| GET    | `/projects/{id}/members`                           | Member roster, bounded by the ten-member project quota                      |
| GET    | `/projects/{id}/invitations`                       | Owner-only unexpired pending invitations; cursor pages                      |
| POST   | `/projects/{id}/invitations`                       | Owner creates/replaces a 72-hour invitation                                 |
| POST   | `/projects/{id}/invitations/{invitationId}/revoke` | Owner revokes a pending invitation                                          |
| PATCH  | `/projects/{id}/members/{userId}`                  | Owner changes Editor/Viewer role                                            |
| DELETE | `/projects/{id}/members/{userId}`                  | Owner removes a non-Owner member                                            |
| POST   | `/invitations/preview`                             | Minimal project/role/expiration preview using a credential body             |
| POST   | `/invitations/accept`                              | Matching verified identity joins once; old links cannot change roles        |
| GET    | `/notifications`                                   | Current recipient's notifications; cursor pages and redacted targets        |
| GET    | `/notifications/unread-count`                      | `{ unreadCount }` for the current recipient only                            |
| POST   | `/notifications/{id}/read`                         | Idempotently mark a current recipient notification read                     |
| POST   | `/notifications/read-all`                          | Mark current recipient notifications read at the operation boundary         |
| GET    | `/tasks/{id}/comments`                             | Member read; cursor pages including deleted markers                         |
| POST   | `/tasks/{id}/comments`                             | Owner/Editor adds a plain-text comment                                      |
| GET    | `/comments/{id}`                                   | Member reads the current comment version or tombstone                       |
| PATCH  | `/comments/{id}`                                   | Author edits with expected comment version                                  |
| DELETE | `/comments/{id}`                                   | Author or Owner removes the body with expected comment version              |
| GET    | `/projects/{id}/activity`                          | Member reads activity pages; optional task filter                           |

Private endpoints use `Authorization: Bearer <accessToken>`. API responses carry `Cache-Control: no-store` and a server-generated `X-Request-Id`. Errors use `{ code, message, requestId, fieldErrors?, quota? }` and do not expose SQL, internal paths, tokens, or stack traces. The runtime OpenAPI reference describes this shared error schema, including 429 `RATE_LIMITED`; persistent per-user rate limiting is enabled. Rate rejections include `retryAfterSeconds` and an HTTP `Retry-After` header.

Project, archived-task, pending-invitation, notification, comment, and activity lists accept `?limit=1..100` (default 20) and an optional `cursor` from a previous page. Responses contain `{ items, nextCursor }`; archived-task responses also include `project`. Cursors are opaque, bound to their resource list and project, task, filter, or account, and use descending millisecond timestamp/ID ordering. They cannot be reused across scopes. Invalid query fields, repeated cursor/limit values, empty cursors, and out-of-range sizes return 400 `VALIDATION_ERROR` with field errors. Malformed decoded cursors, noncanonical timestamps, and mismatched scopes return 400 `INVALID_CURSOR`; restart from the first page. An individual page checks current access. Pagination is a live list, so refresh the first page to see newer items.

Quota conflicts preserve their existing 409 codes and include `quota: { resource, used, limit }`. Resources include `activeProjects`, `totalProjects`, `activeTrials`, `members`, `activeTasks`, `totalTasks`, `attachmentsPerTask`, and `projectStorageBytes`. The values come from the same transaction and locks that enforce the limit. Creation reports a total-quota failure before an active-quota failure if both are reached. Restoration checks active usage because it does not add to total usage. Ownership transfer reports the target Owner's usage. Messages provide the next action and explain that archiving does not free total quota; browser errors display the actual usage and limit while preserving the form for retry.

Create requests contain a UUID `requestId`. Retrying unchanged input uses the same request ID and returns the same result. Reusing an ID with different input returns `409 IDEMPOTENCY_KEY_REUSED`. Records expire after at least 24 hours. The browser preserves the logical request ID for unchanged input after a failed submission and never automatically retries writes.

Projects accept a required 1–80 character name and an optional description of up to 1,000 characters. Tasks accept a required 1–120 character title, description up to 10,000 characters, status (`todo`, `in_progress`, `done`), priority (`low`, `medium`, `high`), an optional ISO date-only due date, and a nullable `assigneeId` identifying a current Owner/Editor. Unicode limits count code points. Default task status is `todo` and priority is `medium`.

Task updates send all editable fields, `expectedVersion`, and `requestId`. Movement sends `status`, `beforeTaskId` (null appends), `expectedVersion`, `expectedBoardRevision`, and `requestId`. A stale task or board returns `409 VERSION_CONFLICT`. Successful edits/moves return `{ task, boardRevision }`. Invalid target positions return `INVALID_POSITION`; ineligible assignments return `INVALID_ASSIGNEE`. Replays recheck current membership and write capability before returning a cached result.

Invitation creation sends `{ email, role, token, requestId }`. The browser generates `token` using 32 cryptographically random bytes encoded as 64 lowercase hex characters. Only its hash is stored. Creation returns invitation metadata without the credential; the browser constructs `/invite#token=…` from the original in-memory credential. Preview sends `{ token }`; acceptance sends `{ token, requestId }`. Neither API puts credentials in paths, query strings, or logs. Revocation/removal send `{ requestId }`; role changes send `{ role, requestId }`. Member changes cannot alter the sole Owner. Removing or downgrading a member clears active assignments and changes the relevant task versions and board revision atomically.

Member snapshots return `{ project, members }`. Pending invitations are read separately through `GET /projects/{id}/invitations`, including while the project is archived. This list excludes accepted, revoked, and expired invitations. Editors and Viewers receive 403; non-members receive 404. No credential hashes are returned. The browser loads 20 invitations at a time, retains already-loaded pages when the next page fails, and refreshes pages after creation or revocation.

Project detail updates send `{ name, description, expectedBoardRevision, requestId }`. Project archive/restore send `{ expectedBoardRevision, requestId }`; transfer also sends the current member's `memberId`. These return the authorized project snapshot and reject stale revisions with `VERSION_CONFLICT`. Transfer changes the previous Owner to Editor and promotes the target in one transaction. Target quota failures return `PROJECT_LIMIT_REACHED` without changing either role. Departure sends `{ requestId }` and returns `{ projectId, left: true }`; direct Owner departure returns `OWNER_TRANSFER_REQUIRED`. Self-departure is allowed from archived projects and clears active assignments.

Task archive/restore send `{ expectedVersion, requestId }` and return `{ task, boardRevision }`. Archived tasks remain readable but reject edits and moves with `TASK_ARCHIVED`. Restoration checks the 500 active task quota (`TASK_LIMIT_REACHED`), appends to the previous column, and clears an assignee who is no longer a current Owner/Editor. Archived-task lists return `{ project, items, nextCursor }`; use `?cursor=…` for subsequent pages and optional `limit` to change page size. Cursor ordering uses archive time and ID, with matching millisecond precision in predicates.

Non-members receive 404 without resource details. A Viewer may read but receives 403 when attempting a write. Archived projects reject content writes, Owner management, and pending invitation acceptance with `PROJECT_ARCHIVED`. Current project membership is checked on each private read and write. An identical successful transfer can be replayed by its original actor while still a member despite becoming an Editor. An identical successful departure can be replayed after leaving and returns only the original success acknowledgement; it never returns project content.

Project lists return `{ items, nextCursor }`, with 20 projects per page by default and stable descending creation-time/ID cursors. Pass `?cursor=…` for the next page and optional `limit` to change page size. The browser provides Load more projects. Private task reads and boards report the actual count of comments that have not been deleted. Private task reads also report the actual ready attachment count; public sample counts are illustrative. Project snapshots include `isTrial` and nullable `expiresAt`.

## Comments and activity

Comment creation sends `{ body, requestId }`; editing sends `{ body, expectedVersion, requestId }`; deletion sends `{ expectedVersion, requestId }`. Bodies are trimmed plain text of 1–2,000 Unicode code points. Owners and Editors may create comments and edit their own. The author or current Owner may delete a comment, including on an archived task. Viewers receive 403 for writes. Archived tasks reject creation and editing with `TASK_ARCHIVED`; archived projects reject all comment mutations with `PROJECT_ARCHIVED`. Reads require current membership, including for archived resources. Removed members receive 404, and replays recheck current access and capabilities.

Comment reads contain `{ id, projectId, taskId, authorId, authorName, authorActive, body, version, createdAt, editedAt, deletedAt }`. Versions are independent of task versions. Each mutation atomically changes the comment, increments the project board revision, records activity/outbox events, and saves its idempotency acknowledgement. Task versions are unchanged. Mutation results contain only `{ commentId, taskId, projectId, version, boardRevision }`; fetch the comment or refresh its list for current text. Stale versions return `VERSION_CONFLICT`; editing an already deleted comment at its current version returns `COMMENT_DELETED`.

Deletion sets the stored body to null and retains author, timestamps, and incremented version. Lists include these tombstones with `body: null`. Original and edited comment bodies never enter immutable activity, outbox payloads, or replay results. Retrying a successful create or edit after deletion returns only its original metadata acknowledgement. A fresh deletion of an existing tombstone at its current version is a no-op.

Activity is read through `GET /projects/{id}/activity`, optionally with `taskId=<uuid>` for a task in that project. Entries contain `{ id, projectId, taskId, taskTitle, actorId, actorName, actorActive, action, changes, people, createdAt }`. Actor and task names are resolved for authorized current members; `people` resolves user IDs referenced by assignment, membership, and ownership changes. Known field changes are presented as before/after values. Comment events include only the comment ID and version. Invitation credentials and hashes are excluded. Activity has no mutation endpoint. Cursor scope includes the project and optional task filter.

Comment and activity pages refresh on mount, focus, reconnect, and 30-second polling. Local comment drafts are separate from query snapshots. After a conflict, the browser fetches the latest version and requires an explicit review action before updating the expected version. Offline, Viewer, archived, and deleted states preserve drafts while disabling unauthorized submission. Access loss clears project-scoped queries and returns to Projects.

## Assignment notifications

Task creation or editing creates a notification only when a new non-null assignee differs from both the previous assignee and the actor. The notification, task, activity, outbox event, revision, and idempotency result commit in one transaction. The recipient/source-event pair is unique. No delivery worker creates notifications; hints only prompt an authorized refresh.

Notification items contain `{ id, type: "task_assigned", createdAt, readAt, target }`. A currently accessible target contains `{ projectId, taskId, projectName, taskTitle, actorName, taskArchived }`, resolved at read time rather than copied into stored notification text. Archived tasks and projects retain member read access. After membership removal, departure, or project expiration, `target` is null and no project/task IDs, titles, or actor details are returned. The notification metadata and its read action remain available to its recipient. Unread counts include these unavailable entries until marked read. Notification IDs belonging to another recipient return 404 on read actions, and another recipient's items and counts are never returned.

Both read actions send `{ requestId }`. Individual reads return `{ id, readAt }`, preserving the first read time even with a different request ID. Bulk reads return `{ updated, readThrough }`. The first successful bulk request captures a server UTC timestamp with PostgreSQL microsecond precision and marks only currently visible unread rows at or before that boundary. The original acknowledgement is saved in the same transaction. A retry within the shared 24-hour idempotency window returns that result without updating newer rows, including a row committed after the original operation with an earlier creation timestamp. Read acknowledgements contain no linked resource content.

The browser keeps the original request ID after a failed action, refetches counts and pages after read actions, and refreshes on mount, focus, reconnect, and 30-second polling. A failed next page preserves existing rows and offers retry. Offline read actions are disabled. The header shows an unavailable count indicator when its count request fails instead of presenting an unverified zero. Live hints also invalidate the relevant lists; persisted notifications remain independent of successful hint delivery.

## Local identity

| Method | Path                        | Body or behavior                                                            |
| ------ | --------------------------- | --------------------------------------------------------------------------- |
| POST   | `/auth/sign-up`             | `{ email, displayName, password }`; returns development verification code   |
| POST   | `/auth/verify-email`        | `{ email, code }`; consumes a ten-minute code                               |
| POST   | `/auth/resend-verification` | `{ email }`; replaces the development code                                  |
| POST   | `/auth/sign-in`             | `{ email, password }`; verified accounts only                               |
| POST   | `/auth/recover`             | `{ email }`; generic acknowledgement and development code                   |
| POST   | `/auth/reset-password`      | `{ email, code, password }`; consumes code and revokes all account sessions |
| GET    | `/auth/session`             | Restore bearer session using HttpOnly refresh cookie                        |

Passwords contain 12–128 Unicode code points; display names contain 1–40. Passwords and verification/recovery hashes live only in the separate local identity database. No email is sent. Bearer access lasts one hour; refresh sessions have an absolute seven-day lifetime. Refresh cookies use HttpOnly, SameSite=Strict, and `/api/auth`; local HTTP mode does not set Secure. Neither bearer nor refresh credentials are stored in browser localStorage. Auth endpoints have persistent attempt limits. This adapter is development/test only and is not Cognito validation.

## Live hints

`GET /events` requires a bearer token and streams server-sent events for the authenticated user. No query parameters, user-selected channels, wildcard subscriptions, or client publishing are accepted. Ten simultaneous connections per local user are allowed; slow clients are disconnected when buffered data exceeds 64 KiB. Heartbeats recheck the session every 15 seconds. Event frames include `eventId`, `eventType`, `projectId`, `entityId`, `entityVersion`, `boardRevision`, and `occurredAt`, with no bodies or private links.

The dispatcher initializes current-member recipients after commit, claims 30-second leases, rechecks access before publication, and acknowledges partial success per recipient. Failed publications use exponential retry up to five minutes; continuous failure after 24 hours becomes a retained failed delivery. Pending age over 60 seconds and failed deliveries produce warnings. `pnpm jobs:retry-events` requeues failures against local PostgreSQL only. Offline recipients rely on persisted state and reconnect snapshots. Hints are at least once; clients deduplicate event IDs and fetch current snapshots rather than applying event payloads as business state.

## Private attachments

| Method | Path                         | Body or behavior                                                      |
| ------ | ---------------------------- | --------------------------------------------------------------------- |
| GET    | `/tasks/{id}/attachments`    | Current-member cursor pages of ready files                            |
| POST   | `/tasks/{id}/attachments`    | `{ originalName, sizeBytes, mediaType, requestId }`; reserve quota    |
| PUT    | `/attachments/{id}/content`  | Raw octet-stream bytes, bearer token and returned `X-Upload-Token`    |
| POST   | `/attachments/{id}/complete` | `{ requestId }`; verify actual file and commit ready state            |
| DELETE | `/attachments/{id}`          | `{ requestId }`; author/Owner immediately removes business access     |
| POST   | `/attachments/{id}/download` | Current member receives `{ url, expiresAt }`                          |
| GET    | `/downloads/{token}`         | Consume a signed capability; membership and ready state checked again |

Reservations last 15 minutes; upload capabilities last at most five minutes and bind the user and upload. The backend chooses a private project/task/upload key. Neither keys nor upload capabilities are kept in replay acknowledgements; replaying initialization issues a fresh bounded capability for the same reservation. Limits are five ready or unexpired pending files per task, 10 MiB each, and 100 MiB per project including reservations. Allowed types are JPEG, PNG, WebP, PDF, and UTF-8 TXT with matching filename extensions. Actual structure/signatures, PNG checksums, and sizes are checked; this is not malware scanning or a full document/image parser.

Only ready files appear in counts, lists, and downloads. Completion rechecks role, project/task state, reservation, and actual bytes. A rejected file releases quota and remains inaccessible; retry the original request for a completion whose response was lost. Archived tasks permit authorized deletion and reads; archived projects reject attachment mutations. Download links last at most 60 seconds and preserve original Unicode filenames using attachment disposition. The filesystem is outside the web root. Deletion and rejection queue retryable object removal. Author metadata includes `uploaderActive` so the UI can identify departed members.

## Isolated trials and limits

| Method | Path                          | Body or behavior                                                    |
| ------ | ----------------------------- | ------------------------------------------------------------------- |
| GET    | `/demo/projects/current`      | `{ trial }`, containing active trial metadata or null               |
| POST   | `/demo/projects`              | `{ requestId }`; create a private seven-day sample copy             |
| POST   | `/demo/projects/{id}/reset`   | `{ requestId }`; current trial Owner replaces it with new IDs       |
| POST   | `/demo/projects/{id}/cleanup` | `{ requestId }`; current Owner withdraws access and queues deletion |

Trials contain ten sample tasks and no inherited memberships or files. A user lock and partial unique index enforce one active trial per Owner. Reset invalidates the old project and pending invitations in the same transaction as creating the fresh copy. Expiration is enforced before cleanup runs. Minute-by-minute maintenance removes expired trial rows, queues files, and retries physical deletion. Ordinary projects are never expired by this job.

All authenticated business mutations, including download authorizations, consume the shared 60-per-minute write budget. Invitation creation also consumes ten per minute; upload initialization consumes 20; trial actions consume six. All applicable bucket increments succeed together or roll back on rejection. Counts use PostgreSQL, not one API container's memory. Read access remains available when a write quota is exhausted.
