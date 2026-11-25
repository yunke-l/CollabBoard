import { renderPage } from '../../test/render-page';
import { project, task } from '../../test/board-fixture';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { expect, it, vi } from 'vitest';
import { ProjectLayout } from '../../app/layouts/project-layout';
import { BoardPage } from './page';

vi.mock('../../app/providers/session', () => ({
  useSession: () => ({ user: { id: 'editor' } }),
}));

function renderBoard() {
  renderPage(
    <Routes>
      <Route path="/projects/:projectId" element={<ProjectLayout />}>
        <Route path="board" element={<BoardPage />} />
        <Route path="tasks/:taskId" element={<BoardPage />} />
      </Route>
    </Routes>,
    '/projects/launch/board',
  );
}

function mockBoardRequests(handleTask?: (options: RequestInit) => Response) {
  const responses = new Map<string, unknown>([
    ['/api/projects/launch', project],
    ['/api/projects/launch/board', { project, tasks: [task] }],
    ['/api/projects/launch/members', { project, members: [] }],
    ...[
      '/api/tasks/copy/comments',
      '/api/tasks/copy/attachments',
      '/api/projects/launch/activity?taskId=copy',
    ].map((path): [string, unknown] => [path, { items: [], nextCursor: null }]),
  ]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options: RequestInit) => {
      if (path === '/api/tasks/copy' && handleTask) return handleTask(options);
      if (options.method === 'GET' && responses.has(path))
        return Response.json(responses.get(path));
      throw new Error(`Unexpected request: ${options.method} ${path}`);
    }),
  );
}

it('keeps the new task draft while offline and enables submission on reconnect', async () => {
  mockBoardRequests();
  const user = userEvent.setup();
  renderBoard();
  await user.click(await screen.findByRole('button', { name: 'New task' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Create a task' }));
  const title = dialog.getByRole('textbox', { name: 'Task title' });
  const submit = dialog.getByRole('button', { name: 'Create task' });
  await user.type(title, 'Publish release notes');
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  act(() => {
    window.dispatchEvent(new Event('offline'));
  });
  expect(dialog.getByRole('status')).toHaveTextContent(/offline/i);
  expect(title).toHaveValue('Publish release notes');
  expect(submit).toBeDisabled();
  online.mockReturnValue(true);
  act(() => {
    window.dispatchEvent(new Event('online'));
  });
  expect(title).toHaveValue('Publish release notes');
  expect(submit).toBeEnabled();
});

it('restores task cards and counts after clearing an unmatched filter', async () => {
  mockBoardRequests();
  const user = userEvent.setup();
  renderBoard();
  const card = { name: /Review launch copy/ };
  expect(await screen.findByRole('link', card)).toBeVisible();
  const priority = screen.getByRole('combobox', { name: 'Filter by priority' });
  await user.selectOptions(priority, 'low');
  expect(
    screen.getByRole('heading', { name: 'No matching tasks' }),
  ).toBeVisible();
  expect(screen.getByText('0 of 1 tasks')).toBeVisible();
  expect(screen.queryByRole('link', card)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(priority).toHaveValue('');
  expect(screen.getByText('1 of 1 tasks')).toBeVisible();
  expect(screen.getByRole('link', card)).toBeVisible();
});

it('preserves a conflicting edit and saves it against the reviewed version', async () => {
  let saved = task;
  const updates: { title: string; expectedVersion: number }[] = [];
  mockBoardRequests((options) => {
    if (options.method === 'GET') return Response.json(saved);
    if (options.method !== 'PATCH') throw new Error('Expected a task update');
    const update = JSON.parse(String(options.body));
    updates.push({
      title: update.title,
      expectedVersion: update.expectedVersion,
    });
    if (updates.length === 1) {
      saved = { ...task, title: 'Another editor’s title', version: 2 };
      return Response.json(
        {
          code: 'VERSION_CONFLICT',
          message: 'Task changed',
          requestId: 'conflict',
        },
        { status: 409 },
      );
    }
    saved = { ...saved, title: update.title, version: 3 };
    return Response.json({ task: saved, boardRevision: 3 });
  });
  const user = userEvent.setup();
  renderBoard();
  await user.click(
    await screen.findByRole('link', { name: /Review launch copy/ }),
  );
  const dialog = within(
    await screen.findByRole('dialog', { name: 'Task details' }),
  );
  await user.click(await dialog.findByRole('button', { name: 'Edit task' }));
  const title = dialog.getByRole('textbox', { name: 'Task title' });
  const save = dialog.getByRole('button', { name: 'Save changes' });
  await user.clear(title);
  await user.type(title, 'My revised title');
  await user.click(save);
  expect(await dialog.findByText('Another editor’s title')).toBeVisible();
  expect(title).toHaveValue('My revised title');
  expect(save).toBeDisabled();
  await user.click(
    dialog.getByRole('button', { name: 'Continue editing against version 2' }),
  );
  await user.click(save);
  expect(
    await dialog.findByRole('heading', { name: 'My revised title' }),
  ).toBeVisible();
  expect(updates).toEqual([
    { title: 'My revised title', expectedVersion: 1 },
    { title: 'My revised title', expectedVersion: 2 },
  ]);
});
