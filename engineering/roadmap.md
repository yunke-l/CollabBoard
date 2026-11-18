# Implementation roadmap

## Initial foundation

- [x] English-only code, application copy, and engineering notes
- [x] pnpm workspace, strict TypeScript, formatting, and lockfile
- [x] React layouts, routing, loading/error states, semantic Light/Dark/System themes
- [x] Responsive public sample with URL search/filters and task detail routes
- [x] Local synthetic sessions, independent project access, project/task creation
- [x] PostgreSQL migration, Owner integrity, authorization, quota and idempotency foundation
- [x] Atomic activity/outbox writes and integration tests
- [x] CI with PostgreSQL, type checks, tests, builds, and reference-file publication audit

## Next: complete local business workflows

- [ ] Identity provider boundary for sign-up, verification, recovery, and refresh
- [ ] Project archive/restore, transfer, and departure
- [ ] Invitation hashing, fragment handling, acceptance, revocation, and role management
- [ ] Assignment to current Owners/Editors and assignment cleanup on role changes
- [ ] Task editing, version conflicts, draft preservation, and archive/restore
- [ ] Deterministic movement with board revisions, keyboard alternatives, and optimistic rollback
- [ ] Independent task reads, cursor pagination, additional error and quota contracts
- [ ] Browser acceptance workflows with two independent accounts

## Then: collaboration and private resources

- [ ] Recipient-aware outbox delivery, retry leases, reconnection, and periodic reconciliation
- [ ] Transactional assignment notifications and recipient-scoped reads
- [ ] Comments, tombstones, versions, and activity presentation
- [ ] Local private storage, actual-file validation, reservations, and expiring downloads
- [ ] Isolated seven-day trials, expiration, reset, rate limits, and cleanup jobs
- [ ] Concurrency, revocation, offline, failure, and 500-task acceptance coverage

## Cloud validation and showcase

- [ ] Cognito, AppSync Events, and S3 adapters
- [ ] Terraform, container delivery, OIDC, monitoring, backup, recovery, and rollback
- [ ] Confirm AWS credit balance, expiration, region, and resource cost before provisioning
- [ ] Short AWS acceptance and recording window, measured performance and cost evidence
- [ ] Remove cloud resources and retain the code, technical notes, and recorded showcase

These items are planned work. No initial release, end-to-end collaboration, performance target, or cloud deployment is represented as complete by the scaffold.
