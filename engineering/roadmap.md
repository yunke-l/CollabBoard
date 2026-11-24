# Implementation roadmap

Current scope: finish and validate all local features. AWS connections, provisioning, deployment, and cloud acceptance are explicitly deferred at the user's request on November 19, 2026. Local performance and recovery results must not be presented as cloud measurements.

## Initial foundation

- [x] English-only code, application copy, and engineering notes
- [x] pnpm workspace, strict TypeScript, formatting, and lockfile
- [x] React layouts, routing, loading/error states, Light/Dark themes with a single icon toggle
- [x] Responsive public sample with URL search/filters and task detail routes
- [x] Local synthetic sessions, independent project access, project/task creation
- [x] PostgreSQL migration, Owner integrity, authorization, quota and idempotency foundation
- [x] Atomic activity/outbox writes and integration tests
- [x] CI with PostgreSQL, type checks, tests, builds, and reference-file publication audit

## Local business workflows

- [x] Identity provider boundary for sign-up, verification, recovery, and refresh
- [x] Project settings, archive/restore, ownership transfer, and departure
- [x] Invitation hashing, fragment handling, acceptance, revocation, and role management
- [x] Assignment to current Owners/Editors and assignment cleanup on role changes/removal
- [x] Task editing, version conflicts, and draft preservation
- [x] Deterministic movement with board revisions, keyboard alternatives, and optimistic rollback
- [x] Independent authorized task reads
- [x] Two-account browser checks for invitation, assignment, editing, movement, conflicts, offline drafts, downgrade, and revocation
- [x] Multi-connection PostgreSQL tests for concurrent invitation acceptance, editing, and movement
- [x] Task archive/restore, quota checks, historical assignee revalidation, and appended restoration
- [x] Cursor pagination for incoming project memberships
- [x] Shared cursor/page-size validation and error/quota contracts for implemented resources
- [x] Owner-only pending invitation pages, failed-page recovery, and quota feedback in browser acceptance
- [x] Cursor pagination for archived tasks with stable timestamp/ID ordering
- [x] Browser acceptance for project settings, archive/restore, stale archived drafts, transfer, and departure
- [x] Multi-connection PostgreSQL acceptance for restoration/creation/transfer quota races and concurrent task restoration

## Collaboration and private resources

- [x] Recipient-aware outbox delivery, retry leases, reconnection, and periodic reconciliation
- [x] Transactional assignment notifications, recipient-scoped pages/counts, and idempotent read actions
- [x] Desktop/mobile notification center, offline/reconnection refresh, redacted inaccessible targets, and lost-response bulk-read acceptance
- [x] Comments, tombstones, independent versions, and project/task activity presentation
- [x] Comment concurrency, rollback, deletion privacy, lock-wait authorization, and desktop/mobile draft acceptance
- [x] Local private storage, actual-file validation, reservations, and expiring downloads
- [x] Interactive public sample, permanent projects from sample tasks, rate limits, and file cleanup jobs
- [x] Concurrency, revocation, offline, failure, and 500-task acceptance coverage

## Cloud validation and showcase

- [ ] Cognito, AppSync Events, and S3 adapters
- [ ] Terraform, container delivery, OIDC, monitoring, backup, recovery, and rollback
- [ ] Confirm AWS credit balance, expiration, region, and resource cost before provisioning
- [ ] Short AWS acceptance and recording window, measured performance and cost evidence
- [ ] Remove cloud resources and retain the code, technical notes, and recorded showcase

Milestones M1–M3 are implemented locally. Unchecked cloud items remain deferred and are not part of local completion. Local adapters and local measurements do not establish a production release or cloud acceptance.

## Latest validation: November 19, 2026

The complete local database suite passes 101 tests against disposable PostgreSQL, including fifteen multi-connection cases. Embedded PostgreSQL passes 86 tests with those fifteen concurrency cases skipped. New coverage includes recipient retries and leases, actual-file validation and reservations, upload/trial/rate-limit races, isolated reset/expiration, and scheduled retention plus orphan/queued-file cleanup. Migrations 0001–0007 are applied to the local development database without resetting existing data.

Chrome 158.0.8127.36 passes the complete desktop/mobile suite, including live hints, duplicate/old hints, reconnect reconciliation, private attachments, trial reset/cleanup, 500-task search, and local identity recovery. The automated new-account project-and-first-task flow took 687 ms. Compiled API runtime checks and publication checks pass; the audit includes 132 tracked or unignored files.

The user requested a usable stopping point rather than further extended testing on November 19, 2026. Feature work is complete locally, while comprehensive release acceptance remains open. The first ten-minute load run failed its latency and error targets during severe host resource contention; its failed results are retained in [the performance report](validation/local-performance.json). Recipient claim/acknowledgement batching was subsequently improved, but a full performance rerun has not been completed. Logical backup restoration matched all ten checked tables with no loss at the frozen backup point; continuous recovery and cloud RPO remain untested.

The cached local Firefox engine could not start its temporary profile, so Firefox acceptance is not claimed. WebKit 26.5 passed the core collaboration, attachment, trial, and 500-task workflows, but its final identity check reported a browser access-control error; full WebKit acceptance is not claimed. Actual Edge/Safari release checks remain open. See [evidence and requirement mapping](validation/README.md) and the [local operations runbook](local-operations.md). AWS connections, provisioning, and cloud acceptance remain explicitly deferred.
