import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, Route, Routes } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { renderPage } from '../../test/render-page';
import { InvitationPage } from './page';

vi.mock('../../app/providers/session', () => ({
  useSession: () => ({ user: null }),
}));
const storageKey = 'collabboard.pending-invitation';
afterEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

it('clears an expired invitation on return without requesting a preview', async () => {
  sessionStorage.setItem(
    storageKey,
    JSON.stringify({ token: 'a'.repeat(64), expiresAt: Date.now() - 1 }),
  );
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  renderPage(<InvitationPage />, '/invite');
  expect(
    await screen.findByRole('heading', { name: 'Invitation link needed' }),
  ).toBeVisible();
  expect(sessionStorage.getItem(storageKey)).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it('forgets the invitation after cancellation, including when the route is reopened', async () => {
  const token = 'b'.repeat(64);
  window.history.replaceState(null, '', '/invite#token=' + token);
  const fetch = vi.fn(async () =>
    Response.json({
      projectName: 'Launch',
      projectStatus: 'active',
      status: 'pending',
      role: 'Editor',
      expiresAt: '2030-01-01T00:00:00Z',
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const user = userEvent.setup();
  renderPage(
    <Routes>
      <Route path="/invite" element={<InvitationPage />} />
      <Route path="/" element={<Link to="/invite">Reopen invitation</Link>} />
    </Routes>,
    '/invite#token=' + token,
  );
  expect(
    await screen.findByRole('heading', { name: 'Join Launch' }),
  ).toBeVisible();
  expect(window.location.hash).toBe('');
  expect(sessionStorage.getItem(storageKey)).toContain(token);
  await user.click(screen.getByRole('link', { name: 'Cancel' }));
  await user.click(screen.getByRole('link', { name: 'Reopen invitation' }));
  expect(
    await screen.findByRole('heading', { name: 'Invitation link needed' }),
  ).toBeVisible();
  expect(sessionStorage.getItem(storageKey)).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('previews the new credential when a second invitation opens on the same route', async () => {
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  const tokens: string[] = [];
  vi.stubGlobal('fetch', async (_path: string, options: RequestInit) => {
    const { token } = JSON.parse(String(options.body));
    tokens.push(token);
    return Response.json({
      projectName: token === first ? 'Launch' : 'Release',
      projectStatus: 'active',
      status: 'pending',
      role: 'Editor',
      expiresAt: '2030-01-01T00:00:00Z',
    });
  });
  const user = userEvent.setup();
  renderPage(
    <Routes>
      <Route
        path="/invite"
        element={
          <>
            <Link to={'/invite#token=' + second}>Second invitation</Link>
            <InvitationPage />
          </>
        }
      />
      <Route path="/" element={null} />
    </Routes>,
    '/invite#token=' + first,
  );
  expect(
    await screen.findByRole('heading', { name: 'Join Launch' }),
  ).toBeVisible();
  await user.click(screen.getByRole('link', { name: 'Second invitation' }));
  expect(
    await screen.findByRole('heading', { name: 'Join Release' }),
  ).toBeVisible();
  expect(tokens).toEqual([first, second]);
  expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toMatchObject({
    token: second,
  });
  await user.click(screen.getByRole('link', { name: 'Cancel' }));
});
