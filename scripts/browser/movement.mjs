import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { savedMove } from './actions.mjs';
export async function checkMoveRecovery(owner, editor, engine) {
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
