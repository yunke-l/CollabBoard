import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { localIdentities } from '../../apps/api/src/adapters/identity/local-identities.ts';
import { signIn, createTask, openTask, eventually } from './actions.mjs';
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

export async function checkDiscussion({
  owner,
  editor,
  mobile,
  editorContext,
  base,
  fixture,
  output,
  errors,
}) {
  // The Editor should retain access to their own project after removal from the shared one.
  await fixture.query(
    `WITH personal AS (
      INSERT INTO projects (id, owner_id, name) VALUES (gen_random_uuid(), $1, 'Personal workspace') RETURNING id
    )
    INSERT INTO project_members (project_id, user_id, role) SELECT id, $1, 'Owner' FROM personal`,
    [localIdentities[1].id],
  );
  await owner.goto(base + '/sign-in');
  await signIn(owner, 'Alex Morgan');
  await owner.waitForURL('**/projects');
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
    .getByRole('heading', { name: 'Personal workspace', exact: true })
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
