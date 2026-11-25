import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer as netServer } from 'node:net';
import { createServer, request as proxy } from 'node:http';
import { resolve, extname } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { localIdentities } from '../../apps/api/src/adapters/identity/local-identities.ts';

export async function availablePort() {
  const server = netServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
export async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = globalThis.setTimeout(() => child.kill('SIGKILL'), 5000);
  timer.unref();
  await exited;
  globalThis.clearTimeout(timer);
}
export async function createLocalFixture({ rateLimits = true } = {}) {
  const configured = new URL(
    process.env.DATABASE_URL ??
      'postgresql://collabboard:collabboard_local@127.0.0.1:5432/collabboard',
  );
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(configured.hostname),
    'Acceptance fixtures must use local PostgreSQL.',
  );
  const name = `collabboard_accept_${randomBytes(8).toString('hex')}`;
  const url = new URL(configured);
  url.pathname = `/${name}`;
  const admin = new pg.Client({ connectionString: configured.href });
  const db = new pg.Client({ connectionString: url.href });
  let stateRoot,
    child,
    web,
    created = false;
  const close = async () => {
    if (web) {
      web.closeAllConnections();
      await new Promise((resolve) => web.close(resolve));
    }
    await stopProcess(child);
    await db.end().catch(() => {});
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
    if (stateRoot) await rm(stateRoot, { recursive: true, force: true });
  };
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    await db.connect();
    for (const migration of (await readdir('apps/api/migrations'))
      .filter((file) => file.endsWith('.sql'))
      .sort())
      await db.query(
        await readFile(`apps/api/migrations/${migration}`, 'utf8'),
      );
    for (const user of localIdentities)
      await db.query(
        'INSERT INTO users(id,identity_subject,email,display_name) VALUES ($1,$2,$3,$4)',
        [user.id, `local:${user.id}`, user.email, user.displayName],
      );
    await mkdir(resolve('.local'), { recursive: true });
    stateRoot = await mkdtemp(resolve('.local/acceptance-state-'));
    const apiPort = await availablePort();
    const webPort = await availablePort();
    const api = `http://127.0.0.1:${apiPort}`;
    const base = `http://127.0.0.1:${webPort}`;
    child = spawn(process.execPath, ['apps/api/dist/main.js'], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        IDENTITY_PROVIDER: 'local',
        API_HOST: '127.0.0.1',
        API_PORT: String(apiPort),
        WEB_ORIGIN: base,
        DATABASE_URL: url.href,
        LOCAL_STATE_DIR: stateRoot,
        RATE_LIMITS_ENABLED: String(rateLimits),
        BACKGROUND_JOBS: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let diagnostic = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        diagnostic = (diagnostic + chunk.toString()).slice(-4000);
      });
    let ready = false;
    for (let count = 0; count < 150; count++) {
      if (child.exitCode !== null)
        throw new Error(`Local API did not start: ${diagnostic}`);
      try {
        if ((await fetch(`${api}/api/health/ready`)).ok) {
          ready = true;
          break;
        }
      } catch {
        /* Wait for startup. */
      }
      await setTimeout(200);
    }
    assert.ok(ready, 'Local API must become ready.');
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.woff2': 'font/woff2',
      '.svg': 'image/svg+xml',
    };
    const dist = resolve('apps/web/dist');
    web = createServer(async (request, response) => {
      if (request.url.startsWith('/api/')) {
        const upstream = proxy(
          new URL(request.url, api),
          { method: request.method, headers: request.headers },
          (result) => {
            response.writeHead(result.statusCode, result.headers);
            result.pipe(response);
          },
        );
        upstream.on('error', () => {
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
        response.once('close', () => upstream.destroy());
        request.pipe(upstream);
        return;
      }
      try {
        let file = resolve(
          dist,
          `.${decodeURIComponent(new URL(request.url, base).pathname)}`,
        );
        if (!file.startsWith(`${dist}/`)) file = resolve(dist, 'index.html');
        let body;
        try {
          body = await readFile(file);
        } catch {
          file = resolve(dist, 'index.html');
          body = await readFile(file);
        }
        response.writeHead(200, {
          'Content-Type': types[extname(file)] ?? 'application/octet-stream',
        });
        response.end(body);
      } catch {
        response.writeHead(500);
        response.end();
      }
    });
    web.listen(webPort, '127.0.0.1');
    await once(web, 'listening');
    return { admin, db, name, url, base, api, stateRoot, child, close };
  } catch (error) {
    await close();
    throw error;
  }
}
export async function json(
  base,
  path,
  { token, body, method = body ? 'POST' : 'GET' } = {},
) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  assert.ok(
    response.ok,
    `Local ${method} ${path}: ${response.status} ${result.code ?? ''}`,
  );
  return result;
}
