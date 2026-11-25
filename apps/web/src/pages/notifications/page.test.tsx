import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { renderPage } from '../../test/render-page';
import { NotificationsPage } from './page';

vi.mock('../../app/providers/session', () => ({
  useSession: () => ({ user: { id: 'editor' } }),
}));

it('keeps the first page visible and retries the failed cursor when loading more notifications', async () => {
  const listRequests: string[] = [];
  const item = (id: string) => ({
    id,
    createdAt: '2026-01-01T00:00:00Z',
    readAt: null,
    target: {
      actorName: 'Alex',
      taskId: id,
      projectId: 'launch',
      projectName: 'Launch',
      taskTitle: id,
    },
  });
  vi.stubGlobal('fetch', async (path: string) => {
    if (path === '/api/notifications/unread-count')
      return Response.json({ unreadCount: 2 });
    listRequests.push(path);
    if (path === '/api/notifications')
      return Response.json({ items: [item('First task')], nextCursor: 'next' });
    if (path === '/api/notifications?cursor=next') {
      if (listRequests.length === 2)
        return Response.json(
          {
            message: 'Page unavailable',
            code: 'UNAVAILABLE',
            requestId: 'page',
          },
          { status: 503 },
        );
      return Response.json({ items: [item('Next task')], nextCursor: null });
    }
    throw new Error('Unexpected request ' + path);
  });
  const user = userEvent.setup();
  renderPage(<NotificationsPage />);
  await user.click(
    await screen.findByRole('button', { name: 'Load more notifications' }),
  );
  expect(await screen.findByText('Page unavailable')).toBeVisible();
  expect(screen.getByRole('link', { name: 'First task' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('link', { name: 'Next task' })).toBeVisible();
  expect(screen.getAllByRole('article')).toHaveLength(2);
  expect(
    screen.queryByRole('button', { name: 'Load more notifications' }),
  ).not.toBeInTheDocument();
  expect(listRequests).toEqual([
    '/api/notifications',
    '/api/notifications?cursor=next',
    '/api/notifications?cursor=next',
  ]);
});
