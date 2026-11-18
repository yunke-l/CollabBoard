import type { ApiErrorBody } from '@collabboard/contracts';

let accessToken: string | null = null;
export function setAccessToken(token: string | null) {
  accessToken = token;
}
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: ApiErrorBody,
  ) {
    super(Object.values(detail.fieldErrors ?? {}).flat()[0] ?? detail.message);
  }
}
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body !== undefined
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
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
