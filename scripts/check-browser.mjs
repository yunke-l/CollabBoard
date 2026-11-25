import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import { createLocalFixture } from './lib/local-fixture.mjs';
import { checkCollaboration } from './browser/collaboration.mjs';
import { checkDiscussion } from './browser/discussion.mjs';
import { checkNotifications } from './browser/notifications.mjs';
import { checkAttachments } from './browser/attachments.mjs';
import { checkIdentity } from './browser/identity.mjs';

const scenarios = new Map([
  ['collaboration', checkCollaboration],
  ['notifications', checkNotifications],
  ['discussion', checkDiscussion],
  ['attachments', checkAttachments],
  ['identity', checkIdentity],
]);
const requested = process.argv.slice(2);
for (const name of requested)
  assert.ok(
    scenarios.has(name),
    'Unknown browser scenario. Choose ' + [...scenarios.keys()].join(', '),
  );
const selected = requested.length
  ? new Set(requested)
  : new Set(scenarios.keys());
const engine = process.env.BROWSER_ENGINE ?? 'chromium';
assert.ok(
  ['chromium', 'firefox', 'webkit'].includes(engine),
  'Unknown browser engine.',
);
const output = resolve('.local/browser-check', engine);
const desktopViewport = { width: 1440, height: 1000 };
const mobileViewport = { width: 390, height: 844 };
await mkdir(output, { recursive: true });
const diagnostics = { engine, stage: 'browser launch', scenarios: [] };
const saveDiagnostics = () =>
  writeFile(
    resolve(output, 'diagnostics.json'),
    JSON.stringify(diagnostics, null, 2) + '\n',
  );

// Persist only the error type and repository source location. Playwright error
// messages can include request URLs or rendered form values.
function failureDetails(error) {
  const source = error.stack?.match(
    /^\s+at [^\n]*?(scripts\/[\w./-]+\.mjs:\d+:\d+)\)?$/m,
  )?.[1];
  return { type: error.name, source };
}

async function runScenario(browser, result) {
  const { name } = result;
  const contexts = [];
  const pages = [];
  let local;
  const errors = [];
  async function newPage(options) {
    const context = await browser.newContext(options);
    contexts.push(context);
    if (name !== 'identity' && name !== 'attachments')
      await context.route('**/api/events', (route) =>
        route.fulfill({ status: 503, body: '' }),
      );
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    // WebKit also emits inspector page errors for handled network failures.
    // Observe JS exceptions and unhandled rejections in each document directly.
    await page.exposeFunction('reportBrowserError', (message) =>
      errors.push(message),
    );
    await page.addInitScript(() => {
      window.addEventListener('error', (event) => {
        if (event instanceof ErrorEvent)
          void window.reportBrowserError(event.message);
      });
      window.addEventListener('unhandledrejection', (event) => {
        void window.reportBrowserError(String(event.reason));
      });
    });
    if (name === 'attachments') {
      const role = ['owner', 'editor', 'mobile'][pages.length];
      page.on('response', async (response) => {
        const path = new URL(response.url()).pathname;
        if (!path.startsWith('/api/')) return;
        if (path.endsWith('/events'))
          console.info('Stream response', role, response.status());
        if (path.endsWith('/board') || path.endsWith('/attachments')) {
          const body = await response.json().catch(() => null);
          console.info(
            'Snapshot',
            role,
            path.endsWith('/board') ? 'board' : 'files',
            response.status(),
            body?.tasks?.length ?? body?.items?.length ?? 'no body',
          );
        }
      });
      page.on('console', (message) => {
        if (
          /^fixture hint (task|attachment|project|other)$/.test(message.text())
        )
          console.info(role, message.text());
      });
      await page.addInitScript(() => {
        const decode = TextDecoder.prototype.decode;
        TextDecoder.prototype.decode = function (...args) {
          const text = decode.apply(this, args);
          if (text.includes('event: hint'))
            console.info(
              'fixture hint ' +
                (text.match(/"eventType":"(task|attachment|project)\./)?.[1] ??
                  'other'),
            );
          return text;
        };
      });
    }
    pages.push(page);
    return page;
  }
  try {
    await saveDiagnostics();
    local = await createLocalFixture({ rateLimits: false });
    result.stage = 'browser context';
    const owner = await newPage({ viewport: desktopViewport });
    const context = {
      owner,
      base: local.base,
      fixture: local.db,
      errors,
      engine,
      output,
    };
    if (name !== 'identity') {
      context.editor = await newPage({ viewport: desktopViewport });
      context.mobile = await newPage({
        viewport: mobileViewport,
        colorScheme: name === 'collaboration' ? 'light' : 'dark',
        hasTouch: true,
        ...(engine === 'firefox' ? {} : { isMobile: true }),
      });
      context.ownerContext = owner.context();
      context.editorContext = context.editor.context();
    }
    result.stage = 'workflow';
    await saveDiagnostics();
    console.info('Running browser scenario:', engine, name);
    const measurements = await scenarios.get(name)(context);
    assert.deepEqual(errors, [], 'Browser runtime errors were reported.');
    result.stage = 'cleanup';
    return measurements;
  } catch (error) {
    if (result.stage === 'workflow' && name !== 'identity') {
      for (const [index, page] of pages.entries()) {
        await page
          .screenshot({
            path: resolve(output, `failure-${name}-${index}.png`),
            timeout: 3000,
            mask: [
              page.locator('input, textarea, [data-testid="development-code"]'),
            ],
          })
          .catch(() => {});
      }
    }
    throw error;
  } finally {
    try {
      await Promise.all(contexts.map((context) => context.close()));
    } finally {
      await local?.close();
    }
  }
}

let browser;
try {
  await saveDiagnostics();
  browser = await { chromium, firefox, webkit }[engine].launch({
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE
      ? { executablePath: process.env.BROWSER_EXECUTABLE }
      : {}),
  });
  diagnostics.stage = 'scenarios';
  const failures = [];
  let measurements;
  for (const name of selected) {
    const result = { name, stage: 'fixture setup', passed: false };
    diagnostics.scenarios.push(result);
    try {
      const metrics = await runScenario(browser, result);
      if (name === 'identity') measurements = metrics;
      result.stage = 'complete';
      result.passed = true;
    } catch (error) {
      result.error = failureDetails(error);
      console.error(
        'Failed browser scenario:',
        engine,
        name,
        process.env.CI ? result.error : error,
      );
      failures.push(name);
    }
    await saveDiagnostics();
  }
  assert.equal(
    failures.length,
    0,
    'Failed browser scenarios: ' + failures.join(', '),
  );
  if (selected.size === scenarios.size) {
    await mkdir('engineering/validation', { recursive: true });
    await writeFile(
      resolve('engineering/validation', `local-browser-${engine}.json`),
      JSON.stringify(
        {
          date: new Date().toISOString(),
          engine,
          version: browser.version(),
          scope:
            'Local PostgreSQL and local identity/file/SSE adapters; no AWS',
          desktopViewport,
          mobileViewport,
          passed: true,
          measurements,
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
  }
  diagnostics.stage = 'complete';
  console.info('Browser checks passed:', engine, [...selected].join(', '));
} catch (error) {
  diagnostics.error = failureDetails(error);
  throw error;
} finally {
  try {
    await saveDiagnostics();
  } finally {
    await browser?.close();
  }
}
