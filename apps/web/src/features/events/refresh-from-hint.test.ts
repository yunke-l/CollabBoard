import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { refreshFromHint } from './refresh-from-hint';

it('fetches a new snapshot when a hint arrives during the first read', async () => {
  const client = new QueryClient();
  let finishFirstRead!: (rows: string[]) => void;
  const firstRead = new Promise<string[]>((resolve) => {
    finishFirstRead = resolve;
  });
  const queryKey = ['board', 'project-1'];
  let reads = 0;
  const observer = new QueryObserver(client, {
    queryKey,
    queryFn: () => (++reads === 1 ? firstRead : ['new task']),
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    const refreshed = refreshFromHint(client, 'project-1');
    finishFirstRead([]);
    await refreshed;
    expect(reads).toBe(2);
    expect(client.getQueryData(queryKey)).toEqual(['new task']);
  } finally {
    unsubscribe();
    client.clear();
  }
});
