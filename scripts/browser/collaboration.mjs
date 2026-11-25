import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { localIdentities } from '../../apps/api/src/adapters/identity/local-identities.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { signIn, createTask, eventually, savedMove } from './actions.mjs';
import { checkMoveRecovery } from './movement.mjs';
import { checkLifecycle } from './lifecycle.mjs';
export async function checkCollaboration(context) {
  const {
    owner,
    editor,
    mobile,
    ownerContext,
    editorContext,
    base,
    fixture,
    output,
    errors,
    engine,
  } = context;
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

  await checkMoveRecovery(owner, editor, engine);
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
  await checkLifecycle(context, projectId);
}
