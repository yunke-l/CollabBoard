# Local operations

This runbook operates on loopback PostgreSQL and private filesystem adapters. It does not connect to AWS. Cloud deployment, continuous backups, alarms, and production rollback remain deferred. Never point disposable test commands at valuable databases.

## Start and upgrade

Run `pnpm db:up`, `pnpm db:migrate`, `pnpm db:seed`, and `pnpm dev` from the repository root. Migrations are additive, ordered, checksummed, and applied transactionally under an advisory lock. An applied migration must not be edited. Upgrading code requires applying new migrations before starting the new API. `/api/health/ready` checks that the current schema is present. Keep a consistent backup before upgrading valuable local data.

The default private state directory is `apps/api/.local` for workspace API commands. An absolute `LOCAL_STATE_DIR` overrides it. Back up that directory as well as PostgreSQL: identity accounts, refresh sessions, private attachment bytes, and the capability signing key are not in the business database. Never serve or commit it. Starting a compiled API directly from the repository root changes the relative default to the root `.local`; use an absolute override to avoid accidentally selecting a different identity/file store.

## Trace a failed request

Use the response `X-Request-Id` and error body's `requestId`. The API logs sanitized request IDs and error status for unexpected failures, without request bodies, bearer tokens, invitation credentials, or signed download paths. Check `/api/health/live`, `/api/health/ready`, API stderr, and `docker compose -f infra/local/compose.yaml logs --tail=100 postgres`. Do not copy private application data into bug reports.

The Connected indicator describes the hint transport, independently of API health. Reconnecting permits business API use; Offline disables writes and retains drafts. Reconnect/focus and 30-second reconciliation fetch committed state. A lost write response must be retried with its original request ID and unchanged input. Conflicts require reviewing the current saved version before resubmitting.

## Event delivery and cleanup

The dispatcher runs every 500 milliseconds. It retains recipient progress, claims 30-second leases, retries failures with backoff, and warns about events pending over 60 seconds. After 24 hours of continuous delivery failure, inspect the local API/transport and run:

```sh
pnpm jobs:retry-events
```

The command accepts a loopback database only. It resets failed deliveries for retry, not business writes or notifications. Duplicate hints are expected after interrupted acknowledgement; notification creation is part of the original business transaction and is not repeated by dispatch.

Maintenance runs at startup and every minute without overlapping itself. It expires pending uploads, removes rejected/deleted/expired objects, removes orphaned temporary or unknown files older than 15 minutes, and retries queued object removals. A failure logs a sanitized error and retries on the next tick. Restarting the local API reruns maintenance. Do not manually delete ready objects or database metadata to free quota.

Projects are retained indefinitely. Retention is 30 days for notifications, 90 days for activity, at least 24 hours for idempotency, and seven days for delivered events. Failed events remain until retry or manual handling. This local application writes no retained access-log files; terminal capture and Docker log retention are host responsibilities.

## Consistent backup

Stop the web/API development command first, leaving PostgreSQL running. Wait for API shutdown so active workers and writes finish. Choose the actual private state directory if `LOCAL_STATE_DIR` was overridden. From the repository root, the default configuration can be backed up with:

```sh
umask 077
backup_tag=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir="$PWD/.local/backups/$backup_tag"
mkdir -p "$backup_dir"
docker compose -f infra/local/compose.yaml exec -T postgres pg_dump -U collabboard --format=custom --no-owner collabboard > "$backup_dir/database.dump"
tar -C apps/api -czf "$backup_dir/private-state.tgz" .local
shasum -a 256 "$backup_dir/database.dump" "$backup_dir/private-state.tgz"
```

Keep the API stopped until both parts finish. Preserve filesystem permissions, including the signing key and SQLite files. The private state archive includes the SQLite WAL when present. Keep backups private, retain a known-good pre-upgrade copy, and remove obsolete local backups deliberately. There is no automatic encrypted backup or seven-day backup rotation in local mode.

## Restore into an independent environment

Restore into a new database and directory; never overwrite the only working copy. With `backup_dir` still set to the selected backup:

```sh
restore_tag=$(date -u +%Y%m%dT%H%M%SZ)
restore_database="collabboard_restore_$restore_tag"
restore_dir="$PWD/.local/restores/$restore_tag"
mkdir -p "$restore_dir"
docker compose -f infra/local/compose.yaml exec -T postgres createdb -U collabboard "$restore_database"
docker compose -f infra/local/compose.yaml exec -T postgres pg_restore -U collabboard --exit-on-error --no-owner --dbname "$restore_database" < "$backup_dir/database.dump"
tar -C "$restore_dir" -xzf "$backup_dir/private-state.tgz"
```

For an isolated run, set `DATABASE_URL` to the new local database and `LOCAL_STATE_DIR` to the absolute `$restore_dir/.local`, then apply migrations appropriate to the chosen code version. Use separate API/web ports if another environment runs. Verify readiness, sign-in, project/task/member counts, sole Owner consistency, a private file download, and a representative versioned write. The old environment remains available for comparison. Remove the disposable restore database only after validation and while no process uses it.

For code rollback, stop the API and select the previous compatible source/build. The current migrations are additive; check schema compatibility before reusing the upgraded database. If incompatible, restore the matching pre-upgrade database and private state into a new environment. Do not reverse SQL migrations against valuable data without a reviewed migration.

## Repeatable acceptance

`pnpm check` covers formatting, types, embedded tests, builds, compiled HTTP boundaries, and publication audit. `pnpm test:postgres` repeats the suite in an automatically created and removed PostgreSQL database, including concurrency tests. `pnpm test:browser` creates a disposable database/private state directory for each scenario and exercises independent desktop/mobile contexts. Set `BROWSER_ENGINE=firefox` or `webkit` for the other installed Playwright engines.

`pnpm test:performance` runs ten minutes with 20 reads and five writes per second, 50 hint streams, 20 projects of 300 tasks, ten members per project, and three comments per task, plus a 500-task project. A real headless Chrome observer records remote card rendering; cold-load throttling uses 10 Mbps and 100 ms added latency. Run this separately from other builds/browser suites on hosts with limited memory. Reports include actual versions, measurements, and pass/fail targets. Short `PERF_DURATION_SECONDS` runs only check the harness.

The recovery part stops API writes, creates a logical dump, restores it into a second disposable database, and compares ordered SHA-256 digests of ten business/delivery tables. Zero lost writes refers to that frozen backup point. Attachments and the separate identity store are not part of this synthetic recovery dataset. This drill does not measure continuous backup lag, a failure before the last backup, cloud RPO, or point-in-time recovery. Use the complete backup procedure above for real local state.

## Local teardown

Stop API/web processes and run `pnpm db:down`; the named PostgreSQL volume and private state remain for the next session. Removing the volume, private state, or backups destroys local data and is a separate deliberate maintenance action. The acceptance runners remove only their own uniquely named disposable databases/directories. No cloud resources or cloud costs are created by these procedures.
