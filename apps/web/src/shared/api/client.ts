import {
  quotaLabels,
  quotaSchema,
  type ApiErrorBody,
  type AuthSession,
} from '@collabboard/contracts';

let activeSession: AuthSession | null = null;
let sessionEpoch = 0;
let refreshing: Promise<AuthSession | null> | undefined;

// Explicit sign-in and sign-out end the lifetime of all earlier requests.
export function setClientSession(session: AuthSession | null) {
  activeSession = session;
  sessionEpoch++;
  refreshing = undefined;
}
export function getAccessToken() {
  return activeSession?.accessToken ?? null;
}
function expireSession() {
  setClientSession(null);
  window.dispatchEvent(new Event('collabboard:session-expired'));
}
export async function authorizedFetch(path: string, options: RequestInit = {}) {
  const send = (token: string | null) => {
    const headers = new Headers(options.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(path, { ...options, headers });
  };
  const started = sessionEpoch;
  const token = getAccessToken();
  const response = await send(token);
  if (
    response.status !== 401 ||
    !token ||
    path.startsWith('/api/auth/') ||
    options.signal?.aborted ||
    started !== sessionEpoch
  )
    return response;

  if (token === getAccessToken()) await refreshAccess();
  if (started !== sessionEpoch || options.signal?.aborted) return response;
  const renewed = getAccessToken();
  if (renewed === token || !renewed) {
    expireSession();
    return response;
  }
  const retry = await send(renewed);
  if (
    retry.status === 401 &&
    started === sessionEpoch &&
    renewed === getAccessToken()
  )
    expireSession();
  return retry;
}
export function refreshAccess(): Promise<AuthSession | null> {
  if (refreshing) return refreshing;
  const started = sessionEpoch;
  refreshing = (async () => {
    try {
      const response = await fetch('/api/auth/session', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) return null;
      const session = (await response.json()) as AuthSession;
      if (started !== sessionEpoch) return null;
      if (activeSession && session.user.id !== activeSession.user.id) {
        expireSession();
        return null;
      }
      activeSession = session;
      window.dispatchEvent(
        new CustomEvent('collabboard:session-refreshed', { detail: session }),
      );
      return session;
    } catch {
      return null;
    } finally {
      if (started === sessionEpoch) refreshing = undefined;
    }
  })();
  return refreshing;
}
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: ApiErrorBody,
  ) {
    const quota = quotaSchema.safeParse(detail.quota);
    super(
      (Object.values(detail.fieldErrors ?? {}).flat()[0] ?? detail.message) +
        (quota.success
          ? ` ${quota.data.used} of ${quota.data.limit} ${quotaLabels[quota.data.resource]} used.`
          : ''),
    );
  }
}
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await authorizedFetch(`/api${path}`, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    ...(options.body !== undefined
      ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(options.body),
        }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    let detail: ApiErrorBody;
    try {
      detail = (await response.json()) as ApiErrorBody;
    } catch {
      detail = {
        code: 'UNAVAILABLE',
        message: 'Unable to reach the service. Please try again.',
        requestId: '',
      };
    }
    throw new ApiError(response.status, detail);
  }
  return response.json() as Promise<T>;
}
