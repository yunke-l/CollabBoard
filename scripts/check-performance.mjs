import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  cpus,
  totalmem,
  freemem,
  loadavg,
  platform,
  release,
  arch,
} from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createLocalFixture, json, stopProcess } from './lib/local-fixture.mjs';

const reportPath = resolve(
  process.env.PERF_REPORT_PATH ??
    'engineering/validation/local-performance.json',
);
const seconds = Number(process.env.PERF_DURATION_SECONDS ?? 600);
assert.ok(Number.isInteger(seconds) && seconds >= 5 && seconds <= 3600);
const fixture = await createLocalFixture();
let browser;
let restored = false;
const restoreName = `${fixture.name}_restore`;
const streamController = new AbortController();
const streamTasks = [];
const readTimes = [],
  writeTimes = [],
  hintTimes = [],
  renderTimes = [];
const startedTitles = new Map(),
  startedEntities = new Map(),
  seenEvents = new Set();
const requests = new Set();
const responseStatuses = {};
const resourceSamples = [];
let timeouts = 0;
let errors = 0,
  expected4xx = 0,
  readCount = 0,
  writeCount = 0,
  scheduled = 0;
const report = {
  date: new Date().toISOString(),
  scope:
    'Local loopback API, Docker PostgreSQL, and headless Chrome; no AWS services',
  fullDuration: seconds >= 600,
  durationSeconds: seconds,
  dataset: {
    projects: 20,
    tasksPerProject: 300,
    membersPerProject: 10,
    commentsPerTask: 3,
    capacityProjectTasks: 500,
  },
  load: {
    readsPerSecond: 20,
    writesPerSecond: 5,
    realtimeConnections: 50,
    additionalBrowserConnections: 2,
  },
  runtime: {
    node: process.version,
    os: `${platform()} ${release()} ${arch()}`,
    logicalCpus: cpus().length,
    hostMemoryBytes: totalmem(),
    browserContexts: 2,
    apiInstances: 1,
    apiPoolLimit: 10,
  },
};
function percentile(samples, fraction = 0.95) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * fraction) - 1,
  );
  return Number(sorted[index].toFixed(2));
}
async function command(command, args, input) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = [],
    diagnostics = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => diagnostics.push(chunk));
  child.stdin.end(input);
  const [code] = await once(child, 'exit');
  assert.equal(
    code,
    0,
    `${command} must pass: ${Buffer.concat(diagnostics).toString().slice(-1000)}`,
  );
  return Buffer.concat(chunks);
}
try {
  const identities = await json(fixture.base, '/auth/local-identities');
  const sessions = [];
  for (const user of identities)
    sessions.push(
      await json(fixture.base, '/auth/local-session', {
        body: { userId: user.id },
      }),
    );
  for (let index = 2; index < 10; index++) {
    const email = `load-${index}-${randomUUID()}@example.test`,
      password = 'Local load acceptance password!';
    const registration = await json(fixture.base, '/auth/sign-up', {
      body: { email, displayName: `Load member ${index}`, password },
    });
    await json(fixture.base, '/auth/verify-email', {
      body: { email, code: registration.developmentCode },
    });
    sessions.push(
      await json(fixture.base, '/auth/sign-in', { body: { email, password } }),
    );
  }
  const projects = Array.from({ length: 21 }, (_, index) => ({
    id: randomUUID(),
    ownerId: sessions[index % 10].user.id,
    name: `Load project ${index + 1}`,
  }));
  const tasks = [];
  await fixture.db.query('BEGIN');
  try {
    for (let projectIndex = 0; projectIndex < projects.length; projectIndex++) {
      const project = projects[projectIndex];
      await fixture.db.query(
        'INSERT INTO projects(id,owner_id,name) VALUES ($1,$2,$3)',
        [project.id, project.ownerId, project.name],
      );
      for (const session of sessions)
        await fixture.db.query(
          'INSERT INTO project_members(project_id,user_id,role) VALUES ($1,$2,$3)',
          [
            project.id,
            session.user.id,
            session.user.id === project.ownerId ? 'Owner' : 'Editor',
          ],
        );
      const rows = Array.from(
        { length: projectIndex === 20 ? 500 : 300 },
        (_, index) => ({
          id: randomUUID(),
          title: `Synthetic task ${index + 1}`,
          position: index,
        }),
      );
      tasks.push(rows);
      await fixture.db.query(
        `INSERT INTO tasks(id,project_id,creator_id,title,description,status,priority,position) SELECT r.id,$1,$2,r.title,'Synthetic load data','todo','medium',r.position FROM jsonb_to_recordset($3::jsonb) AS r(id uuid,title text,position integer)`,
        [project.id, project.ownerId, JSON.stringify(rows)],
      );
      await fixture.db.query(
        `INSERT INTO comments(id,project_id,task_id,author_id,body) SELECT gen_random_uuid(),project_id,id,$2,'Synthetic load discussion' FROM tasks CROSS JOIN generate_series(1,3) WHERE project_id = $1`,
        [project.id, project.ownerId],
      );
    }
    await fixture.db.query('COMMIT');
  } catch (error) {
    await fixture.db.query('ROLLBACK');
    throw error;
  }
  report.runtime.database = (
    await fixture.db.query('SELECT version()')
  ).rows[0].version;
  report.runtime.databaseBytes = Number(
    (
      await fixture.db.query(
        'SELECT pg_database_size(current_database()) AS bytes',
      )
    ).rows[0].bytes,
  );
  browser = await chromium.launch({
    ...(process.env.BROWSER_EXECUTABLE
      ? { executablePath: process.env.BROWSER_EXECUTABLE }
      : {}),
    headless: true,
  });
  report.runtime.browser = browser.version();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  await page.goto(`${fixture.base}/sign-in`);
  await page.getByRole('button', { name: /Jamie Lee/ }).click();
  await page.waitForURL('**/projects');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 100,
    downloadThroughput: (10 * 1000 * 1000) / 8,
    uploadThroughput: (10 * 1000 * 1000) / 8,
  });
  const usable = performance.now();
  await page.goto(`${fixture.base}/projects/${projects[0].id}/board`);
  await page
    .getByText('300 of 300 tasks', { exact: true })
    .waitFor({ timeout: 15000 });
  report.coldBoard = {
    tasks: 300,
    bandwidthMbps: 10,
    addedLatencyMs: 100,
    usableMs: Number((performance.now() - usable).toFixed(2)),
  };
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await page
    .getByRole('link')
    .filter({
      has: page.getByRole('heading', { name: 'Synthetic task 1', exact: true }),
    })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('heading', { name: 'Synthetic task 1', exact: true })
    .waitFor();
  const writerContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const writerPage = await writerContext.newPage();
  await writerPage.goto(`${fixture.base}/sign-in`);
  await writerPage.getByRole('button', { name: /Alex Morgan/ }).click();
  await writerPage.waitForURL('**/projects');
  await writerPage.goto(`${fixture.base}/projects/${projects[0].id}/board`);
  await writerPage.getByText('300 of 300 tasks', { exact: true }).waitFor();
  await page.exposeFunction('recordLoadRender', (title) => {
    const start = startedTitles.get(title);
    if (start) {
      renderTimes.push(Date.now() - start);
      startedTitles.delete(title);
    }
  });
  await page.evaluate(() => {
    const seen = new Set();
    new MutationObserver(() => {
      for (const heading of document.querySelectorAll('.task-title')) {
        const title = heading.textContent;
        if (title?.startsWith('Load change ') && !seen.has(title)) {
          seen.add(title);
          void window.recordLoadRender(title);
        }
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  let connected = 0;
  for (let index = 0; index < 50; index++) {
    const response = await fetch(`${fixture.api}/api/events`, {
      headers: { Authorization: `Bearer ${sessions[index % 10].accessToken}` },
      signal: streamController.signal,
    });
    assert.equal(response.status, 200);
    connected++;
    streamTasks.push(
      (async () => {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let end;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              if (!frame.startsWith('event: hint\n')) continue;
              const hint = JSON.parse(frame.slice(frame.indexOf('data: ') + 6));
              const entityVersion = `${hint.entityId}:${hint.entityVersion}`;
              if (
                !seenEvents.has(hint.eventId) &&
                startedEntities.has(entityVersion)
              ) {
                seenEvents.add(hint.eventId);
                hintTimes.push(Date.now() - startedEntities.get(entityVersion));
              }
            }
          }
        } catch (error) {
          if (!streamController.signal.aborted) throw error;
        }
      })(),
    );
  }
  assert.equal(connected, 50);
  const capacityStart = performance.now();
  const capacity = await json(
    fixture.base,
    `/projects/${projects[20].id}/board`,
    { token: sessions[0].accessToken },
  );
  report.capacityBoard = {
    tasks: capacity.tasks.length,
    responseMs: Number((performance.now() - capacityStart).toFixed(2)),
  };
  assert.equal(capacity.tasks.length, 500);
  async function request(write, index) {
    const session = sessions[index % 10];
    const projectIndex = index % 20;
    const project = projects[projectIndex];
    const task =
      tasks[projectIndex][
        write && projectIndex === 0 ? 0 : Math.floor(index / 20) % 300
      ];
    const start = performance.now();
    let method = 'GET',
      path,
      body;
    if (write) {
      path = `/tasks/${task.id}`;
      method = 'PATCH';
      const title = `Load change ${index}`;
      startedTitles.set(title, Date.now());
      body = {
        requestId: randomUUID(),
        expectedVersion:
          projectIndex === 0
            ? Math.floor(index / 20) + 1
            : Math.floor(index / 6000) + 1,
        title,
        description: 'Synthetic load data',
        priority: 'medium',
        dueDate: null,
        assigneeId: null,
      };
      startedEntities.set(`${task.id}:${body.expectedVersion + 1}`, Date.now());
    } else {
      path = [
        `/projects/${project.id}/board`,
        `/tasks/${task.id}`,
        `/projects/${project.id}/members`,
        `/tasks/${task.id}/comments`,
        `/projects/${project.id}/activity`,
      ][index % 5];
    }
    try {
      const response = await fetch(`${fixture.api}/api${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10000),
      });
      await response.arrayBuffer();
      responseStatuses[response.status] =
        (responseStatuses[response.status] ?? 0) + 1;
      if (response.status >= 500) errors++;
      else if (response.status >= 400) expected4xx++;
    } catch {
      errors++;
      timeouts++;
    }
    (write ? writeTimes : readTimes).push(performance.now() - start);
  }
  const loadStart = performance.now();
  let nextProgress = 60000;
  while (performance.now() - loadStart < seconds * 1000) {
    const write = scheduled++ % 5 === 0;
    const index = write ? writeCount++ : readCount++;
    const pending = request(write, index).finally(() =>
      requests.delete(pending),
    );
    requests.add(pending);
    const elapsed = performance.now() - loadStart;
    if (elapsed >= nextProgress) {
      resourceSamples.push({
        elapsedSeconds: Math.round(elapsed / 1000),
        hostFreeMemoryBytes: freemem(),
        hostLoad1m: loadavg()[0],
        driverRssBytes: process.memoryUsage().rss,
        serviceErrors: errors,
      });
      console.info(
        `Local load: ${Math.round(elapsed / 1000)}s, ${readCount} reads, ${writeCount} writes, ${errors} service errors.`,
      );
      nextProgress += 60000;
    }
    await setTimeout(
      Math.max(0, scheduled * 40 - (performance.now() - loadStart)),
    );
  }
  await Promise.all(requests);
  await setTimeout(2000);
  report.measured = {
    reads: readCount,
    writes: writeCount,
    readP95Ms: percentile(readTimes),
    writeP95Ms: percentile(writeTimes),
    firstHintP95Ms: percentile(hintTimes),
    hintSamples: hintTimes.length,
    browserRenderP95Ms: percentile(renderTimes),
    browserRenderSamples: renderTimes.length,
    serviceErrors: errors,
    expected4xx,
    errorRate: errors / (readCount + writeCount),
    responseStatuses,
    timeouts,
  };
  report.resourceSamples = resourceSamples;
  await browser.close();
  browser = undefined;
  streamController.abort();
  await Promise.allSettled(streamTasks);
  await stopProcess(fixture.child);

  const dump = await command('docker', [
    'compose',
    '-f',
    'infra/local/compose.yaml',
    'exec',
    '-T',
    'postgres',
    'pg_dump',
    '-U',
    'collabboard',
    '--format=custom',
    '--no-owner',
    fixture.name,
  ]);
  const recoveryStart = performance.now();
  await fixture.admin.query(`CREATE DATABASE "${restoreName}"`);
  restored = true;
  await command(
    'docker',
    [
      'compose',
      '-f',
      'infra/local/compose.yaml',
      'exec',
      '-T',
      'postgres',
      'pg_restore',
      '-U',
      'collabboard',
      '--exit-on-error',
      '--no-owner',
      '--dbname',
      restoreName,
    ],
    dump,
  );
  const restoredUrl = new URL(fixture.url);
  restoredUrl.pathname = `/${restoreName}`;
  const { default: pg } = await import('pg');
  const restoredClient = new pg.Client({ connectionString: restoredUrl.href });
  await restoredClient.connect();
  let tables = 0;
  try {
    for (const [table, order] of [
      ['users', 'id'],
      ['projects', 'id'],
      ['project_members', 'project_id, user_id'],
      ['tasks', 'id'],
      ['comments', 'id'],
      ['activity', 'id'],
      ['notifications', 'id'],
      ['outbox_events', 'event_id'],
      ['event_deliveries', 'event_id, recipient_id'],
      ['idempotency_records', 'user_id, operation, request_id'],
    ]) {
      const source = (
        await fixture.db.query(`SELECT * FROM ${table} ORDER BY ${order}`)
      ).rows;
      const restoredRows = (
        await restoredClient.query(`SELECT * FROM ${table} ORDER BY ${order}`)
      ).rows;
      assert.equal(
        createHash('sha256').update(JSON.stringify(source)).digest('hex'),
        createHash('sha256').update(JSON.stringify(restoredRows)).digest('hex'),
        `Restored ${table} must match its backup.`,
      );
      tables++;
    }
  } finally {
    await restoredClient.end();
  }
  report.recovery = {
    method:
      'Local pg_dump/pg_restore with writes stopped; not continuous point-in-time recovery',
    verifiedTables: tables,
    backupBytes: dump.length,
    recoveryMs: Number((performance.now() - recoveryStart).toFixed(2)),
    lostCommittedWrites: 0,
  };
  report.targets = {
    ordinaryRead: report.measured.readP95Ms <= 800,
    ordinaryWrite: report.measured.writeP95Ms <= 1000,
    serviceErrorRate: report.measured.errorRate <= 0.01,
    coldBoard: report.coldBoard.usableMs <= 3000,
    browserRendering:
      renderTimes.length >= 100 && report.measured.browserRenderP95Ms <= 1500,
    capacity: capacity.tasks.length === 500,
    recovery:
      report.recovery.recoveryMs <= 3600000 &&
      report.recovery.lostCommittedWrites === 0,
    noUnexpectedRejections: expected4xx === 0,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.info(JSON.stringify(report, null, 2));
  assert.ok(
    Object.entries(report.targets)
      .filter(([key]) => seconds >= 600 || key !== 'browserRendering')
      .every(([, passed]) => passed),
    'Local acceptance targets must pass; inspect the recorded measurements.',
  );
} finally {
  streamController.abort();
  await browser?.close();
  await Promise.allSettled(streamTasks);
  if (restored)
    await fixture.admin.query(`DROP DATABASE "${restoreName}" WITH (FORCE)`);
  await fixture.close();
}
