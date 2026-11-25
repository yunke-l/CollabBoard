# CollabBoard

A task collaboration application for small teams, built with React, TypeScript, NestJS, and PostgreSQL.

This repository implements email accounts, projects, invitations, roles, tasks, comments, activity, assignment notifications, live update hints, private attachments, and an interactive sample board. The `aws-hosting` branch also supports a private, single-instance EC2 demo for one operator using Alex and Jamie in independent browser sessions. See the [EC2 deployment guide](infra/aws/README.md).

All project-provided content is English. User-authored text supports Unicode.

## Quick start

Prerequisites: Node.js 24, pnpm 10.15.1, and Docker with Compose for PostgreSQL. Install pnpm with `corepack enable` and `corepack prepare pnpm@10.15.1 --activate`, or use your preferred pnpm installation method.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm db:up
pnpm db:migrate
pnpm db:seed
pnpm dev
```

- Web application: <http://localhost:5173>
- Public sample: <http://localhost:5173/demo>
- Interactive API reference: <http://127.0.0.1:3001/api/reference>
- OpenAPI JSON: <http://127.0.0.1:3001/api/openapi.json>
- Liveness and database readiness: `/api/health/live` and `/api/health/ready`

Register an email account, verify it using the displayed development mailbox code, and sign in. Verification and recovery codes expire after ten minutes; this local adapter sends no email. Passwords are salted scrypt hashes in a private SQLite identity store, separate from business PostgreSQL. Alternatively, choose Alex Morgan or Jamie Lee as synthetic shortcuts. One-hour bearer credentials stay in memory; a revocable HttpOnly, SameSite=Strict cookie restores sessions across reloads and API restarts for up to seven days. Sign-out revokes the session, and password reset revokes all sessions for that account. Accounts initially have independent project access. To collaborate, create a project as Alex, open Members, and invite `jamie@example.com` as Editor or Viewer. Copy the invitation link into an independent browser session, sign in as Jamie, and accept it. No invitation email is sent. The link is single-use and expires after 72 hours; regenerating it invalidates the previous link.

Owners can change Editor/Viewer roles and remove members. Downgrading to Viewer or removing a member clears their active task assignments. Editors and Owners can edit and assign tasks, and drag cards to reorder them or move them between columns. For keyboard movement, open a private task and expand **Move task** to change its column or move it up or down. With filters active, tasks can move to the end of another column. On narrow screens, drop it on the destination column tab. Conflicting edits preserve the draft and require explicit review of the latest saved values. Authenticated per-user server-sent events carry identifier-only hints after business commits. The header shows Connected, Reconnecting, or Offline. Reconnection, focus refresh, and 30-second reconciliation fetch current authorized snapshots; offline writes pause while drafts remain available.

Open Settings from a project board to edit its name and description, archive or restore it, or transfer ownership to a current member. Transfer makes the previous Owner an Editor and checks the new Owner's project quotas. Members can leave from Members or Settings; Owners must transfer first. Archived projects remain readable and reject content changes and invitation acceptance. Owners can restore them when their active project quota permits. Self-departure remains available while archived and clears active assignments.

Owners and Editors can archive tasks from their details and browse the paginated Archived tasks page. Restoring appends a task to its previous column, checks the 500 active task limit, and clears a historical assignee who has left or become a Viewer. Archived tasks retain their details and existing history.

Task details include paginated plain-text comments and task activity. Owners and Editors can add comments and edit their own; authors and Owners can delete comments. Deletion removes the stored body and leaves a versioned marker. Archived tasks allow authorized deletion but pause adding and editing; archived projects pause all comment changes. Conflicts require review of the latest comment before resubmission, while offline and Viewer states retain drafts. Task cards show the actual number of comments that have not been deleted. Open Activity from the board to browse project history and field changes. Comment bodies are excluded from immutable activity and mutation acknowledgements.

Owners can load pending invitations in pages of 20 from Members. A failed next-page request keeps the invitations already loaded and offers retry. Project, archived-task, and pending-invitation APIs accept page sizes from 1 to 100. Quota errors show server-reported usage and limits, distinguish active from total quotas, and keep form values for retry; archiving does not release total project or task quota.

The header bell opens Notifications, with recipient-only assignment notices, unread counts, pagination, and individual or bulk read actions. Notifications are saved with the task write and remain available after an offline period. Self-assignment, unchanged assignees, and clearing an assignment produce no extra notices. A lost response can be retried with the original request ID; retrying Mark all as read preserves its original server boundary and leaves later arrivals unread. Notifications from projects you can no longer access show a generic unavailable entry without project or task details. Counts and lists refresh through live hints, navigation, focus, reconnection, and 30-second reconciliation.

To explore only the public sample, run `pnpm dev` without PostgreSQL. Private project operations and database readiness require the database, migrations, and seed step.

`pnpm db:up` builds the local `collabboard-postgres:17.12-patched` image from [the PostgreSQL Dockerfile](infra/postgres/Dockerfile). The first build requires internet access. It uses PostgreSQL 17.12 on a maintained Alpine 3.23 base, rebuilds the startup helper with updated Go dependencies, and applies available distribution updates. CI builds and tests the same image.

Run `pnpm db:rebuild` to rebuild without cached package-install steps and refresh available distribution patches. This recreates the database container and reuses its existing data volume. Back up important data before maintenance. Image scans can still report components for which the distribution has not released fixes; this image is not claimed to be vulnerability-free.

## Attachments, sample projects, and maintenance

Task details support private JPG, PNG, WebP, PDF, and TXT attachments. Limits are 10 MiB per file, five ready or reserved files per task, and 100 MiB of ready files plus unexpired reservations per project. Initialization reserves quota for 15 minutes and issues a five-minute upload capability. Completion rechecks membership, resource state, actual bytes, size, and file structure before publishing the attachment. These checks are file validation, not malware scanning. Members download using links lasting at most 60 seconds; the local adapter also rechecks membership when a link is used. Authors and Owners can delete attachments, including from archived tasks in active projects.

The public sample contains ten tasks. Visitors can search, filter and move existing cards locally. Open a task to read its discussion, preview its sample attachments and inspect its activity. The Activity tab shows the project history and links back to the tasks. Refreshing the page restores the original board. To keep working with the sample tasks, choose **New project** and select **Start with sample tasks**. This creates a private, permanent project under the regular project quotas. Migration 0008 also removes expiration from existing active and archived projects while preserving their IDs, memberships, tasks and files.

Business rate limits use PostgreSQL counters shared across API processes: 60 mutations per user per minute, including download authorization, with additional limits of ten invitation creations and 20 upload initializations. A 429 response includes Retry-After guidance. Identity attempts have separate persistent local limits.

The API stores private runtime state in `apps/api/.local/` when launched with `pnpm dev` or `pnpm --filter @collabboard/api start`. Set `LOCAL_STATE_DIR` to an absolute directory to keep the same location across launch methods. It contains `identity.sqlite` and private files, including the capability signing key. It must remain private and outside the web root. Ordinary archived data is retained. Background maintenance removes abandoned/rejected/deleted objects, notifications after 30 days, activity after 90 days, expired idempotency records, and delivered events after seven days. Failed events remain available for `pnpm jobs:retry-events`.

See the [local operations runbook](engineering/local-operations.md) for backup, recovery, cleanup, and troubleshooting. All commands below use local services; none provisions AWS resources.

## Workspace

```text
apps/web/            React + Vite; layouts, feature components, routes, themes
apps/api/            NestJS; local identity, projects, tasks, health, OpenAPI
apps/api/migrations/ Versioned PostgreSQL migrations
packages/contracts/ Shared transport types, validation, limits, capabilities
infra/local/         Loopback-only PostgreSQL Compose configuration
engineering/         Development decisions and implementation notes
tests/integration/   Domain integration suites and PostgreSQL migration checks
scripts/browser/     Independent browser workflows and shared page actions
scripts/             Acceptance runners, runtime checks, and repository audit
.github/             CI and dependency updates
```

Requirements, design references, and their original archives remain local and are ignored by Git. Runtime styles are implemented in code; the only bundled design resource is the licensed Inter font required by the application.

## Commands

| Command                  | Purpose                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `pnpm dev`               | Run API and web development servers                                        |
| `pnpm lint`              | Check JavaScript, TypeScript, and React Hooks with ESLint                  |
| `pnpm typecheck`         | Check application, contract, and test types                                |
| `pnpm test`              | Run contract, integration, and React component tests                       |
| `pnpm test:web`          | Run web client and React component tests in jsdom                          |
| `pnpm test:postgres`     | Run all integration tests in an automatically isolated PostgreSQL database |
| `pnpm test:browser`      | Run isolated two-account browser acceptance checks                         |
| `pnpm test:performance`  | Run the ten-minute local load and independent database recovery drill      |
| `pnpm jobs:retry-events` | Requeue failed local recipient deliveries                                  |
| `pnpm build`             | Build both applications                                                    |
| `pnpm format`            | Format project source                                                      |
| `pnpm check`             | Run formatting, types, tests, builds, and publication audit                |
| `pnpm db:migrate`        | Apply ordered, checksummed migrations                                      |
| `pnpm db:seed`           | Add the two local development identities                                   |
| `pnpm db:rebuild`        | Rebuild the database image and apply available OS patches                  |
| `pnpm db:down`           | Stop PostgreSQL while retaining its data volume                            |

Tests use embedded PostgreSQL via PGlite when `TEST_DATABASE_URL` is absent. CI runs the same integration suite against a dedicated PostgreSQL 17 service. Set `TEST_DATABASE_URL` only to a disposable, empty test database: each database integration suite creates and drops its own schema inside that database. To run a single suite against a disposable database, use `pnpm test:postgres tests/integration/migrations.test.ts`. Never point it at a development or production database.

Browser acceptance checks require a completed `pnpm build`, local PostgreSQL, and `pnpm exec playwright install chromium`. Alternatively, set `BROWSER_EXECUTABLE` to a local Chromium/Chrome executable. The runner uses the local `DATABASE_URL` account to create a uniquely named disposable database, applies migrations and synthetic identities, runs independent desktop and mobile browser contexts, and removes its database afterward. It requires database-creation permission and never resets the configured application database. Set `BROWSER_ENGINE=firefox` or `BROWSER_ENGINE=webkit` to exercise another installed Playwright engine. Firefox uses a narrow touch viewport without mobile emulation. Screenshots are saved under the ignored `.local/browser-check/<engine>/` directory. Run individual scenarios with `pnpm test:browser notifications` or pass several names. Available scenarios are `collaboration`, `notifications`, `discussion`, `attachments`, and `identity`. Each starts with a fresh database and browser contexts. Only a successful full run writes the acceptance report. CI builds once and runs the same artifacts on all three engines, saving a credential-free stage summary on failure. Engine testing does not replace release checks in actual Edge and Safari.

`pnpm test:performance` requires the same local PostgreSQL and Chromium setup. It creates disposable source and restore databases, seeds 20 projects with 300 tasks, ten members and three comments per task, maintains 50 hint streams, and submits 20 reads plus five writes per second for ten minutes. It records at least 100 remote browser renders, a cold 300-task board under 10 Mbps/100 ms conditions, a 500-task board, and exact restored-table comparisons. Results are written to `engineering/validation/local-performance.json`. Run it without concurrent builds or browser suites on a memory-constrained machine. `PERF_DURATION_SECONDS` permits a short harness smoke run, which is explicitly not full acceptance. The recovery drill stops writes and tests logical backup restoration; it does not establish a cloud RPO or point-in-time recovery capability.

`pnpm check:repository` checks tracked and unignored project files, including new source before staging. It rejects included requirements, design references, environment secret files, private keys, generated dependencies, and non-English project text. Ignored private runtime state remains outside this publication audit.

`pnpm check:runtime` starts the compiled API on an available loopback port and verifies startup, sample reads, session lifecycle, authorization, error handling, payload limits, and OpenAPI. It runs automatically as part of `pnpm check` after the build.

## Development boundaries

Business writes commit before success is returned. Project and Owner membership creation are atomic; task creation, edits, moves, comment changes, invitation acceptance, membership changes, archiving, restoration, transfer, and departure include their corresponding activity, outbox, and idempotency writes in the same transaction. Task changes check task versions; comments have independent versions; moves and project settings actions also check board revisions. User locks serialize project creation, restoration, and transfer quotas; project locks serialize task quotas, ordering, and comment changes. API permission checks use current database membership. Identical transfer retries remain available to the former Owner while still a member; identical departure retries return only the original success acknowledgement. Event rows contain identifiers and versions. A recipient-aware dispatcher leases deliveries, checks current membership before each publication, retries partial failures, and retains failed deliveries for manual retry after 24 hours of failure. The local in-process transport supports one API instance; multi-instance cloud transport is deferred.

Use the development Vite proxy for API calls. Direct API CORS is restricted to `WEB_ORIGIN`. `API_PORT` and the Vite proxy target must be changed together if you choose another API port. All local services bind to loopback interfaces.

See [development decisions](engineering/decisions.md), [API foundation](engineering/api.md), and [implementation roadmap](engineering/roadmap.md). No cloud resources are provisioned by the development or CI commands.

## Third-party assets

Inter Variable is distributed under the SIL Open Font License in `apps/web/public/fonts/OFL.txt`. Icons are rendered by `lucide-react` under its ISC license. No license for the application source has been selected; this repository does not grant an open-source license by implication.
