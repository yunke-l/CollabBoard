import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { EventHint } from '@collabboard/contracts';
import { useSession } from '../../app/providers/session';
import { authorizedFetch } from '../../shared/api/client';
import { useOnline } from '../../shared/lib/use-online';
import { refreshFromHint } from './refresh-from-hint';

export function ConnectionStatus() {
  const { user } = useSession();
  const online = useOnline();
  if (!user || !online)
    return <StatusLabel online={online} connected={false} />;
  return <LiveConnection key={user.id} />;
}

function LiveConnection() {
  const client = useQueryClient();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const seen = new Set<string>();
    async function connect() {
      let attempt = 0;
      while (!controller.signal.aborted) {
        try {
          const response = await authorizedFetch('/api/events', {
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          if (!response.ok || !response.body)
            throw new Error('Updates are delayed.');
          setConnected(true);
          attempt = 0;
          void refreshFromHint(client);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (!controller.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            console.debug(
              'hint-reader',
              value.length,
              buffer.length,
              buffer.indexOf('\n\n'),
              buffer.endsWith('\n\n'),
              buffer.startsWith('event: '),
            );
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
              console.debug(
                'hint-refresh',
                hint.eventType.split('.')[0],
                navigator.onLine,
                document.visibilityState,
                client
                  .getQueryCache()
                  .findAll({ queryKey: ['board', hint.projectId] })
                  .map((q) =>
                    [
                      q.state.fetchStatus,
                      q.getObserversCount(),
                      q.isActive(),
                    ].join('/'),
                  )
                  .join(','),
              );
              seen.add(hint.eventId);
              if (seen.size > 1000) seen.delete(seen.values().next().value!);
              void refreshFromHint(client, hint.projectId);
            }
          }
        } catch {
          /* Reconcile after the next successful connection. */
        }
        if (controller.signal.aborted) break;
        setConnected(false);
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
  }, [client]);
  return <StatusLabel connected={connected} online />;
}

function StatusLabel({
  connected,
  online,
}: {
  connected: boolean;
  online: boolean;
}) {
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
