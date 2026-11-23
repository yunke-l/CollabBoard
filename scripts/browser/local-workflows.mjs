import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export async function checkLocalResources({
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
}) {
  await owner.context().unroute('**/api/events');
  await mobile.context().unroute('**/api/events');
  await owner.goto(`${base}/sign-in`);
  await signIn(owner, 'Alex Morgan');
  await owner.waitForURL('**/projects');
  await owner.getByRole('button', { name: 'New project', exact: true }).click();
  await owner
    .getByLabel('Project name', { exact: true })
    .fill('Resource acceptance');
  await owner
    .getByRole('dialog')
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await owner.waitForURL('**/board');
  const projectId = new URL(owner.url()).pathname.split('/')[2];
  const identities = await fixture.query(
    'SELECT id FROM users ORDER BY display_name',
  );
  const editorId = identities.rows[1].id;
  await fixture.query(
    "INSERT INTO project_members(project_id,user_id,role) VALUES ($1,$2,'Editor')",
    [projectId, editorId],
  );
  await editorContext.unroute('**/api/events');
  await editor.goto(
    `${base}/sign-in?returnTo=${encodeURIComponent(`/projects/${projectId}/board`)}`,
  );
  await signIn(editor, 'Jamie Lee');
  await editor.getByText('Connected', { exact: true }).waitFor();
  const started = Date.now();
  await createTask(owner, 'File acceptance');
  await editor
    .getByRole('heading', { name: 'File acceptance', exact: true })
    .waitFor({ timeout: 5000 });
  assert.ok(
    Date.now() - started < 3000,
    'A committed task did not arrive promptly through update hints.',
  );
  await openTask(owner, 'File acceptance');
  await openTask(editor, 'File acceptance');
  const taskId = new URL(editor.url()).pathname.split('/').at(-1);
  const ownerFiles = owner.getByRole('region', {
    name: 'Task attachments',
    exact: true,
  });
  const editorFiles = editor.getByRole('region', {
    name: 'Task attachments',
    exact: true,
  });
  async function upload(page, name, body, mimeType = 'text/plain') {
    const section = page.getByRole('region', {
      name: 'Task attachments',
      exact: true,
    });
    await section
      .getByLabel('Attachment file', { exact: true })
      .setInputFiles({ name, mimeType, buffer: Buffer.from(body) });
    await section
      .getByRole('button', { name: 'Upload attachment', exact: true })
      .click();
    await section
      .locator('.attachment-list strong')
      .getByText(name, { exact: true })
      .waitFor();
  }
  await upload(owner, 'release-notes.txt', 'Release notes kept private.');
  await editorFiles
    .getByRole('button', { name: 'Download release-notes.txt', exact: true })
    .waitFor();
  assert.equal(
    await editorFiles
      .getByRole('button', { name: 'Delete attachment', exact: true })
      .count(),
    0,
  );
  const downloaded = editor.waitForEvent('download');
  await editorFiles
    .getByRole('button', { name: 'Download release-notes.txt', exact: true })
    .click();
  const download = await downloaded;
  assert.equal(download.suggestedFilename(), 'release-notes.txt');
  const stream = await download.createReadStream();
  const bytes = [];
  for await (const chunk of stream) bytes.push(chunk);
  assert.equal(Buffer.concat(bytes).toString(), 'Release notes kept private.');
  await upload(editor, 'editor-notes.txt', 'Editor attachment.');
  await ownerFiles
    .locator('.attachment-list li')
    .filter({ hasText: 'editor-notes.txt' })
    .getByRole('button', { name: 'Delete attachment', exact: true })
    .waitFor();
  await ownerFiles
    .locator('.attachment-list li')
    .filter({ hasText: 'editor-notes.txt' })
    .getByRole('button', { name: 'Delete attachment', exact: true })
    .click();
  await ownerFiles
    .getByRole('button', { name: 'Confirm attachment deletion', exact: true })
    .click();
  await editorFiles
    .getByRole('button', { name: 'Download editor-notes.txt', exact: true })
    .waitFor({ state: 'hidden' });
  await editorFiles
    .getByLabel('Attachment file', { exact: true })
    .setInputFiles({
      name: 'offline-notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Offline file selection.'),
    });
  await editorContext.setOffline(true);
  await eventually(
    () =>
      editorFiles
        .getByRole('button', { name: 'Upload attachment', exact: true })
        .isDisabled(),
    'Offline uploads were not paused.',
  );
  assert.ok(
    (await editorFiles.getByLabel('Attachment file').inputValue()).endsWith(
      'offline-notes.txt',
    ),
  );
  await upload(
    owner,
    'while-offline.txt',
    'A change committed while the other member is offline.',
  );
  const delayedHint = {
    eventId: randomUUID(),
    eventType: 'task.updated',
    projectId,
    entityId: taskId,
    entityVersion: 0,
    boardRevision: 0,
    occurredAt: new Date(0).toISOString(),
  };
  await editorContext.route(
    '**/api/events',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body:
          'event: connected\ndata: {}\n\n' +
          [delayedHint, delayedHint, { ...delayedHint, eventId: randomUUID() }]
            .map((hint) => `event: hint\ndata: ${JSON.stringify(hint)}\n\n`)
            .join(''),
      }),
    { times: 1 },
  );
  await editorContext.setOffline(false);
  await editor.getByText('Connected', { exact: true }).waitFor();
  await editorFiles
    .getByRole('button', { name: 'Download while-offline.txt', exact: true })
    .waitFor();
  await editor
    .getByRole('dialog')
    .getByRole('heading', { name: 'File acceptance', exact: true })
    .waitFor();
  await editorFiles
    .getByRole('button', { name: 'Upload attachment', exact: true })
    .click();
  await editorFiles
    .getByRole('button', { name: 'Download offline-notes.txt', exact: true })
    .waitFor();
  await editorFiles
    .getByLabel('Attachment file', { exact: true })
    .setInputFiles({
      name: 'fake.png',
      mimeType: 'image/png',
      buffer: Buffer.from('not a PNG'),
    });
  await editorFiles
    .getByRole('button', { name: 'Upload attachment', exact: true })
    .click();
  await editorFiles
    .getByText(
      'The actual file does not match its allowed type or size. Choose a valid file and start again.',
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await editorFiles
      .getByRole('button', { name: 'Download fake.png', exact: true })
      .count(),
    0,
  );

  await owner
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await owner.getByRole('link', { name: 'Members', exact: true }).click();
  let held;
  let release;
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  await editorContext.route('**/api/attachments/*/complete', async (route) => {
    held = true;
    await paused;
    await route.continue();
  });
  await editorFiles
    .getByLabel('Attachment file', { exact: true })
    .setInputFiles({
      name: 'permission-check.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Complete after checking membership.'),
    });
  await editorFiles
    .getByRole('button', { name: 'Upload attachment', exact: true })
    .click();
  await eventually(() => !!held, 'Upload completion was not intercepted.');
  await owner.getByRole('button', { name: 'Make Viewer', exact: true }).click();
  await owner.getByRole('button', { name: 'Confirm', exact: true }).click();
  await owner.getByRole('dialog').waitFor({ state: 'hidden' });
  release();
  await editorFiles
    .getByText('Only Owners and Editors can make this change.', { exact: true })
    .waitFor();
  await eventually(
    () =>
      editorFiles
        .getByRole('button', { name: 'Retry upload', exact: true })
        .isDisabled(),
    'Downgraded uploads must remain paused.',
  );
  assert.ok(
    (await editorFiles.getByLabel('Attachment file').inputValue()).endsWith(
      'permission-check.txt',
    ),
  );
  await editorContext.unroute('**/api/attachments/*/complete');
  await owner.getByRole('button', { name: 'Make Editor', exact: true }).click();
  await owner.getByRole('button', { name: 'Confirm', exact: true }).click();
  await owner.getByRole('dialog').waitFor({ state: 'hidden' });
  await eventually(
    async () =>
      !(await editorFiles
        .getByRole('button', { name: 'Retry upload', exact: true })
        .isDisabled()),
    'Editor upload access did not reconcile.',
  );
  await editorFiles
    .getByRole('button', { name: 'Retry upload', exact: true })
    .click();
  await editorFiles
    .getByRole('button', { name: 'Download permission-check.txt', exact: true })
    .waitFor();
  await mobile.goto(
    `${base}/sign-in?returnTo=${encodeURIComponent(`/projects/${projectId}/tasks/${taskId}`)}`,
  );
  await signIn(mobile, 'Jamie Lee');
  await mobile
    .getByRole('button', { name: 'Download permission-check.txt', exact: true })
    .waitFor();
  assert.ok(
    await mobile
      .getByRole('dialog')
      .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
    'Mobile attachments overflow horizontally.',
  );
  await mobile
    .getByRole('region', { name: 'Task attachments', exact: true })
    .scrollIntoViewIfNeeded();
  await mobile.screenshot({
    path: resolve(output, 'mobile-dark-attachments.png'),
  });
  console.info(
    'Browser workflow: live hints, private file validation/download/deletion, offline file selection, permission checks during completion, retry, and mobile attachments passed.',
  );

  await owner
    .getByRole('link', { name: 'Projects', exact: true })
    .last()
    .click();
  await owner
    .getByRole('button', { name: 'Start a seven-day trial', exact: true })
    .click();
  await owner
    .getByRole('button', { name: 'Create trial', exact: true })
    .click();
  await owner.waitForURL('**/board');
  const oldTrial = new URL(owner.url()).pathname.split('/')[2];
  await owner.getByText('10 tasks', { exact: true }).waitFor();
  await createTask(owner, 'Trial-only task');
  await owner.getByRole('link', { name: 'Settings', exact: true }).click();
  await owner.getByRole('button', { name: 'Reset trial', exact: true }).click();
  await owner
    .getByRole('button', { name: 'Confirm reset', exact: true })
    .click();
  await owner.waitForURL('**/board');
  const newTrial = new URL(owner.url()).pathname.split('/')[2];
  assert.notEqual(newTrial, oldTrial);
  await owner.getByText('10 tasks', { exact: true }).waitFor();
  assert.equal(
    await owner
      .getByRole('heading', { name: 'Trial-only task', exact: true })
      .count(),
    0,
  );
  await owner.getByRole('link', { name: 'Settings', exact: true }).click();
  await owner
    .getByRole('heading', { name: 'Trial project', exact: true })
    .waitFor();
  await owner.screenshot({
    path: resolve(output, 'trial-settings.png'),
    fullPage: true,
  });
  await owner
    .getByRole('button', { name: 'Clean up trial', exact: true })
    .click();
  await owner
    .getByRole('button', { name: 'Confirm cleanup', exact: true })
    .click();
  await owner.waitForURL('**/projects');
  await owner
    .getByRole('button', { name: 'Start a seven-day trial', exact: true })
    .waitFor();
  console.info(
    'Browser workflow: isolated seven-day trials, new-ID reset, task isolation, expiry presentation, and early cleanup passed.',
  );

  await fixture.query(
    `INSERT INTO tasks(id,project_id,creator_id,title,status,position) SELECT item.id,$1,$2,item.title,'todo',item.position FROM jsonb_to_recordset($3::jsonb) AS item(id uuid,title text,position int)`,
    [
      projectId,
      identities.rows[0].id,
      JSON.stringify(
        Array.from({ length: 499 }, (_, index) => ({
          id: randomUUID(),
          title: `Capacity task ${index + 1}`,
          position: index + 1,
        })),
      ),
    ],
  );
  await fixture.query(
    'UPDATE projects SET board_revision = board_revision + 1 WHERE id = $1',
    [projectId],
  );
  await editor
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await editor.reload();
  await editor.getByText('500 tasks', { exact: true }).waitFor();
  assert.equal(await editor.locator('.task-card').count(), 500);
  await editor
    .getByRole('searchbox', { name: 'Search tasks', exact: true })
    .fill('Capacity task 499');
  await editor
    .getByRole('heading', { name: 'Capacity task 499', exact: true })
    .waitFor();
  await editor.screenshot({
    path: resolve(output, 'capacity-500-filtered.png'),
    fullPage: true,
  });
  assert.deepEqual(errors, [], 'Resource workflows reported browser errors.');
  console.info(
    'Browser workflow: refresh restores a deep session and a 500-task board remains searchable.',
  );
}

