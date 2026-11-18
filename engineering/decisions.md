# Development decisions

## Toolchain

- pnpm workspaces keep the web application, API, and transport contracts in one repository with one lockfile.
- Node.js 24 is the common runtime for local development and CI. TypeScript 5.9 is pinned for legacy NestJS decorator compatibility.
- React and Vite provide the client application. React Router owns navigation and URL filters; TanStack Query owns server data. No duplicate global business store is introduced.
- NestJS runs a modular TypeScript API. Injection tokens are explicit so development and bundled builds do not depend on emitted decorator metadata.
- Plain PostgreSQL SQL migrations keep constraints and transaction boundaries reviewable. The migration runner uses an advisory lock, checksums applied files, and applies each new migration transactionally. Applied migrations are immutable; add a new numbered file for schema changes.
- Vitest checks contracts and database operations. PGlite provides local database tests without Docker; CI repeats the database suite against PostgreSQL 17.
- Native HTML dialogs provide focus containment and Escape support. Task detail routes reuse the same board context in a desktop side panel and a full-screen mobile dialog.

## Current data integrity

The first migration contains users, projects, project members, tasks, immutable-by-API activity, pending outbox events, and idempotency records. A partial unique index and deferred consistency triggers keep the sole Owner membership aligned with `projects.owner_id`. Active task positions are unique within each project column.

Project creation locks the owning user to serialize project quota checks. Task creation locks the project before checking membership, quotas, append position, and board revision. Activity, outbox, business data, and idempotency results commit together. Requests replay only for the same authenticated user, operation, request ID, and normalized payload. Task replay rechecks membership and current write capabilities before returning cached results.

The foundation does not implement task updates, movement, archiving, membership changes, or ownership transfer. Those operations must follow the same project lock ordering and authorization discipline when added. Shared update and move request schemas are drafts, not advertised API endpoints.

## Local adapters and cloud boundaries

The local identity provider deliberately allows selecting one of two synthetic accounts without passwords. It issues unpredictable, expiring tokens, caps active local sessions, and stores no credentials in the business database. It accepts loopback development/test configuration only. Refreshing the browser clears its session. Production startup fails until a production identity provider is configured and implemented.

Outbox rows are persisted but no delivery worker runs yet. Private file storage and real-time adapter implementations will be added when their workflows are implemented. No public file directory, fake synchronization indicator, or simulated private download is provided.

AWS integration, Terraform, deployment roles, and paid resources are deferred until local acceptance is complete. The project is intended for a short cloud validation and recording window, followed by resource cleanup.

## Reference material

The original product requirements, architecture proposal, design export source, screenshots, and archives remain local under ignored paths. Engineering notes in this directory describe the code and development workflow without publishing those source documents. Production CSS uses semantic tokens based on the design palette. Inter is bundled with its OFL notice; component screenshots are never used as interactive controls.
