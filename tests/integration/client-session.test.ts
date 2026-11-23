/// <reference lib="dom" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AuthSession } from '@collabboard/contracts';
import { localIdentities } from '../../apps/api/src/adapters/identity/local-identities';
import {
  api,
  authorizedFetch,
  getAccessToken,
  setClientSession,
} from '../../apps/web/src/shared/api/client';

const alex: AuthSession = {
  user: localIdentities[0]!,
  accessToken: 'alex-original',
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
};
const jamie = { ...alex, user: localIdentities[1]!, accessToken: 'jamie' };
const fetchMock = vi.fn<typeof fetch>();
const write = () =>
  api('/tasks/task-id', {
    method: 'PATCH',
    body: { title: 'Updated', requestId: 'request-1' },
  });
const unauthorized = () =>
  Response.json({ message: 'Unauthorized' }, { status: 401 });

beforeEach(() => {
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('fetch', fetchMock);
  setClientSession(alex);
});
afterEach(() => {
  setClientSession(null);
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

it('retries the original write once when the same account renews its token', async () => {
  fetchMock
    .mockResolvedValueOnce(unauthorized())
    .mockResolvedValueOnce(
      Response.json({ ...alex, accessToken: 'alex-renewed' }),
    )
    .mockResolvedValueOnce(Response.json({ saved: true }));
  await expect(write()).resolves.toEqual({ saved: true });
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    '/api/tasks/task-id',
    '/api/auth/session',
    '/api/tasks/task-id',
  ]);
  const first = fetchMock.mock.calls[0]![1]!;
  const retry = fetchMock.mock.calls[2]![1]!;
  expect(retry.body).toBe(first.body);
  expect(retry.method).toBe('PATCH');
  expect(new Headers(retry.headers).get('Authorization')).toBe(
    'Bearer alex-renewed',
  );
});

it('ends the old session when the refresh cookie belongs to a different account', async () => {
  fetchMock
    .mockResolvedValueOnce(unauthorized())
    .mockResolvedValueOnce(Response.json(jamie));
  const expired = vi.fn();
  window.addEventListener('collabboard:session-expired', expired);
  await expect(write()).rejects.toMatchObject({ status: 401 });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(expired).toHaveBeenCalledTimes(1);
  expect(getAccessToken()).toBeNull();
});

it('keeps the new account when an earlier upload receives a late 401', async () => {
  let respond!: (response: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        respond = resolve;
      }),
  );
  const upload = authorizedFetch('/api/attachments/file/content', {
    method: 'PUT',
    body: 'file',
  });
  setClientSession(jamie);
  respond(unauthorized());
  expect((await upload).status).toBe(401);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(getAccessToken()).toBe(jamie.accessToken);
});