export async function checkIdentity({ browser, base, output, pages, errors }) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  pages.push(['identity', page]);
  page.on('pageerror', (error) => errors.push(error.message));
  const email = `taylor-${randomUUID()}@example.test`;
  const password = 'Local acceptance password 123!';
  const replacement = 'Replacement acceptance password 456!';
  await page.goto(`${base}/sign-up`);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Display name', { exact: true }).fill('Taylor Rivera');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  await page.waitForURL('**/verify-email?*');
  const code = await page.getByTestId('development-code').innerText();
  await page.getByLabel('Verification code', { exact: true }).fill(code);
  await page.getByRole('button', { name: 'Verify email', exact: true }).click();
  await page
    .getByText('Email verified. You can sign in now.', { exact: true })
    .waitFor();
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/auth/sign-in') &&
      response.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: 'Sign in with email', exact: true })
    .click();
  const oldSession = await (await response).json();
  await page.waitForURL('**/projects');
  const onboardingStart = Date.now();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page
    .getByLabel('Project name', { exact: true })
    .fill('My first project');
  await page
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await page.waitForURL('**/board');
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page.getByLabel('Task title', { exact: true }).fill('My first task');
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page
    .getByRole('heading', { name: 'My first task', exact: true })
    .waitFor();
  const onboardingMs = Date.now() - onboardingStart;
  assert.ok(
    onboardingMs <= 120000,
    'A new account must create its first project and task within two minutes.',
  );
  await page.goto(`${base}/projects`);
  const cookie = (await context.cookies()).find(
    (cookie) => cookie.name === 'collabboard.refresh',
  );
  assert.ok(cookie?.httpOnly);
  assert.equal(cookie.sameSite, 'Strict');
  await page.reload();
  await page
    .getByRole('heading', { name: 'Your projects', exact: true })
    .waitFor();
  const local = await page.evaluate(() => ({ ...localStorage }));
  assert.ok(!JSON.stringify(local).includes(oldSession.accessToken));
  await page.goto(`${base}/recover-password`);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page
    .getByRole('button', { name: 'Request recovery code', exact: true })
    .click();
  const recovery = await page.getByTestId('development-code').innerText();
  await page.getByLabel('Verification code', { exact: true }).fill(recovery);
  await page.getByLabel('Password', { exact: true }).fill(replacement);
  await page
    .getByRole('button', { name: 'Reset password', exact: true })
    .click();
  await page
    .getByText(
      'Password reset. Previous sessions are signed out. Sign in with your new password.',
      { exact: true },
    )
    .waitFor();
  assert.equal(
    (
      await context.request.get(`${base}/api/me`, {
        headers: { Authorization: `Bearer ${oldSession.accessToken}` },
      })
    ).status(),
    401,
  );
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page
    .getByRole('button', { name: 'Sign in with email', exact: true })
    .click();
  await page
    .getByText('The email or password is incorrect.', { exact: true })
    .waitFor();
  await page.getByLabel('Password', { exact: true }).fill(replacement);
  await page
    .getByRole('button', { name: 'Sign in with email', exact: true })
    .click();
  await page.waitForURL('**/projects');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Sign out"]:not(.mobile-only)')
        ?.disabled === true,
  );
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForURL('**/sign-in?*');
  await page.reload();
  await page
    .getByRole('heading', { name: 'Welcome to CollabBoard', exact: true })
    .waitFor();
  assert.deepEqual(errors, [], 'Identity workflows reported browser errors.');
  await page.screenshot({
    path: resolve(output, 'identity-sign-in.png'),
    fullPage: true,
  });
  console.info(
    'Browser workflow: local registration, development verification, cookie refresh, reload, password recovery, session revocation, and sign-out passed.',
  );
  return { onboardingMs };
}
