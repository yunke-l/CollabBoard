import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
export async function eventually(check, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await setTimeout(100);
  }
  assert.fail(message);
}
export async function signIn(page, name) {
  await page.getByRole('button', { name: new RegExp(name) }).click();
}
export async function createTask(page, title, assignee = '') {
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
export async function savedMove(page, action) {
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
export async function openTask(page, title) {
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
