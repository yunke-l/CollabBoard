# CollabBoard

A task collaboration application for small teams, built with React, TypeScript, NestJS, and PostgreSQL.

This repository contains the initial local development foundation. The public sample, local development sessions, project creation, task creation, and authorized board reads work. Full collaborative editing, invitations, comments, attachments, notifications, real-time delivery, trials, and AWS deployment remain future milestones. Local identity mode refuses to start in production.

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

Choose Alex Morgan or Jamie Lee on the sign-in page. These are explicitly synthetic local identities without passwords, with one-hour sessions stored only in browser and server memory. Refreshing the browser or restarting the API requires signing in again. Accounts initially have independent project access. Membership invitation and management interfaces are not implemented yet; permission integration tests add memberships directly to exercise Owner, Editor, Viewer, and non-member access.

To explore only the public sample, run `pnpm dev` without PostgreSQL. Private project operations and database readiness require the database, migrations, and seed step.

## Workspace

```text
apps/web/            React + Vite; layouts, feature components, routes, themes
apps/api/            NestJS; local identity, projects, tasks, health, OpenAPI
apps/api/migrations/ Versioned PostgreSQL migrations
packages/contracts/ Shared transport types, validation, limits, capabilities
infra/local/         Loopback-only PostgreSQL Compose configuration
engineering/         Development decisions and implementation notes
tests/integration/   Database, permission, transaction, and environment checks
scripts/             Repository publication audit
.github/             CI and dependency updates
```

Requirements, design references, and their original archives remain local and are ignored by Git. Runtime styles are implemented in code; the only bundled design resource is the licensed Inter font required by the application.

## Commands

| Command           | Purpose                                                     |
| ----------------- | ----------------------------------------------------------- |
| `pnpm dev`        | Run API and web development servers                         |
| `pnpm typecheck`  | Check application, contract, and test types                 |
| `pnpm test`       | Run contract, permission, and transaction tests             |
| `pnpm build`      | Build both applications                                     |
| `pnpm format`     | Format project source                                       |
| `pnpm check`      | Run formatting, types, tests, builds, and publication audit |
| `pnpm db:migrate` | Apply ordered, checksummed migrations                       |
| `pnpm db:seed`    | Add the two local development identities                    |
| `pnpm db:down`    | Stop PostgreSQL while retaining its data volume             |

Tests use embedded PostgreSQL via PGlite when `TEST_DATABASE_URL` is absent. CI runs the same integration suite against a dedicated PostgreSQL 17 service. Set `TEST_DATABASE_URL` only to a disposable, empty test database: integration setup creates tables and resets test data. Never point it at a development or production database.

`pnpm check:repository` checks the Git index, so stage intended files before running it on a fresh checkout. It rejects tracked requirements, design references, environment secrets, private keys, generated dependencies, and non-English project text.

## Development boundaries

Business writes commit before success is returned. Project and Owner membership creation are atomic; task creation includes its revision, activity, outbox event, and idempotency result in the same transaction. API permission checks use current database membership. Event rows contain identifiers and versions; delivery workers are not implemented yet.

Use the development Vite proxy for API calls. Direct API CORS is restricted to `WEB_ORIGIN`. `API_PORT` and the Vite proxy target must be changed together if you choose another API port. All local services bind to loopback interfaces.

See [development decisions](engineering/decisions.md), [API foundation](engineering/api.md), and [implementation roadmap](engineering/roadmap.md). No cloud resources are provisioned by the development or CI commands.

## Third-party assets

Inter Variable is distributed under the SIL Open Font License in `apps/web/public/fonts/OFL.txt`. Icons are rendered by `lucide-react` under its ISC license. No license for the application source has been selected; this repository does not grant an open-source license by implication.
