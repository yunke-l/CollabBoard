import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import pg from 'pg';

const configured = new URL(
  process.env.DATABASE_URL ??
    'postgresql://collabboard:collabboard_local@127.0.0.1:5432/collabboard',
);
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(configured.hostname),
  'Database acceptance requires local PostgreSQL.',
);
const name = `collabboard_test_${randomBytes(8).toString('hex')}`;
const url = new URL(configured);
url.pathname = `/${name}`;
const admin = new pg.Client({ connectionString: configured.href });
let created = false;
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  const child = spawn('pnpm', ['test', ...process.argv.slice(2)], {
    env: { ...process.env, TEST_DATABASE_URL: url.href },
    stdio: 'inherit',
  });
  const [code] = await once(child, 'exit');
  process.exitCode = code ?? 1;
} finally {
  if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
}
