import assert from 'node:assert/strict';
import pg from 'pg';
const url = new URL(
  process.env.DATABASE_URL ??
    'postgresql://collabboard:collabboard_local@127.0.0.1:5432/collabboard',
);
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
  'This maintenance command accepts local PostgreSQL only.',
);
const client = new pg.Client({ connectionString: url.href });
try {
  await client.connect();
  await client.query('BEGIN');
  const result = await client.query(
    "UPDATE event_deliveries SET state = 'pending', attempts = 0, first_failure_at = NULL, next_attempt_at = now(), lease_until = NULL, lease_token = NULL WHERE state = 'failed'",
  );
  await client.query(
    "UPDATE outbox_events SET state = 'pending' WHERE state = 'failed'",
  );
  await client.query('COMMIT');
  console.info(
    `Queued ${result.rowCount} failed recipient deliveries for retry.`,
  );
} finally {
  await client.end();
}
