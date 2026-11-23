# Local acceptance evidence

All reports in this directory describe loopback services and development adapters. No AWS account was contacted. They do not establish Cognito/AppSync/S3 behavior, cloud performance, high availability, a cloud recovery point, or production release acceptance.

`local-browser-<engine>.json` is written only after the complete browser suite succeeds. It records actual engine/version, desktop and mobile viewport sizes, workflow coverage, and time for a new account to create its first project and task. Screenshots stay private under `.local/browser-check/<engine>/`. Chromium/Chrome, Playwright Firefox, and Playwright WebKit are tested separately; actual stable Edge and Safari remain release checks.

`local-performance.json` records both measurements and target booleans, including failed runs. `fullDuration` must be true for ten-minute acceptance. Read/write latency includes response-body completion and committed writes; identity and file transfers are excluded. The dataset contains 20 projects with 300 tasks, ten members, and three comments per task, plus a 500-task project. Fifty load-client SSE streams run alongside two independent browser contexts. Alex's API submissions update a task whose board and details remain open in Jamie's browser; a MutationObserver records at least 100 corresponding rendered titles. Hint latency is recorded separately and is not substituted for UI rendering latency.

Cold-load timing starts before a signed-in desktop navigation, disables the browser HTTP cache, and ends when all 300 tasks have rendered. Chrome network emulation uses decimal 10 Mbps bandwidth and 100 ms added latency; this is a controlled local network emulation, not a measured cloud RTT. Host memory, CPU count, operating system, PostgreSQL/browser/Node versions, database size, and minute-by-minute resource samples document the actual environment. Run performance separately from builds and other browser suites to avoid host resource contention.

Recovery uses a frozen logical backup with API writes stopped. A second disposable database is restored and exact ordered SHA-256 digests of ten tables are compared. Reported zero lost writes refers to the frozen backup point, not continuous backup or point-in-time recovery. The synthetic drill has no attachments to recover and does not restore the separate identity store. The [operations runbook](../local-operations.md) describes a complete local database/private-state backup.

## Requirement mapping

| Acceptance cases                    | Local evidence                                                                                                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UAT-01; AUTH-01–03                  | Identity integration tests and browser registration, development mailbox verification, sign-in, refresh/reload, recovery, revocation, offline sign-out protection, and logout       |
| UAT-02–09; UAT-20–22                | PostgreSQL permissions, transactional quota/Owner constraints, idempotency, concurrent writes/acceptance/movement/restoration, browser invitations and lifecycle/conflict workflows |
| UAT-10                              | Two-account browser hints and at least 100 task-detail renders in the full performance report                                                                                       |
| UAT-11–12                           | Offline drafts, a change committed while the other account is offline, reconnect snapshots, injected duplicate/old hints, and monotonic snapshot versions                           |
| UAT-13                              | Dispatcher membership revalidation, revoked API/file access, and browser cache withdrawal; local streams authorize only their own authenticated user                                |
| UAT-14–15                           | Transactional notification tests; offline recipient persistence, counts, reads, and lost-response bulk-read replay preserving late arrivals                                         |
| UAT-16                              | Comment authorization, body-free tombstones/history/replays, version races, escaped plain text, and desktop/mobile browser moderation                                               |
| UAT-17–19                           | File initialization/completion, actual content checks, signed capabilities, cross-upload access, expiry, reservation quotas, downgrade during completion, and safe retry            |
| UAT-23                              | Independent trial copies, immediate expiry checks, new-ID resets, cleanup queues, and browser start/reset/cleanup                                                                   |
| UAT-24–25                           | Outbox rollback/partial delivery/retry/expired-lease tests; duplicate request and delayed/lost-response browser scenarios. Lease expiry models worker interruption.                 |
| UAT-26–27                           | Local performance report, 500-task search, keyboard/drag alternatives, desktop/mobile widths, and theme screenshots                                                                 |
| UAT-29                              | Independent logical database restore and exact table comparison; cloud RPO and point-in-time recovery deferred                                                                      |
| UAT-30, local portion               | Trial removal, orphan/queued-object and retention tests, disposable fixture cleanup, and local teardown instructions                                                                |
| UAT-28; cloud portions of UAT-29–30 | Deferred at the user's request; no cloud deployment, rollback, billing, or resource cleanup claimed                                                                                 |

The local scope covers milestones M1–M3. Cloud milestones M4–M6, portfolio recording/publication, current real-browser release certification, and all cloud operating measurements remain separate work.
