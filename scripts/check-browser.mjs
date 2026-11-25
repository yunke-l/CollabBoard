import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  createServer as createHttpServer,
  request as proxyRequest,
} from 'node:http';
import { createServer } from 'node:net';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { chromium, firefox, webkit } from 'playwright';
import {
  checkLocalResources,
  checkIdentity,
} from './browser/local-workflows.mjs';
import { localIdentities } from '../apps/api/src/adapters/identity/local-identities.ts';

// Always create a new database. Never reset or truncate the configured database.
const adminUrl = new URL(
  process.env.DATABASE_URL ??
    'postgresql://collabboard:collabboard_local@127.0.0.1:5432/collabboard',
);
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(adminUrl.hostname),
  'Browser checks require local PostgreSQL.',
);
const databaseName = `collabboard_browser_${randomBytes(8).toString('hex')}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = new pg.Client({ connectionString: adminUrl.href });
const fixture = new pg.Client({ connectionString: databaseUrl.href });
const children = [];
let stateRoot;
let browser;
let web;
let created = false;
const errors = [];
const pages = [];
let captureFailure = false;
const engine = process.env.BROWSER_ENGINE ?? 'chromium';
assert.ok(
  ['chromium', 'firefox', 'webkit'].includes(engine),
  'Unknown browser engine.',
);
const output = resolve('.local/browser-check', engine);

async function port() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const number = server.address().port;
  await new Promise((done) => server.close(done));
  return number;
}
async function eventually(check, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await setTimeout(100);
  }
  assert.fail(message);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timeout = globalThis.setTimeout(() => child.kill('SIGKILL'), 5000);
  timeout.unref();
  await exited;
  globalThis.clearTimeout(timeout);
}
async function signIn(page, name) {
  await page.getByRole('button', { name: new RegExp(name) }).click();
}
async function createTask(page, title, assignee = '') {
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Task title').fill(title);
  await dialog
    .getByLabel('Description')
    .fill('A collaboration acceptance task.');
  await dialog.getByLabel('Assignee').selectOption(assignee);
  await dialog
    .getByRole('button', { name: 'Create task', exact: true })
    .click();
  await dialog.waitFor({ state: 'hidden' });
}
async function savedMove(page, action) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        /\/api\/tasks\/[^/]+\/move$/.test(response.url()) &&
        response.request().method() === 'POST',
    ),
    action(),
  ]);
  assert.equal(response.status(), 201);
  await page
    .getByText('Saving task position…', { exact: true })
    .waitFor({ state: 'hidden' });
}
async function checkMoveRecovery(owner, editor) {
  const column = (page, name) =>
    page.getByRole('region', { name, exact: true });
  const card = (page, title) =>
    page.getByRole('link').filter({
      has: page.getByRole('heading', { name: title, exact: true }),
    });
  const titles = (name) =>
    column(owner, name).locator('.task-card h3').allTextContents();
  const prepare = card(owner, 'Prepare launch');
  await editor.reload();
  await column(editor, 'In Progress')
    .getByRole('heading', { name: 'Review launch' })
    .waitFor();

  // Hold the Owner's optimistic move while the Editor commits a different move.
  // Fail the refresh so a successful refetch cannot mask a missing local rollback.
  const sendMove = Promise.withResolvers();
  const boardUrl = '**/api/projects/*/board';
  await owner.route(
    '**/api/tasks/*/move',
    async (route) => {
      await sendMove.promise;
      await route.continue();
    },
    { times: 1 },
  );
  try {
    await prepare.dragTo(column(owner, 'To Do'));
    await column(owner, 'To Do')
      .getByRole('heading', { name: 'Prepare launch' })
      .waitFor();
    await savedMove(editor, () =>
      card(editor, 'Review launch').dragTo(column(editor, 'To Do')),
    );
    await owner.route(boardUrl, (route) =>
      route.fulfill({
        status: 503,
        json: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Board temporarily unavailable.',
          requestId: randomUUID(),
        },
      }),
    );
    const rejected = owner.waitForResponse(
      (response) =>
        response.url().endsWith('/move') &&
        response.request().method() === 'POST',
    );
    sendMove.resolve();
    const response = await rejected;
    assert.equal(response.status(), 409);
    assert.equal((await response.json()).code, 'VERSION_CONFLICT');
    await owner
      .getByRole('alert')
      .filter({
        hasText: 'The board changed. Refresh it and choose the position again.',
      })
      .waitFor();
    await owner
      .getByRole('button', { name: 'Retry refresh', exact: true })
      .waitFor();
    assert.deepEqual(await titles('In Progress'), [
      'Review launch',
      'Prepare launch',
    ]);
    assert.deepEqual(await titles('To Do'), []);
  } finally {
    sendMove.resolve();
    await owner.unroute(boardUrl);
  }
  await owner
    .getByRole('button', { name: 'Retry refresh', exact: true })
    .click();
  await column(owner, 'To Do')
    .getByRole('heading', { name: 'Review launch' })
    .waitFor();
  assert.deepEqual(await titles('In Progress'), ['Prepare launch']);

  const dialog = owner.getByRole('dialog', { name: 'Task details' });
  const button = (name) => dialog.getByRole('button', { name, exact: true });
  async function openMovement() {
    await prepare.press('Enter');
    await dialog.getByText('Move task', { exact: true }).press('Enter');
    await dialog.getByRole('group', { name: 'Task movement' }).waitFor();
  }
  async function closeMovement() {
    await button('Close dialog').press('Enter');
    await owner.waitForURL((url) => url.pathname.endsWith('/board'));
    await dialog.waitFor({ state: 'hidden' });
  }
  async function keyboardMove(name) {
    const enabled = button(name).and(dialog.locator('button:enabled'));
    await enabled.waitFor();
    await savedMove(owner, () => enabled.press('Enter'));
  }
  await openMovement();
  await keyboardMove('Move to To Do');
  await dialog.getByText('Position 2 of 2 in To Do', { exact: true }).waitFor();
  assert.ok(await button('Move down').isDisabled());
  // macOS WebKit uses Option+Tab to include buttons in keyboard navigation.
  await owner.keyboard.press(
    engine === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab',
  );
  assert.ok(
    await button('Move up').evaluate(
      (element) => element === document.activeElement,
    ),
    'After a cross-column move, Tab must reach the first available move action.',
  );
  await savedMove(owner, () => owner.keyboard.press('Enter'));
  await closeMovement();
  await owner.reload();
  await column(owner, 'To Do')
    .getByRole('heading', { name: 'Prepare launch' })
    .waitFor();
  assert.deepEqual(await titles('To Do'), ['Prepare launch', 'Review launch']);
  await openMovement();
  assert.ok(await button('Move up').isDisabled());
  await keyboardMove('Move down');
  await dialog.getByText('Position 2 of 2 in To Do', { exact: true }).waitFor();
  await closeMovement();
  await owner.getByRole('searchbox', { name: 'Search tasks' }).fill('Prepare');
  await owner.getByText('1 of 2 tasks', { exact: true }).waitFor();
  await openMovement();
  assert.equal(await button('Move up').count(), 0);
  assert.equal(await button('Move down').count(), 0);
  await keyboardMove('Move to In Progress');
  await closeMovement();
  await owner
    .getByRole('button', { name: 'Clear filters', exact: true })
    .press('Enter');
  await owner.getByText('2 of 2 tasks', { exact: true }).waitFor();
  await owner.reload();
  await column(owner, 'In Progress')
    .getByRole('heading', { name: 'Prepare launch' })
    .waitFor();
  assert.deepEqual(await titles('To Do'), ['Review launch']);
  console.info(
    'Browser workflow: optimistic move, conflict rollback, reconciliation, keyboard retry and persisted ordering passed.',
  );
}
async function openTask(page, title) {
  const response = page.waitForResponse(
    (response) =>
      /\/api\/tasks\/[^/]+$/.test(response.url()) &&
      response.request().method() === 'GET',
  );
  await page
    .getByRole('link')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) })
    .click();
  const loaded = await response;
  assert.equal(loaded.status(), 200);
  const task = await loaded.json();
  await page.getByText(`Version ${task.version}`, { exact: true }).waitFor();
  await page
    .getByRole('heading', { name: title, exact: true })
    .last()
    .waitFor();
}

async function postComment(page, text) {
  const section = page.getByRole('region', {
    name: 'Task comments',
    exact: true,
  });
  await section.getByLabel('Comment', { exact: true }).fill(text);
  const saved = page.waitForResponse(
    (response) =>
      /\/api\/tasks\/[^/]+\/comments$/.test(response.url()) &&
      response.request().method() === 'POST',
  );
  await section
    .getByRole('button', { name: 'Post comment', exact: true })
    .click();
  const response = await saved;
  assert.equal(response.status(), 201);
  const result = await response.json();
  assert.equal(
    'body' in result,
    false,
    'Comment mutation acknowledgements must not retain body text.',
  );
  await section
    .locator('.comment-row')
    .filter({ has: page.getByText(text, { exact: true }) })
    .waitFor();
  return result;
}

async function checkDiscussion({ owner, editor, mobile, editorContext, base }) {
  await owner.getByRole('button', { name: 'New project', exact: true }).click();
  await owner
    .getByLabel('Project name', { exact: true })
    .fill('Discussion acceptance');
  await owner
    .getByRole('dialog')
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await owner.waitForURL('**/board');
  const projectId = new URL(owner.url()).pathname.split('/')[2];
  await fixture.query(
    "INSERT INTO project_members(project_id, user_id, role) VALUES ($1, $2, 'Editor')",
    [projectId, localIdentities[1].id],
  );
  await createTask(owner, 'Discuss release');
  await openTask(owner, 'Discuss release');
  const taskId = new URL(owner.url()).pathname.split('/').at(-1);
  const literal =
    '<script>window.discussionExecuted=true</script><img src=x onerror="window.discussionExecuted=true">';
  await postComment(owner, literal);
  assert.equal(
    await owner
      .locator('.comment-section script, .comment-section img')
      .count(),
    0,
  );
  assert.equal(
    await owner.evaluate(() => window.discussionExecuted),
    undefined,
  );
  const enter = async (page) => {
    await page.goto(
      `${base}/sign-in?returnTo=${encodeURIComponent(`/projects/${projectId}/tasks/${taskId}`)}`,
    );
    await signIn(page, 'Jamie Lee');
    await page
      .getByRole('dialog')
      .getByRole('heading', { name: 'Discuss release', exact: true })
      .waitFor();
  };
  await enter(editor);
  const editorComments = editor.getByRole('region', {
    name: 'Task comments',
    exact: true,
  });
  const ownerRow = editorComments
    .locator('.comment-row')
    .filter({ has: editor.getByText(literal, { exact: true }) });
  await ownerRow.waitFor();
  assert.equal(
    await ownerRow
      .getByRole('button', { name: 'Edit comment', exact: true })
      .count(),
    0,
  );
  assert.equal(
    await ownerRow
      .getByRole('button', { name: 'Delete comment', exact: true })
      .count(),
    0,
  );
  const authored = await postComment(editor, 'Editor first comment');
  await editorComments
    .locator('.comment-row')
    .filter({ hasText: 'Editor first comment' })
    .getByRole('button', { name: 'Edit comment', exact: true })
    .click();
  await editor
    .getByLabel('Edit comment text', { exact: true })
    .fill('Editor conflict draft');
  await enter(mobile);
  const mobileComments = mobile.getByRole('region', {
    name: 'Task comments',
    exact: true,
  });
  await mobileComments
    .locator('.comment-row')
    .filter({ hasText: 'Editor first comment' })
    .getByRole('button', { name: 'Edit comment', exact: true })
    .click();
  await mobile
    .getByLabel('Edit comment text', { exact: true })
    .fill('Mobile saved comment');
  await mobile
    .getByRole('button', { name: 'Save comment', exact: true })
    .click();
  await mobileComments
    .getByText('Mobile saved comment', { exact: true })
    .waitFor();
  await mobileComments.getByText('Edited', { exact: true }).waitFor();
  assert.ok(
    await mobile
      .getByRole('dialog')
      .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
    'Mobile discussion overflows horizontally.',
  );
  await mobile.screenshot({
    path: resolve(output, 'mobile-dark-comments.png'),
  });
  await editor
    .getByRole('button', { name: 'Save comment', exact: true })
    .click();
  await editorComments
    .getByText('This comment has a newer version. Your draft is kept.', {
      exact: true,
    })
    .waitFor();
  await editorComments
    .locator('.conflict-review')
    .getByText('Mobile saved comment', { exact: true })
    .waitFor();
  assert.equal(
    await editor.getByLabel('Edit comment text', { exact: true }).inputValue(),
    'Editor conflict draft',
  );
  assert.ok(
    await editor
      .getByRole('button', { name: 'Save comment', exact: true })
      .isDisabled(),
  );
  await editor.screenshot({ path: resolve(output, 'comment-conflict.png') });
  await editor
    .getByRole('button', { name: /Continue editing against comment version/ })
    .click();
  await editor
    .getByRole('button', { name: 'Save comment', exact: true })
    .click();
  await editorComments
    .getByText('Editor conflict draft', { exact: true })
    .waitFor();
  await editorComments
    .getByLabel('Comment', { exact: true })
    .fill('Offline discussion draft');
  await editorContext.setOffline(true);
  await eventually(
    () =>
      editorComments
        .getByRole('button', { name: 'Post comment', exact: true })
        .isDisabled(),
    'Offline comment posting was not disabled.',
  );
  assert.equal(
    await editorComments.getByLabel('Comment', { exact: true }).inputValue(),
    'Offline discussion draft',
  );
  await editorContext.setOffline(false);
  await postComment(editor, 'Offline discussion draft');
  await editorComments
    .locator('.comment-row')
    .filter({ hasText: 'Editor conflict draft' })
    .getByRole('button', { name: 'Edit comment', exact: true })
    .click();
  await editor
    .getByLabel('Edit comment text', { exact: true })
    .fill('Draft kept after deletion');
  await owner
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await openTask(owner, 'Discuss release');
  const ownerComments = owner.getByRole('region', {
    name: 'Task comments',
    exact: true,
  });
  await ownerComments
    .locator('.comment-row')
    .filter({ hasText: 'Editor conflict draft' })
    .getByRole('button', { name: 'Delete comment', exact: true })
    .click();
  await ownerComments
    .locator('.comment-row')
    .filter({ hasText: 'Editor conflict draft' })
    .getByRole('button', { name: 'Confirm comment deletion', exact: true })
    .click();
  await ownerComments.getByText('Comment deleted', { exact: true }).waitFor();
  await editor
    .getByRole('button', { name: 'Save comment', exact: true })
    .click();
  await editorComments
    .locator('.conflict-review')
    .getByText('Comment deleted', { exact: true })
    .waitFor();
  assert.equal(
    await editor.getByLabel('Edit comment text', { exact: true }).inputValue(),
    'Draft kept after deletion',
  );
  assert.ok(
    await editor
      .getByRole('button', { name: 'Save comment', exact: true })
      .isDisabled(),
  );
  await editor
    .getByRole('button', { name: 'Cancel comment edit', exact: true })
    .click();
  assert.equal(
    (
      await fixture.query('SELECT body FROM comments WHERE id = $1', [
        authored.commentId,
      ])
    ).rows[0].body,
    null,
  );

  await owner
    .getByRole('button', { name: 'Archive task', exact: true })
    .click();
  await owner
    .getByRole('button', { name: 'Confirm archive', exact: true })
    .click();
  await owner
    .getByRole('button', { name: 'Restore task', exact: true })
    .waitFor();
  const literalRow = ownerComments
    .locator('.comment-row')
    .filter({ has: owner.getByText(literal, { exact: true }) });
  assert.equal(
    await literalRow
      .getByRole('button', { name: 'Edit comment', exact: true })
      .count(),
    0,
  );
  await literalRow
    .getByRole('button', { name: 'Delete comment', exact: true })
    .click();
  await literalRow
    .getByRole('button', { name: 'Confirm comment deletion', exact: true })
    .click();
  await eventually(
    async () =>
      (await ownerComments
        .getByText('Comment deleted', { exact: true })
        .count()) === 2,
    'Archived task comment deletion did not produce a tombstone.',
  );
  await owner
    .getByRole('button', { name: 'Restore task', exact: true })
    .click();
  await owner
    .getByRole('button', { name: 'Confirm restore', exact: true })
    .click();
  await owner.getByRole('button', { name: 'Edit task', exact: true }).waitFor();
  await owner
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await owner.getByRole('link', { name: 'Activity', exact: true }).click();
  await owner
    .getByRole('heading', { name: 'Project activity', exact: true })
    .waitFor();
  await owner
    .getByRole('region', { name: 'Project activity', exact: true })
    .getByText('deleted a comment', { exact: false })
    .first()
    .waitFor();
  assert.ok(
    !(await owner.locator('.activity-list').innerText()).includes(literal),
    'Activity must not retain deleted comment bodies.',
  );
  await owner.screenshot({
    path: resolve(output, 'project-activity.png'),
    fullPage: true,
  });
  await owner.getByRole('link', { name: 'Board', exact: true }).click();
  await owner.getByRole('link', { name: 'Members', exact: true }).click();
  await editorComments
    .getByLabel('Comment', { exact: true })
    .fill('Viewer comment draft retained');
  await owner.getByRole('button', { name: 'Make Viewer', exact: true }).click();
  await owner.getByRole('button', { name: 'Confirm', exact: true }).click();
  await owner.getByRole('dialog').waitFor({ state: 'hidden' });
  await editorComments
    .getByRole('button', { name: 'Post comment', exact: true })
    .click();
  await editorComments
    .getByText(
      'Only Owners and Editors can change comments. Your drafts are kept for copying.',
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await editorComments.getByLabel('Comment', { exact: true }).inputValue(),
    'Viewer comment draft retained',
  );
  assert.ok(
    await editorComments
      .getByRole('button', { name: 'Post comment', exact: true })
      .isDisabled(),
  );
  await owner.getByRole('button', { name: 'Remove', exact: true }).click();
  await owner.getByRole('button', { name: 'Confirm', exact: true }).click();
  await owner.getByRole('dialog').waitFor({ state: 'hidden' });
  const projectsAfterRemoval = editor.waitForResponse(
    (response) =>
      response.url() === `${base}/api/projects` &&
      response.request().method() === 'GET',
  );
  await editor
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await editor.waitForURL('**/projects');
  const projects = await projectsAfterRemoval;
  assert.equal(projects.status(), 200);
  assert.ok(
    !(await projects.json()).items.some((item) => item.id === projectId),
  );
  await editor
    .getByRole('heading', { name: 'Lifecycle collaboration', exact: true })
    .waitFor();
  await editor.goto(`${base}/projects/${projectId}/activity`);
  await editor.waitForURL('**/projects');
  assert.equal(await editor.locator('.comment-section').count(), 0);
  assert.deepEqual(
    errors,
    [],
    'Discussion workflows reported browser runtime errors.',
  );
  console.info(
    'Browser workflow: plain-text comments, author permissions, mobile editing, version conflicts, offline drafts, Owner moderation, deleted draft preservation, archived-task deletion, activity, downgrade, and revocation passed.',
  );
}

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  await fixture.connect();
  for (const name of (await readdir('apps/api/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort())
    await fixture.query(await readFile(`apps/api/migrations/${name}`, 'utf8'));
  for (const user of localIdentities)
    await fixture.query(
      'INSERT INTO users(id, identity_subject, email, display_name) VALUES ($1, $2, $3, $4)',
      [user.id, `local:${user.id}`, user.email, user.displayName],
    );

  const apiPort = await port();
  const apiBase = `http://127.0.0.1:${apiPort}`;
  const webPort = await port();
  const base = `http://127.0.0.1:${webPort}`;
  await mkdir(resolve('.local'), { recursive: true });
  stateRoot = await mkdtemp(resolve('.local/browser-state-'));
  const api = spawn(process.execPath, ['apps/api/dist/main.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      RATE_LIMITS_ENABLED: 'false',
      LOCAL_STATE_DIR: stateRoot,
      IDENTITY_PROVIDER: 'local',
      API_HOST: '127.0.0.1',
      API_PORT: String(apiPort),
      WEB_ORIGIN: base,
      DATABASE_URL: databaseUrl.href,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(api);
  let diagnostic = '';
  for (const stream of [api.stdout, api.stderr])
    stream.on('data', (chunk) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-4000);
    });
  await eventually(
    async () => {
      if (api.exitCode !== null)
        throw new Error(`API startup failed: ${diagnostic}`);
      try {
        return (await fetch(`${apiBase}/api/health/ready`)).ok;
      } catch {
        return false;
      }
    },
    'API did not become ready.',
    30000,
  );

  const dist = resolve('apps/web/dist');
  const mime = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
  };
  web = createHttpServer(async (request, response) => {
    if (request.url.startsWith('/api/')) {
      const upstream = proxyRequest(
        new URL(request.url, apiBase),
        { method: request.method, headers: request.headers },
        (incoming) => {
          response.writeHead(incoming.statusCode, incoming.headers);
          incoming.pipe(response);
        },
      );
      upstream.on('error', () => {
        response.writeHead(502);
        response.end();
      });
      response.once('close', () => upstream.destroy());
      request.pipe(upstream);
      return;
    }
    try {
      const pathname = decodeURIComponent(new URL(request.url, base).pathname);
      let file = resolve(dist, `.${pathname}`);
      if (!file.startsWith(`${dist}/`)) file = resolve(dist, 'index.html');
      let bytes;
      try {
        bytes = await readFile(file);
      } catch {
        file = resolve(dist, 'index.html');
        bytes = await readFile(file);
      }
      response.writeHead(200, {
        'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
      });
      response.end(bytes);
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  web.listen(webPort, '127.0.0.1');
  await once(web, 'listening');
  await mkdir(output, { recursive: true });
  browser = await { chromium, firefox, webkit }[engine].launch({
    ...(process.env.BROWSER_EXECUTABLE
      ? { executablePath: process.env.BROWSER_EXECUTABLE }
      : {}),
    headless: true,
  });
  const ownerContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const editorContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  // Use an HTTP outage for polling-only scenarios. A transport abort can
  // surface as a page error in WebKit even when the client handles it.
  const eventsUnavailable = (route) => route.fulfill({ status: 503, body: '' });
  await ownerContext.route('**/api/events', eventsUnavailable);
  await editorContext.route('**/api/events', eventsUnavailable);
  const owner = await ownerContext.newPage();
  const editor = await editorContext.newPage();
  pages.push(['owner', owner], ['editor', editor]);
  for (const page of [owner, editor]) {
    page.setDefaultTimeout(12000);
    page.on('pageerror', (error) => errors.push(error.message));
  }

  await owner.goto(`${base}/demo/activity`);
  const publicActivity = owner.getByRole('region', {
    name: 'Project activity',
  });
  await publicActivity
    .getByRole('link', { name: 'Map the onboarding journey' })
    .first()
    .click();
  const sampleDrawer = owner.getByRole('dialog');
  const sampleComments = sampleDrawer.getByRole('region', {
    name: 'Task comments',
  });
  await sampleComments
    .getByText('The current map starts at sign-in.', { exact: false })
    .waitFor();
  assert.equal(await sampleComments.getByRole('article').count(), 3);
  assert.equal(
    await sampleDrawer
      .getByRole('region', { name: 'Task activity' })
      .getByRole('listitem')
      .count(),
    4,
  );
  await sampleDrawer
    .getByText('onboarding-outline.md', { exact: true })
    .click();
  await sampleDrawer
    .getByText('Invitation email → sign-in', { exact: false })
    .waitFor();
  assert.equal(await sampleDrawer.getByRole('textbox').count(), 0);
  assert.equal(
    await sampleDrawer
      .getByRole('button', { name: /add|post|delete|edit|upload/i })
      .count(),
    0,
  );
  await sampleDrawer.getByRole('button', { name: 'Close dialog' }).click();
  await owner.waitForURL('**/demo/activity');
  await publicActivity.getByText('View changes').first().click();
  await publicActivity.getByText('In Progress → Done').first().waitFor();

  await owner.goto(`${base}/sign-in`);
  await signIn(owner, 'Alex Morgan');
  await owner.waitForURL('**/projects');
  await owner.getByRole('button', { name: 'New project', exact: true }).click();
  await owner.getByLabel('Project name').fill('Browser collaboration');
  await owner
    .getByRole('dialog')
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await owner.waitForURL('**/board');
  const projectId = new URL(owner.url()).pathname.split('/')[2];
  const invitationFixtures = Array.from({ length: 25 }, (_, index) => ({
    id: randomUUID(),
    email: `page${index}@example.com`,
    hash: randomBytes(32).toString('hex'),
  }));
  await fixture.query(
    `INSERT INTO invitations(id, project_id, email, role, token_hash, expires_at, created_at) SELECT item.id, $1, item.email, 'Viewer', item.hash, now() + interval '1 day', '2026-11-19T12:00:00.123456Z' FROM jsonb_to_recordset($2::jsonb) AS item(id uuid, email text, hash text)`,
    [projectId, JSON.stringify(invitationFixtures)],
  );
  await owner.getByRole('link', { name: 'Members', exact: true }).click();
  const invitations = owner.locator('section').filter({
    has: owner.getByRole('heading', {
      name: 'Pending invitations',
      exact: true,
    }),
  });
  await invitations
    .getByRole('button', { name: 'Load more invitations', exact: true })
    .waitFor();
  assert.equal(await invitations.locator('article').count(), 20);
  const failNextPage = async (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Invitation page is temporarily unavailable.',
        requestId: randomUUID(),
      }),
    });
  await owner.route('**/invitations?cursor=*', failNextPage, { times: 1 });
  await invitations
    .getByRole('button', { name: 'Load more invitations', exact: true })
    .click();
  await invitations
    .getByText('Invitation page is temporarily unavailable.', { exact: true })
    .waitFor();
  assert.equal(
    await invitations.locator('article').count(),
    20,
    'Failed pagination must preserve the loaded invitations.',
  );
  await invitations
    .getByRole('button', { name: 'Try again', exact: true })
    .click();
  await eventually(
    async () => (await invitations.locator('article').count()) === 25,
    'Invitation pagination did not recover.',
  );
  assert.equal(
    await invitations
      .getByRole('button', { name: 'Load more invitations', exact: true })
      .count(),
    0,
  );
  await invitations
    .locator('article')
    .first()
    .getByRole('button', { name: 'Revoke', exact: true })
    .click();
  await owner
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm', exact: true })
    .click();
  await owner.getByRole('dialog').waitFor({ state: 'hidden' });
  await eventually(
    async () => (await invitations.locator('article').count()) === 24,
    'Invitation pages did not refresh after revocation.',
  );
  await owner.screenshot({
    path: resolve(output, 'desktop-invitation-pagination.png'),
    fullPage: true,
  });
  const quotaMembers = Array.from({ length: 9 }, (_, index) => ({
    id: randomUUID(),
    email: `quota${index}@example.com`,
  }));
  await fixture.query(
    `INSERT INTO users(id, identity_subject, email, display_name) SELECT item.id, 'local:' || item.id, item.email, 'Quota member' FROM jsonb_to_recordset($1::jsonb) AS item(id uuid, email text)`,
    [JSON.stringify(quotaMembers)],
  );
  await fixture.query(
    `INSERT INTO project_members(project_id, user_id, role) SELECT $1, item.id, 'Viewer' FROM jsonb_to_recordset($2::jsonb) AS item(id uuid)`,
    [projectId, JSON.stringify(quotaMembers)],
  );
  await owner
    .getByRole('button', { name: 'Invite member', exact: true })
    .click();
  await owner.getByLabel('Email address').fill('jamie@example.com');
  await owner
    .getByRole('button', { name: 'Create invitation', exact: true })
    .click();
  await owner
    .getByRole('alert')
    .filter({ hasText: '10 of 10 project members used.' })
    .waitFor();
  assert.equal(
    await owner.getByLabel('Email address').inputValue(),
    'jamie@example.com',
  );
  await owner.screenshot({
    path: resolve(output, 'desktop-member-quota.png'),
    fullPage: true,
  });
  await fixture.query(
    'DELETE FROM project_members WHERE project_id = $1 AND user_id = ANY($2::uuid[])',
    [projectId, quotaMembers.map((member) => member.id)],
  );
  // Keep synthetic user identities referenced by recipient delivery history.
  // The entire fixture database is removed after this run.
  await owner
    .getByRole('button', { name: 'Create invitation', exact: true })
    .click();
  const link = await owner
    .getByRole('textbox', { name: 'Invitation link', exact: true })
    .inputValue();
  assert.ok(
    /\/invite#token=[a-f0-9]{64}$/.test(link),
    'Invitation must use a fragment credential.',
  );
  console.info(
    'Browser workflow: invitation pagination, failed-page recovery, revocation, quota usage feedback, and retry passed.',
  );
  await editorContext.request.delete(`${base}/api/auth/session`);
  await editor.goto(link);
  await eventually(
    () => !new URL(editor.url()).hash,
    'Invitation credential remained in the address bar.',
  );
  await editor
    .getByRole('link', { name: 'Sign in to accept', exact: true })
    .click();
  await signIn(editor, 'Jamie Lee');
  await editor
    .getByRole('button', { name: 'Accept invitation', exact: true })
    .click();
  await editor.waitForURL('**/board');
  assert.ok(
    (await editor.locator('.project-heading').innerText()).includes('Editor'),
  );
  console.info(
    'Browser workflow: invitation accepted by the independent Editor account.',
  );
  await owner
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await owner.getByRole('link', { name: 'Board', exact: true }).click();
  captureFailure = true;
  await editor
    .getByRole('link', { name: 'Notifications', exact: true })
    .click();
  await editor
    .getByRole('heading', { name: 'No notifications', exact: true })
    .waitFor();
  await editorContext.setOffline(true);
  await createTask(owner, 'Prepare launch', localIdentities[1].id);
  await createTask(owner, 'Review launch');
  await editor
    .getByText(
      'You are offline. Loaded notifications are kept; read actions are paused.',
      { exact: true },
    )
    .waitFor();
  await editorContext.setOffline(false);
  await editor
    .getByRole('link', { name: 'Prepare launch', exact: true })
    .waitFor();
  await editor
    .locator('.notification-count')
    .getByText('1 unread notification', { exact: true })
    .waitFor();
  assert.equal(await editor.locator('.notification-row').count(), 1);
  await editor.screenshot({
    path: resolve(output, 'desktop-notifications.png'),
    fullPage: true,
  });
  await editor
    .getByRole('button', { name: 'Mark as read', exact: true })
    .click();
  await editor
    .locator('.notification-count')
    .getByText('0 unread notifications', { exact: true })
    .waitFor();
  await editor
    .getByRole('link', { name: 'Prepare launch', exact: true })
    .click();
  await editor
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await editor.waitForURL('**/board');
  console.info(
    'Browser workflow: offline assignment persistence, reconnection refresh, recipient unread count, individual read, and task navigation passed.',
  );

  const boardCard = (title) =>
    owner.locator('.task-card').filter({
      has: owner.getByRole('heading', { name: title, exact: true }),
    });
  const target = await boardCard('Review launch').boundingBox();
  await savedMove(owner, () =>
    boardCard('Prepare launch').dragTo(boardCard('Review launch'), {
      targetPosition: { x: 20, y: target.height - 3 },
    }),
  );
  assert.deepEqual(
    await owner
      .getByRole('region', { name: 'To Do', exact: true })
      .locator('.task-card h3')
      .allTextContents(),
    ['Review launch', 'Prepare launch'],
  );
  await owner.getByRole('searchbox', { name: 'Search tasks' }).fill('Prepare');
  await savedMove(owner, () =>
    boardCard('Prepare launch').dragTo(
      owner.getByRole('region', { name: 'In Progress', exact: true }),
    ),
  );
  await owner.getByRole('searchbox', { name: 'Search tasks' }).fill('');
  await savedMove(owner, () =>
    boardCard('Review launch').dragTo(boardCard('Prepare launch'), {
      targetPosition: { x: 20, y: 2 },
    }),
  );
  assert.deepEqual(
    await owner
      .getByRole('region', { name: 'In Progress', exact: true })
      .locator('.task-card h3')
      .allTextContents(),
    ['Review launch', 'Prepare launch'],
  );
  await owner.screenshot({
    path: resolve(output, 'desktop-board.png'),
    fullPage: true,
  });
  console.info(
    'Browser workflow: assignment, card ordering, filtered movement, and cross-column drag passed.',
  );

  await checkMoveRecovery(owner, editor);
  // Creating as the second account refreshes its snapshot without waiting for polling.
  await createTask(editor, 'Editor follow-up');
  await owner
    .getByRole('link')
    .filter({
      has: owner.getByRole('heading', { name: 'Prepare launch', exact: true }),
    })
    .click();
  await owner.getByRole('button', { name: 'Edit task', exact: true }).click();
  await owner.getByLabel('Task title', { exact: true }).fill('Owner draft');
  await editor
    .getByRole('link')
    .filter({
      has: editor.getByRole('heading', { name: 'Prepare launch', exact: true }),
    })
    .click();
  await editor.getByRole('button', { name: 'Edit task', exact: true }).click();
  await editor
    .getByLabel('Task title', { exact: true })
    .fill('Editor saved title');
  await editor
    .getByRole('button', { name: 'Save changes', exact: true })
    .click();
  await editor
    .getByRole('dialog')
    .getByRole('heading', { name: 'Editor saved title', exact: true })
    .waitFor();
  await owner
    .getByRole('button', { name: 'Save changes', exact: true })
    .click();
  await owner
    .getByRole('heading', {
      name: 'This task has a newer version',
      exact: true,
    })
    .waitFor();
  assert.equal(
    await owner.getByLabel('Task title', { exact: true }).inputValue(),
    'Owner draft',
  );
  await owner
    .locator('.conflict-review')
    .getByText('Editor saved title', { exact: true })
    .waitFor();
  await owner.screenshot({
    path: resolve(output, 'edit-conflict.png'),
    fullPage: true,
  });
  await owner
    .getByRole('button', { name: /Continue editing against version/ })
    .click();
  await owner
    .getByRole('button', { name: 'Save changes', exact: true })
    .click();
  await owner
    .getByRole('dialog')
    .getByRole('heading', { name: 'Owner draft', exact: true })
    .waitFor();

  await owner.getByRole('button', { name: 'Edit task', exact: true }).click();
  await owner
    .getByLabel('Description', { exact: true })
    .fill('Offline draft retained');
  await ownerContext.setOffline(true);
  await eventually(
    () =>
      owner
        .getByRole('button', { name: 'Save changes', exact: true })
        .isDisabled(),
    'Offline saving was not disabled.',
  );
  assert.equal(
    await owner.getByLabel('Description', { exact: true }).inputValue(),
    'Offline draft retained',
  );
  await ownerContext.setOffline(false);
  await eventually(
    async () =>
      !(await owner
        .getByRole('button', { name: 'Save changes', exact: true })
        .isDisabled()),
    'Online saving did not recover.',
  );
  await owner
    .getByRole('button', { name: 'Save changes', exact: true })
    .click();
  await owner.getByRole('button', { name: 'Edit task', exact: true }).waitFor();

  console.info(
    'Browser workflow: edit conflict review and offline draft recovery passed.',
  );

  await editor.getByRole('button', { name: 'Edit task', exact: true }).click();
  await editor
    .getByLabel('Task title', { exact: true })
    .fill('Viewer draft retained');
  await owner
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await owner.getByRole('link', { name: 'Members', exact: true }).click();
  await owner.getByRole('button', { name: 'Make Viewer', exact: true }).click();
  await owner.getByRole('button', { name: 'Confirm', exact: true }).click();
  await owner.getByRole('dialog').waitFor({ state: 'hidden' });
  await editor
    .getByRole('button', { name: 'Save changes', exact: true })
    .click();
  await editor
    .getByText('Your role is now Viewer.', { exact: false })
    .waitFor();
  assert.equal(
    await editor.getByLabel('Task title', { exact: true }).inputValue(),
    'Viewer draft retained',
  );
  assert.ok(
    await editor
      .getByRole('button', { name: 'Save changes', exact: true })
      .isDisabled(),
  );
  await owner.getByRole('button', { name: 'Remove', exact: true }).click();
  await owner.getByRole('button', { name: 'Confirm', exact: true }).click();
  await owner.getByRole('dialog').waitFor({ state: 'hidden' });
  await editor
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await editor.waitForURL('**/projects');
  await editor
    .getByText('This project is missing or your access has been removed.', {
      exact: true,
    })
    .waitFor();
  console.info(
    'Browser workflow: Viewer downgrade and membership revocation passed.',
  );
  await editor
    .getByRole('link', { name: 'Notifications', exact: true })
    .click();
  await editor
    .getByText('Task no longer accessible', { exact: true })
    .waitFor();
  assert.equal(
    await editor.locator('.notification-task').count(),
    0,
    'Revoked notification targets must not expose task links.',
  );
  assert.ok(
    !(await editor.locator('.notification-list').innerText()).includes(
      'Owner draft',
    ),
  );

  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'light',
    ...(engine === 'firefox' ? {} : { isMobile: true }),
    hasTouch: true,
  });
  await mobileContext.route('**/api/events', eventsUnavailable);
  const mobile = await mobileContext.newPage();
  pages.push(['mobile', mobile]);
  mobile.setDefaultTimeout(12000);
  mobile.on('pageerror', (error) => errors.push(error.message));
  await mobile.goto(`${base}/sign-in`);
  await signIn(mobile, 'Alex Morgan');
  await mobile
    .locator('.project-card')
    .filter({ hasText: 'Browser collaboration' })
    .click();
  await mobile.getByRole('button', { name: /^In Progress/ }).click();
  await mobile
    .getByRole('button', { name: 'Switch to dark mode', exact: true })
    .click();
  await savedMove(mobile, () =>
    mobile
      .locator('.task-card')
      .filter({
        has: mobile.getByRole('heading', { name: 'Owner draft', exact: true }),
      })
      .dragTo(mobile.getByRole('button', { name: /^Done/ })),
  );
  await mobile
    .getByRole('heading', { name: 'Owner draft', exact: true })
    .waitFor();
  assert.ok(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    'Mobile board overflows horizontally.',
  );
  await mobile.screenshot({
    path: resolve(output, 'mobile-dark-board.png'),
    fullPage: true,
  });
  await mobile
    .getByRole('link')
    .filter({
      has: mobile.getByRole('heading', { name: 'Owner draft', exact: true }),
    })
    .click();
  assert.equal(
    await mobile
      .getByRole('dialog')
      .evaluate((dialog) => Math.round(dialog.getBoundingClientRect().width)),
    390,
  );
  assert.ok(
    await mobile.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
    'Mobile task details overflow the viewport.',
  );
  await mobile.screenshot({
    path: resolve(output, 'mobile-task.png'),
    fullPage: true,
  });
  assert.deepEqual(errors, [], 'Browser runtime errors were reported.');
  const assignments = await fixture.query(
    'SELECT assignee_id FROM tasks WHERE project_id = $1',
    [projectId],
  );
  assert.ok(assignments.rows.every((row) => row.assignee_id === null));

  // Rejoin the independent account for lifecycle acceptance after revocation.
  await owner
    .getByRole('button', { name: 'Invite member', exact: true })
    .click();
  await owner.getByLabel('Email address').fill('jamie@example.com');
  await owner
    .getByRole('button', { name: 'Create invitation', exact: true })
    .click();
  const rejoinLink = await owner
    .getByRole('textbox', { name: 'Invitation link', exact: true })
    .inputValue();
  await editorContext.request.delete(`${base}/api/auth/session`);
  await editor.goto(rejoinLink);
  await editor
    .getByRole('link', { name: 'Sign in to accept', exact: true })
    .click();
  await signIn(editor, 'Jamie Lee');
  await editor
    .getByRole('button', { name: 'Accept invitation', exact: true })
    .click();
  await editor.waitForURL('**/board');
  await owner
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await owner.getByRole('link', { name: 'Board', exact: true }).click();
  await openTask(owner, 'Owner draft');
  await owner
    .getByRole('button', { name: 'Archive task', exact: true })
    .click();
  await owner
    .getByRole('button', { name: 'Confirm archive', exact: true })
    .click();
  await owner
    .getByRole('button', { name: 'Restore task', exact: true })
    .waitFor();
  assert.equal(
    await owner.getByRole('button', { name: 'Edit task', exact: true }).count(),
    0,
  );
  assert.equal(
    await owner
      .getByRole('dialog')
      .getByText('Move task', { exact: true })
      .count(),
    0,
  );
  await owner
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  assert.equal(
    await owner
      .locator('.task-card')
      .filter({ hasText: 'Owner draft' })
      .count(),
    0,
  );
  await owner
    .getByRole('link', { name: 'Archived tasks', exact: true })
    .click();
  await owner.getByRole('link', { name: 'Owner draft', exact: true }).waitFor();
  await owner.screenshot({
    path: resolve(output, 'archived-tasks.png'),
    fullPage: true,
  });
  await mobile
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await mobile
    .getByRole('link', { name: 'Archived tasks', exact: true })
    .click();
  await mobile
    .getByRole('link', { name: 'Owner draft', exact: true })
    .waitFor();
  assert.ok(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    'Mobile archive list overflows horizontally.',
  );
  await mobile.screenshot({
    path: resolve(output, 'mobile-dark-archives.png'),
    fullPage: true,
  });
  await owner.getByRole('link', { name: 'Owner draft', exact: true }).click();
  await owner
    .getByRole('button', { name: 'Restore task', exact: true })
    .click();
  await owner
    .getByRole('button', { name: 'Confirm restore', exact: true })
    .click();
  await owner.getByRole('button', { name: 'Edit task', exact: true }).waitFor();
  await owner
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await owner.waitForURL('**/archived-tasks');
  await owner
    .getByRole('heading', { name: 'No archived tasks', exact: true })
    .waitFor();
  await owner.getByRole('link', { name: 'Board', exact: true }).click();
  await owner.getByRole('link', { name: 'Settings', exact: true }).click();
  await owner
    .getByLabel('Project name', { exact: true })
    .fill('Lifecycle collaboration');
  await owner
    .getByLabel('Project description', { exact: true })
    .fill('Project lifecycle acceptance.');
  await owner
    .getByRole('button', { name: 'Save project details', exact: true })
    .click();
  await owner.getByText('Project details saved.', { exact: true }).waitFor();
  await owner.screenshot({
    path: resolve(output, 'project-settings.png'),
    fullPage: true,
  });
  await mobile.getByRole('link', { name: 'Board', exact: true }).click();
  await mobile.getByRole('link', { name: 'Settings', exact: true }).click();
  await mobile
    .getByRole('heading', { name: 'Project settings', exact: true })
    .waitFor();
  assert.ok(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    'Mobile settings overflow horizontally.',
  );
  await mobile.screenshot({
    path: resolve(output, 'mobile-dark-settings.png'),
    fullPage: true,
  });

  await openTask(editor, 'Review launch');
  await editor.getByRole('button', { name: 'Edit task', exact: true }).click();
  await editor
    .getByLabel('Task title', { exact: true })
    .fill('Archived project draft retained');
  await owner
    .getByRole('button', { name: 'Archive project', exact: true })
    .click();
  await owner
    .getByRole('button', { name: 'Confirm archive', exact: true })
    .click();
  await owner
    .getByRole('button', { name: 'Restore project', exact: true })
    .waitFor();
  assert.ok(
    await owner
      .getByLabel('Project name', { exact: true })
      .evaluate((input) => input.readOnly),
  );
  await editor
    .getByRole('button', { name: 'Save changes', exact: true })
    .click();
  await editor
    .getByText('This project is archived. Your draft is kept for copying.', {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await editor.getByLabel('Task title', { exact: true }).inputValue(),
    'Archived project draft retained',
  );
  assert.ok(
    await editor
      .getByRole('button', { name: 'Save changes', exact: true })
      .isDisabled(),
  );
  await owner.getByRole('link', { name: 'Board', exact: true }).click();
  await owner
    .getByText('This project is archived and read only.', { exact: false })
    .waitFor();
  assert.equal(
    await owner.getByRole('button', { name: 'New task', exact: true }).count(),
    0,
  );
  await owner.getByRole('link', { name: 'Settings', exact: true }).click();
  await owner
    .getByRole('button', { name: 'Restore project', exact: true })
    .click();
  await owner
    .getByRole('button', { name: 'Confirm restore', exact: true })
    .click();
  await owner
    .getByRole('button', { name: 'Archive project', exact: true })
    .waitFor();
  await owner
    .getByRole('button', { name: 'Leave project', exact: true })
    .click();
  await owner
    .getByText('Transfer ownership to another member before leaving.', {
      exact: false,
    })
    .waitFor();
  assert.equal(
    await owner
      .getByRole('button', { name: 'Confirm departure', exact: true })
      .count(),
    0,
  );
  await owner
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await owner
    .getByLabel('New Owner', { exact: true })
    .selectOption(localIdentities[1].id);
  await owner
    .getByRole('button', { name: 'Transfer ownership', exact: true })
    .click();
  await owner
    .getByRole('dialog')
    .getByText('Jamie Lee', { exact: false })
    .waitFor();
  await owner
    .getByRole('button', { name: 'Confirm transfer', exact: true })
    .click();
  await owner
    .getByText('Project settings are managed by the current Owner.', {
      exact: false,
    })
    .waitFor();
  await owner
    .getByRole('button', { name: 'Leave project', exact: true })
    .click();
  await owner
    .getByRole('button', { name: 'Confirm departure', exact: true })
    .click();
  await owner.waitForURL('**/projects');
  await owner
    .getByText('You left Lifecycle collaboration.', { exact: true })
    .waitFor();
  assert.equal(
    await owner
      .locator('.project-card')
      .filter({ hasText: 'Lifecycle collaboration' })
      .count(),
    0,
  );
  await editor
    .getByRole('button', { name: 'Discard draft', exact: true })
    .click();
  await editor
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await editor.getByRole('link', { name: 'Members', exact: true }).click();
  await editor
    .locator('.member-list')
    .getByText('Owner', { exact: true })
    .waitFor();
  await editor.getByRole('link', { name: 'Board', exact: true }).click();
  await editor.getByRole('link', { name: 'Settings', exact: true }).click();
  await editor
    .getByRole('button', { name: 'Archive project', exact: true })
    .click();
  await editor
    .getByRole('button', { name: 'Confirm archive', exact: true })
    .click();
  await editor
    .getByRole('button', { name: 'Restore project', exact: true })
    .click();
  await editor
    .getByRole('button', { name: 'Confirm restore', exact: true })
    .click();
  await editor
    .getByRole('button', { name: 'Archive project', exact: true })
    .waitFor();
  const finalMembers = await fixture.query(
    'SELECT user_id, role FROM project_members WHERE project_id = $1',
    [projectId],
  );
  assert.deepEqual(finalMembers.rows, [
    { user_id: localIdentities[1].id, role: 'Owner' },
  ]);
  assert.equal(
    (
      await fixture.query('SELECT status FROM projects WHERE id = $1', [
        projectId,
      ])
    ).rows[0].status,
    'active',
  );
  assert.deepEqual(
    errors,
    [],
    'Lifecycle workflows reported browser runtime errors.',
  );
  console.info(
    'Browser lifecycle checks passed: task archives, restoration, project settings, archived read-only drafts, Owner departure prevention, ownership transfer, departure, and the new Owner controls.',
  );
  const assignedTask = (
    await fixture.query(
      "SELECT id FROM tasks WHERE project_id = $1 AND title = 'Owner draft'",
      [projectId],
    )
  ).rows[0].id;
  const notificationFixtures = Array.from({ length: 25 }, () => ({
    id: randomUUID(),
    eventId: randomUUID(),
  }));
  await fixture.query(
    `INSERT INTO notifications(id, recipient_id, actor_id, project_id, task_id, type, source_event_id) SELECT item.id, $1, $2, $3, $4, 'task_assigned', item."eventId" FROM jsonb_to_recordset($5::jsonb) AS item(id uuid, "eventId" uuid)`,
    [
      localIdentities[1].id,
      localIdentities[0].id,
      projectId,
      assignedTask,
      JSON.stringify(notificationFixtures),
    ],
  );
  await mobile.goto(`${base}/sign-in`);
  await signIn(mobile, 'Jamie Lee');
  await mobile
    .getByRole('link', { name: 'Notifications', exact: true })
    .click();
  await mobile
    .getByRole('button', { name: 'Load more notifications', exact: true })
    .waitFor();
  assert.equal(await mobile.locator('.notification-row').count(), 20);
  await mobile.route(
    '**/notifications?cursor=*',
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'SERVICE_UNAVAILABLE',
          message: 'A notification page is temporarily unavailable.',
          requestId: randomUUID(),
        }),
      }),
    { times: 1 },
  );
  await mobile
    .getByRole('button', { name: 'Load more notifications', exact: true })
    .click();
  await mobile
    .getByText('A notification page is temporarily unavailable.', {
      exact: true,
    })
    .waitFor();
  assert.equal(await mobile.locator('.notification-row').count(), 20);
  await mobile.getByRole('button', { name: 'Try again', exact: true }).click();
  await eventually(
    async () => (await mobile.locator('.notification-row').count()) === 26,
    'Notification pagination failed to recover.',
  );
  assert.ok(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    'Mobile notifications overflow horizontally.',
  );
  await mobile.screenshot({
    path: resolve(output, 'mobile-dark-notifications.png'),
  });
  const readAllIds = [];
  await mobile.route(
    '**/api/notifications/read-all',
    async (route) => {
      readAllIds.push(route.request().postDataJSON().requestId);
      if (readAllIds.length > 1) return route.continue();
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      // Lose the response after commit, then deliver a new notification.
      await fixture.query(
        "INSERT INTO notifications(id, recipient_id, actor_id, project_id, task_id, type, source_event_id) VALUES ($1, $2, $3, $4, $5, 'task_assigned', $6)",
        [
          randomUUID(),
          localIdentities[1].id,
          localIdentities[0].id,
          projectId,
          assignedTask,
          randomUUID(),
        ],
      );
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'SERVICE_UNAVAILABLE',
          message:
            'Unable to confirm read status. Retry to confirm the original operation.',
          requestId: randomUUID(),
        }),
      });
    },
    { times: 2 },
  );
  await mobile
    .getByRole('button', { name: 'Mark all as read', exact: true })
    .click();
  await mobile
    .getByText(
      'Unable to confirm read status. Retry to confirm the original operation.',
      { exact: true },
    )
    .waitFor();
  await mobile
    .locator('.notification-count')
    .getByText('1 unread notification', { exact: true })
    .waitFor();
  await mobile
    .getByRole('button', { name: 'Mark all as read', exact: true })
    .click();
  await mobile
    .getByText('Notifications marked as read. New arrivals remain unread.', {
      exact: true,
    })
    .waitFor();
  assert.equal(readAllIds.length, 2);
  assert.equal(
    readAllIds[0],
    readAllIds[1],
    'A failed bulk read retry must preserve its request ID.',
  );
  assert.equal(
    await mobile.locator('.notification-row.unread').count(),
    1,
    'The old bulk read must preserve a later notification.',
  );
  await mobile
    .getByRole('button', { name: 'Mark all as read', exact: true })
    .click();
  await mobile
    .locator('.notification-count')
    .getByText('0 unread notifications', { exact: true })
    .waitFor();
  assert.deepEqual(
    errors,
    [],
    'Notification workflows reported browser runtime errors.',
  );
  console.info(
    'Browser workflow: mobile notification pages, failed-page recovery, bulk read retries after a lost response, and late notification preservation passed.',
  );
  await checkDiscussion({ owner, editor, mobile, editorContext, base });
  await checkLocalResources({
    owner,
    editor,
    mobile,
    editorContext,
    fixture,
    base,
    output,
    createTask,
    openTask,
    signIn,
    eventually,
    errors,
  });
  const identityMeasurements = await checkIdentity({
    browser,
    base,
    output,
    pages,
    errors,
  });
  await mkdir('engineering/validation', { recursive: true });
  await writeFile(
    resolve('engineering/validation', `local-browser-${engine}.json`),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        engine,
        version: browser.version(),
        scope: 'Local PostgreSQL and local identity/file/SSE adapters; no AWS',
        desktopViewport: { width: 1440, height: 1000 },
        mobileViewport: { width: 390, height: 844 },
        passed: true,
        measurements: identityMeasurements,
        workflows: [
          'invitations and quotas',
          'task edits and conflicts',
          'drag and keyboard movement, conflict rollback and persisted ordering',
          'notifications and read retries',
          'comments and activity',
          'lifecycle and ownership',
          'offline drafts and revocation',
          'private attachments and live hints',
          'permanent projects and interactive sample',
          '500-task board',
          'email identity and session recovery',
          'mobile layout and themes',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.info(
    `Browser checks passed: ${engine} ${browser.version()}, independent accounts, tasks, collaboration, attachments, sample projects, identity, mobile, and themes.`,
  );
  console.info(`Screenshots: ${output}`);
} catch (error) {
  if (captureFailure) {
    for (const [name, page] of pages) {
      if (name === 'mobile')
        console.info(
          'Mobile layout diagnostics:',
          await page.evaluate(() => ({
            width: innerWidth,
            client: document.documentElement.clientWidth,
            scroll: document.documentElement.scrollWidth,
            overflow: [...document.querySelectorAll('body *')]
              .filter((element) => {
                const rect = element.getBoundingClientRect();
                return (
                  rect.width &&
                  rect.right > document.documentElement.clientWidth + 1
                );
              })
              .slice(0, 20)
              .map((element) => ({
                tag: element.tagName,
                class: String(element.className),
                right: element.getBoundingClientRect().right,
                width: element.getBoundingClientRect().width,
              })),
          })),
        );
      await page
        .screenshot({
          path: resolve(output, `failure-${name}.png`),
          fullPage: true,
        })
        .catch(() => {});
      console.info(`${name} failure location: ${new URL(page.url()).pathname}`);
    }
  }
  throw error;
} finally {
  await browser?.close();
  if (web) await new Promise((done) => web.close(done));
  for (const child of children) await stop(child);
  await fixture.end().catch(() => {});
  if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
  await admin.end();
  if (stateRoot) await rm(stateRoot, { recursive: true, force: true });
}
