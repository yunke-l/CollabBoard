import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { localIdentities } from '../../apps/api/src/adapters/identity/local-identities.ts';
import { randomUUID } from 'node:crypto';
import { signIn, createTask, eventually } from './actions.mjs';
export async function checkNotifications({
  owner,
  mobile,
  base,
  fixture,
  output,
  errors,
}) {
  await owner.goto(base + '/sign-in');
  await signIn(owner, 'Alex Morgan');
  await owner.getByRole('button', { name: 'New project', exact: true }).click();
  await owner.getByLabel('Project name').fill('Notifications acceptance');
  await owner
    .getByRole('dialog')
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await owner.waitForURL('**/board');
  const projectId = new URL(owner.url()).pathname.split('/')[2];
  await fixture.query(
    "INSERT INTO project_members(project_id,user_id,role) VALUES ($1,$2,'Editor')",
    [projectId, localIdentities[1].id],
  );
  await owner.reload();
  await createTask(owner, 'Owner draft', localIdentities[1].id);
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
}
