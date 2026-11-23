import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const stateRoot = await mkdtemp(join(tmpdir(), 'collabboard-smoke-'));
const child = spawn(
  process.execPath,
  [new URL('../apps/api/dist/main.js', import.meta.url).pathname],
  {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOCAL_STATE_DIR: stateRoot,
      RATE_LIMITS_ENABLED: 'false',
      BACKGROUND_JOBS: 'false',
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
  const reference = await fetch(`${base}/openapi.json`).then((response) =>
    response.json(),
  );
  for (const path of [
    '/api/projects',
    '/api/tasks/{id}',
    '/api/tasks/{id}/move',
    '/api/tasks/{id}/archive',
    '/api/tasks/{id}/restore',
    '/api/projects/{id}',
    '/api/projects/{id}/archive',
    '/api/projects/{id}/restore',
    '/api/projects/{id}/ownership',
    '/api/projects/{id}/leave',
    '/api/projects/{id}/archived-tasks',
    '/api/projects/{projectId}/members',
    '/api/projects/{projectId}/invitations',
    '/api/invitations/preview',
    '/api/invitations/accept',
    '/api/notifications',
    '/api/notifications/unread-count',
    '/api/notifications/read-all',
    '/api/notifications/{id}/read',
    '/api/tasks/{id}/comments',
    '/api/comments/{id}',
    '/api/projects/{id}/activity',
    '/api/events',
    '/api/tasks/{id}/attachments',
    '/api/attachments/{id}/content',
    '/api/attachments/{id}/complete',
    '/api/attachments/{id}',
    '/api/attachments/{id}/download',
    '/api/downloads/{token}',
    '/api/demo/projects',
    '/api/demo/projects/current',
    '/api/demo/projects/{id}/reset',
    '/api/demo/projects/{id}/cleanup',
    ...[
      'sign-up',
      'sign-in',
      'verify-email',
      'resend-verification',
      'recover',
      'reset-password',
      'session',
    ].map((action) => `/api/auth/${action}`),
  ])
    assert.ok(reference.paths[path], `OpenAPI must include ${path}.`);
  const preflight = await fetch(
    `${base}/tasks/11111111-1111-4111-8111-111111111111`,
    {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'PATCH',
      },
    },
  );
  assert.ok(
    preflight.headers.get('access-control-allow-methods')?.includes('PATCH'),
  );
  assert.ok(
    preflight.headers.get('access-control-allow-methods')?.includes('PUT'),
  );
  assert.ok(
    preflight.headers
      .get('access-control-allow-headers')
      ?.toLowerCase()
      .includes('x-upload-token'),
  );
  assert.equal(
    (
      await fetch(`${base}/invitations/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'invalid' }),
      })
    ).status,
    400,
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
  const resourceId = '11111111-1111-4111-8111-111111111111';
  for (const path of [
    '/projects',
    '/notifications',
    `/tasks/${resourceId}/comments`,
    `/tasks/${resourceId}/attachments`,
    `/projects/${resourceId}/activity`,
    `/projects/${resourceId}/archived-tasks`,
    `/projects/${resourceId}/invitations`,
  ]) {
    for (const query of [
      'limit=0',
      'limit=101',
      'limit=1.5',
      'limit=20&limit=30',
      'cursor=',
      'cursor=one&cursor=two',
    ]) {
      const response = await fetch(`${base}${path}?${query}`, { headers });
      assert.equal(
        response.status,
        400,
        `${path} must reject ${query} before database access.`,
      );
      const error = await response.json();
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(typeof error.requestId, 'string');
      assert.ok(error.fieldErrors);
    }
  }
  for (const path of [
    '/api/projects',
    '/api/notifications',
    '/api/tasks/{id}/comments',
    '/api/tasks/{id}/attachments',
    '/api/projects/{id}/activity',
    '/api/projects/{id}/archived-tasks',
    '/api/projects/{projectId}/invitations',
  ]) {
    const operation = reference.paths[path].get;
    assert.ok(operation, `OpenAPI must document GET ${path}.`);
    const limit = operation.parameters.find(
      (parameter) => parameter.name === 'limit',
    );
    assert.deepEqual(
      [limit.schema.default, limit.schema.minimum, limit.schema.maximum],
      [20, 1, 100],
    );
    const error = operation.responses['409'].content['application/json'].schema;
    assert.ok(error.properties.quota.properties.used);
    assert.ok(error.properties.quota.properties.limit);
  }
  for (const [method, path] of [
    ['POST', `/tasks/${resourceId}/comments`],
    ['POST', `/tasks/${resourceId}/attachments`],
    ['POST', `/attachments/${resourceId}/complete`],
    ['DELETE', `/attachments/${resourceId}`],
    ['POST', '/demo/projects'],
    ['POST', `/demo/projects/${resourceId}/reset`],
    ['POST', `/demo/projects/${resourceId}/cleanup`],
    ...[
      'sign-up',
      'sign-in',
      'verify-email',
      'resend-verification',
      'recover',
      'reset-password',
    ].map((action) => ['POST', `/auth/${action}`]),
    ['PATCH', `/comments/${resourceId}`],
    ['DELETE', `/comments/${resourceId}`],
    ['POST', '/notifications/read-all'],
    ['POST', `/notifications/${resourceId}/read`],
    ['PATCH', `/projects/${resourceId}`],
    ...['archive', 'restore', 'ownership', 'leave'].map((action) => [
      'POST',
      `/projects/${resourceId}/${action}`,
    ]),
    ...['archive', 'restore'].map((action) => [
      'POST',
      `/tasks/${resourceId}/${action}`,
    ]),
  ]) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(
      response.status,
      400,
      `${method} ${path} must validate its lifecycle input before database access.`,
    );
    assert.equal((await response.json()).code, 'VALIDATION_ERROR');
  }
  for (const [method, path] of [
    ['GET', '/notifications'],
    ['GET', '/notifications/unread-count'],
    ['GET', `/tasks/${resourceId}/comments`],
    ['GET', `/comments/${resourceId}`],
    ['GET', `/projects/${resourceId}/activity`],
    ['GET', '/events'],
    ['GET', '/demo/projects/current'],
    ['POST', '/demo/projects'],
    ['GET', `/tasks/${resourceId}/attachments`],
    ['PUT', `/attachments/${resourceId}/content`],
    ['POST', `/attachments/${resourceId}/download`],
    ['POST', '/notifications/read-all'],
    ['POST', `/notifications/${resourceId}/read`],
  ]) {
    assert.equal(
      (await fetch(`${base}${path}`, { method })).status,
      401,
      `${path} requires authentication.`,
    );
  }
  for (const query of ['userId=another-user', 'channel=*', 'projectId=*'])
    assert.equal(
      (await fetch(`${base}/events?${query}`, { headers })).status,
      400,
    );
  assert.equal((await fetch(`${base}/downloads/invalid`)).status, 401);
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
  await rm(stateRoot, { recursive: true, force: true });
}
