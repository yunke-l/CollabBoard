import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
export async function checkIdentity({ owner: page, base, output, errors }) {
  const context = page.context();
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
    .getByRole('dialog')
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
  const firstProject = page.getByRole('heading', {
    name: 'My first project',
    exact: true,
  });
  await page
    .getByRole('navigation', { name: 'Application navigation' })
    .getByRole('link', { name: 'Projects', exact: true })
    .click();
  await firstProject.waitFor();
  const cookie = (await context.cookies()).find(
    (cookie) => cookie.name === 'collabboard.refresh',
  );
  assert.ok(cookie?.httpOnly);
  assert.equal(cookie.sameSite, 'Strict');
  await page.reload();
  await firstProject.waitFor();
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
  await page.getByText('Connected', { exact: true }).waitFor();
  await firstProject.waitFor();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Sign out"]:not(.mobile-only)')
        ?.disabled === true,
  );
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Sign out?' });
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  const switchAccount = page.getByRole('button', {
    name: 'Switch account',
    exact: true,
  });
  const switchDialog = page.getByRole('dialog', { name: 'Switch account?' });
  const confirmSwitch = switchDialog.getByRole('button', {
    name: 'Switch account',
    exact: true,
  });
  await switchAccount.click();
  await switchDialog.getByRole('button', { name: 'Cancel' }).click();
  await switchDialog.waitFor({ state: 'hidden' });
  assert.equal(new URL(page.url()).pathname, '/projects');
  await switchAccount.click();
  await confirmSwitch.click();
  await page
    .getByText(`Currently signed in as ${email}.`, { exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForURL('**/projects');
  const beforeSwitch = await (
    await context.request.get(`${base}/api/auth/session`)
  ).json();
  assert.equal(beforeSwitch.user.email, email);
  await page.setViewportSize({ width: 390, height: 844 });
  await switchAccount.click();
  await confirmSwitch.click();
  await page.getByRole('button', { name: /Jamie Lee/ }).click();
  await page.waitForURL('**/projects');
  const afterSwitch = await (
    await context.request.get(`${base}/api/auth/session`)
  ).json();
  assert.equal(afterSwitch.user.email, 'jamie@example.com');
  assert.equal(
    (
      await context.request.get(`${base}/api/me`, {
        headers: { Authorization: `Bearer ${beforeSwitch.accessToken}` },
      })
    ).status(),
    401,
  );
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await confirmation
    .getByRole('button', { name: 'Sign out', exact: true })
    .click();
  await page.waitForURL('**/sign-in?*');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
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
