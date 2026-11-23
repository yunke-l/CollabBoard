import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { EventHint } from '@collabboard/contracts';
import { useSession } from '../../app/providers/session';
import { authorizedFetch } from '../../shared/api/client';
import { useOnline } from '../../shared/lib/use-online';

export function ConnectionStatus() {
  const { user } = useSession();
  const client = useQueryClient();
  const online = useOnline();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!user || !online) {
      setConnected(false);
      return;
    }
    const controller = new AbortController();
    const seen = new Set<string>();
    const reconcile = () => {
      void client.invalidateQueries();
    };
    async function connect() {
      let attempt = 0;
      while (!controller.signal.aborted) {
        try {
          const response = await authorizedFetch('/api/events', {
            signal: controller.signal,
          });
          if (!response.ok || !response.body)
            throw new Error('Updates are delayed.');
          setConnected(true);
          attempt = 0;
          reconcile();
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (!controller.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let end;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              if (!frame.startsWith('event: hint\n')) continue;
              const hint = JSON.parse(
                frame.slice(frame.indexOf('data: ') + 6),
              ) as EventHint;
              if (
                typeof hint.eventId !== 'string' ||
                typeof hint.projectId !== 'string' ||
                seen.has(hint.eventId)
              )
                continue;
              seen.add(hint.eventId);
              if (seen.size > 1000) seen.delete(seen.values().next().value!);
              void client.invalidateQueries({
                predicate: (query) =>
                  query.queryKey[1] === hint.projectId ||
                  ['projects', 'notifications', 'trial'].includes(
                    String(query.queryKey[0]),
                  ),
              });
            }
          }
        } catch {
          /* Reconcile after the next successful connection. */
        }
        setConnected(false);
        if (controller.signal.aborted) break;
        const delay =
          Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)) *
          (0.5 + Math.random() * 0.5);
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(done, delay);
          function done() {
            window.clearTimeout(timer);
            controller.signal.removeEventListener('abort', done);
            resolve();
          }
          controller.signal.addEventListener('abort', done, { once: true });
        });
      }
    }
    void connect();
    return () => controller.abort();
  }, [user?.id, online, client]);
  return (
    <span
      className="connection-status"
      role="status"
      title={
        connected
          ? 'Live update hints are connected. Periodic reconciliation remains active.'
          : 'Changes remain available through the API. Updates will refresh on reconnection.'
      }
    >
      {!online ? 'Offline' : connected ? 'Connected' : 'Reconnecting'}
    </span>
  );
}
