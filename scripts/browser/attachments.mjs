import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { createTask, openTask, signIn, eventually } from './actions.mjs';

export async function checkAttachments({
  owner,
  editor,
  mobile,
  editorContext,
  fixture,
  base,
  output,
  errors,
}) {
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
  await owner.getByRole('button', { name: 'New project', exact: true }).click();
  await owner.getByLabel('Project name').fill('Your sample project');
  await owner.getByLabel('Start with sample tasks').check();
  await owner
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await owner.waitForURL('**/board');
  await owner.getByText('10 of 10 tasks', { exact: true }).waitFor();
  const navigation = owner.getByRole('navigation', {
    name: 'Project navigation',
  });
  assert.equal(
    await navigation.getByText('10 tasks', { exact: true }).count(),
    0,
  );
  const todo = owner.getByRole('region', { name: 'To Do', exact: true });
  const cards = todo.locator('.task-card');
  const originalOrder = await cards.locator('h3').allTextContents();
  const first = await cards.nth(0).boundingBox();
  const second = await cards.nth(1).boundingBox();
  const transfer = await owner.evaluateHandle(() => new DataTransfer());
  await cards.nth(3).dispatchEvent('dragstart', { dataTransfer: transfer });
  await cards.nth(0).dispatchEvent('dragover', {
    dataTransfer: transfer,
    clientY: first.y + first.height - 2,
  });
  const slot = todo.locator('[data-drop-before]');
  await slot.waitFor();
  const shifted = await slot.locator('.task-card').boundingBox();
  assert.ok(
    shifted.y >= second.y + 24,
    'The preview must open space between cards.',
  );
  await slot.dispatchEvent('drop', {
    dataTransfer: transfer,
    clientY: shifted.y - 10,
  });
  await transfer.dispose();
  await eventually(
    async () =>
      (await cards.locator('h3').allTextContents())[1] === originalOrder[3],
    'Dropping inside the preview must insert at that slot.',
  );
  await owner
    .getByRole('searchbox', { name: 'Search tasks' })
    .fill('onboarding');
  await owner.waitForURL((url) => url.searchParams.get('q') === 'onboarding');
  const originalLocation = owner.url();
  await owner.getByRole('link', { name: 'Sample board', exact: true }).click();
  await owner
    .getByRole('navigation', { name: 'Application navigation' })
    .waitFor();
  await owner.getByText('Interactive sample', { exact: true }).waitFor();
  const sampleCard = owner.getByRole('link', {
    name: /Map the onboarding journey/,
  });
  assert.equal(
    await owner.getByRole('button', { name: /add task|new task/i }).count(),
    0,
  );
  await sampleCard.click();
  await owner.getByLabel('Sample task status').selectOption('done');
  await owner.getByRole('button', { name: 'Close dialog' }).click();
  await owner
    .locator('.board-column[data-status="done"]')
    .getByRole('link', { name: /Map the onboarding journey/ })
    .waitFor();
  await owner.reload();
  await owner
    .locator('.board-column[data-status="todo"]')
    .getByRole('link', { name: /Map the onboarding journey/ })
    .waitFor();
  await owner.getByRole('link', { name: '← Back to workspace' }).click();
  await owner.waitForURL(originalLocation);
  await owner
    .getByRole('heading', { name: 'Your sample project', exact: true })
    .waitFor();
  assert.equal(
    await owner.getByRole('searchbox', { name: 'Search tasks' }).inputValue(),
    'onboarding',
  );
  await navigation.getByRole('link', { name: 'Archived tasks' }).click();
  await owner
    .getByRole('link', { name: 'Publish the kickoff notes' })
    .waitFor();
  assert.equal(await owner.locator('.archived-task-row').count(), 3);
  await navigation.getByRole('link', { name: 'Members' }).click();
  await navigation
    .getByRole('link', { name: 'Members', current: 'page' })
    .waitFor();
  await owner
    .getByText('riley.chen@example.invalid', { exact: true })
    .waitFor();
  await owner
    .getByRole('heading', { name: 'Your sample project', exact: true })
    .waitFor();
  await createTask(owner, 'Private project task');
  await owner.getByRole('link', { name: 'Settings', exact: true }).click();
  const newOwner = owner.getByLabel('New Owner', { exact: true });
  await eventually(
    async () =>
      (await newOwner.locator('option:checked').textContent()) ===
      'No eligible members',
    'A solo Owner should see an empty member selector.',
  );
  assert.ok(await newOwner.isDisabled());
  await owner.getByRole('link', { name: 'Board', exact: true }).click();
  await owner
    .getByRole('heading', { name: 'Private project task', exact: true })
    .waitFor();
  console.info(
    'Browser workflow: permanent sample-based projects and interactive public sample passed.',
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
  await editor.reload();
  await editor
    .getByRole('dialog')
    .getByRole('heading', { name: 'File acceptance', exact: true })
    .waitFor();
  await editor
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await editor.waitForURL('**/board');
  await editor.getByRole('dialog').waitFor({ state: 'hidden' });
  await editor.getByText('500 of 500 tasks', { exact: true }).waitFor();
  assert.equal(await editor.locator('.task-card').count(), 500);
  await editor
    .getByRole('searchbox', { name: 'Search tasks', exact: true })
    .fill('Capacity task 499');
  await editor
    .getByRole('heading', { name: 'Capacity task 499', exact: true })
    .waitFor();
  await editor.getByText('1 of 500 tasks', { exact: true }).waitFor();
  assert.deepEqual(await editor.locator('.task-card h3').allTextContents(), [
    'Capacity task 499',
  ]);
  await editor.screenshot({
    path: resolve(output, 'capacity-500-filtered.png'),
    fullPage: true,
  });
  await editor
    .getByRole('button', { name: 'Clear filters', exact: true })
    .click();
  await editor.getByText('500 of 500 tasks', { exact: true }).waitFor();
  assert.equal(await editor.locator('.task-card').count(), 500);
  assert.deepEqual(errors, [], 'Resource workflows reported browser errors.');
  console.info(
    'Browser workflow: refresh restores a deep session and a 500-task board remains searchable.',
  );
}
