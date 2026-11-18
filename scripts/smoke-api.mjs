import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';

// Use an available loopback port so CI and developer servers can run independently.
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const child = spawn(
  process.execPath,
  [new URL('../apps/api/dist/main.js', import.meta.url).pathname],
  {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      IDENTITY_PROVIDER: 'local',
      API_HOST: '127.0.0.1',
      API_PORT: String(port),
      WEB_ORIGIN: 'http://localhost:5173',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let diagnostics = '';
child.stdout.on('data', (chunk) => {
  diagnostics = (diagnostics + chunk.toString()).slice(-6000);
});
child.stderr.on('data', (chunk) => {
  diagnostics = (diagnostics + chunk.toString()).slice(-6000);
});
const base = `http://127.0.0.1:${port}/api`;
try {
  const deadline = Date.now() + 30000;
  let live;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Compiled API exited unexpectedly.\n${diagnostics}`);
    try {
      live = await fetch(`${base}/health/live`, {
        signal: AbortSignal.timeout(1000),
      });
      if (live.ok) break;
    } catch {
      /* Wait for application startup. */
    }
    await setTimeout(200);
  }
  assert.equal(live?.status, 200, 'Compiled API must start successfully.');
  assert.equal(live.headers.get('cache-control'), 'no-store');
  assert.ok(live.headers.get('x-request-id'));
  assert.equal(
    (await fetch(`${base}/demo`).then((response) => response.json())).tasks
      .length,
    10,
  );
  assert.equal((await fetch(`${base}/projects`)).status, 401);
  assert.ok(
    (await fetch(`${base}/openapi.json`).then((response) => response.json()))
      .paths['/api/projects'],
  );
  const identities = await fetch(`${base}/auth/local-identities`).then(
    (response) => response.json(),
  );
  const session = await fetch(`${base}/auth/local-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: identities[0].id }),
  }).then((response) => response.json());
  const headers = { Authorization: `Bearer ${session.accessToken}` };
  assert.equal(
    (await fetch(`${base}/me`, { headers }).then((response) => response.json()))
      .id,
    identities[0].id,
  );
  assert.equal(
    (await fetch(`${base}/auth/session`, { method: 'DELETE', headers })).status,
    200,
  );
  assert.equal((await fetch(`${base}/me`, { headers })).status, 401);
  assert.equal(
    (
      await fetch(`${base}/auth/local-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${base}/auth/local-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'x'.repeat(70000) }),
      })
    ).status,
    413,
  );
  console.info(
    'Compiled API smoke checks passed: startup, sample, session lifecycle, authorization, errors, limits, and OpenAPI.',
  );
} finally {
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timeout = globalThis.setTimeout(() => child.kill('SIGKILL'), 5000);
  timeout.unref();
  if (child.exitCode === null && child.signalCode === null) await exited;
  globalThis.clearTimeout(timeout);
}
