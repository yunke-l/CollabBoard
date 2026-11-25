import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { project, task } from '../../test/board-fixture';
import { renderPage } from '../../test/render-page';
import { AttachmentSection } from './attachment-section';

vi.mock('../../app/providers/session', () => ({
  useSession: () => ({ user: { id: 'editor' } }),
}));

it('retries confirmation with the same request ID and keeps the uploaded file until success', async () => {
  const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
  const requests: string[] = [];
  const completionIds: string[] = [];
  vi.stubGlobal('fetch', async (path: string, options: RequestInit) => {
    if (path === '/api/tasks/copy/attachments' && options.method === 'GET')
      return Response.json({ items: [], nextCursor: null });
    requests.push(options.method + ' ' + path);
    if (path === '/api/tasks/copy/attachments' && options.method === 'POST')
      return Response.json({
        attachment: { id: 'file' },
        upload: {
          path: '/api/upload',
          token: 'upload',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      });
    if (path === '/api/upload' && options.method === 'PUT') {
      expect(options.body).toBe(file);
      return new Response(null, { status: 204 });
    }
    if (
      path === '/api/attachments/file/complete' &&
      options.method === 'POST'
    ) {
      completionIds.push(JSON.parse(String(options.body)).requestId);
      if (completionIds.length === 1)
        throw new Error('Confirmation interrupted');
      return Response.json({});
    }
    throw new Error('Unexpected request ' + path);
  });
  const user = userEvent.setup();
  renderPage(
    <AttachmentSection
      project={project}
      task={task}
      disabled={false}
      onPending={() => {}}
    />,
  );
  const picker = screen.getByLabelText<HTMLInputElement>('Attachment file');
  await user.upload(picker, file);
  await user.click(screen.getByRole('button', { name: 'Upload attachment' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Confirmation interrupted',
  );
  expect(picker.files?.[0]).toBe(file);
  await user.click(await screen.findByRole('button', { name: 'Retry upload' }));
  await waitFor(() => expect(picker.files).toHaveLength(0));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(requests).toEqual([
    'POST /api/tasks/copy/attachments',
    'PUT /api/upload',
    'POST /api/attachments/file/complete',
    'POST /api/attachments/file/complete',
  ]);
  expect(completionIds[0]).toEqual(expect.any(String));
  expect(completionIds[1]).toBe(completionIds[0]);
});
