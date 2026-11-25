import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { localIdentities } from '../../apps/api/src/adapters/identity/local-identities.ts';
import { signIn, openTask } from './actions.mjs';
export async function checkLifecycle(
  { owner, editor, mobile, editorContext, base, fixture, output, errors },
  projectId,
) {
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
}
