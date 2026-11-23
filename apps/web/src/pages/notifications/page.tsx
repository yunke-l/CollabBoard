import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Check } from 'lucide-react';
import type {
  AssignmentNotification,
  CursorPage,
} from '@collabboard/contracts';
import { useSession } from '../../app/providers/session';
import { api, ApiError } from '../../shared/api/client';
import { ErrorState, LoadingState, Notice } from '../../shared/ui/common';
import { useOnline } from '../../shared/lib/use-online';
import { useNotificationSummary } from '../../features/notifications/queries';

export function NotificationsPage() {
  const { user } = useSession();
  const online = useOnline();
  const client = useQueryClient();
  const summary = useNotificationSummary();
  const query = useInfiniteQuery({
    queryKey: ['notifications', 'list', user?.id],
    queryFn: ({ signal, pageParam }) =>
      api<CursorPage<AssignmentNotification>>(
        `/notifications${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: 30000,
    refetchOnMount: 'always',
    refetchOnReconnect: 'always',
  });
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const attempts = useRef(new Map<string, string>());
  async function markRead(id: string | null) {
    if (pending || !online) return;
    const key = id ?? 'all';
    if (!attempts.current.has(key))
      attempts.current.set(key, crypto.randomUUID());
    setPending(key);
    setError('');
    setNotice('');
    try {
      await api(id ? `/notifications/${id}/read` : '/notifications/read-all', {
        method: 'POST',
        body: { requestId: attempts.current.get(key) },
      });
      attempts.current.delete(key);
      setNotice(
        id
          ? 'Notification marked as read.'
          : 'Notifications marked as read. New arrivals remain unread.',
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to mark notifications as read. Please try again.',
      );
    } finally {
      await client.invalidateQueries({ queryKey: ['notifications'] });
      setPending(null);
    }
  }
  const items = [
    ...new Map(
      query.data?.pages
        .flatMap((page) => page.items)
        .map((item) => [item.id, item]),
    ).values(),
  ];
  const retry = () => {
    if (query.isFetchNextPageError) void query.fetchNextPage();
    else void query.refetch();
  };
  const inaccessible =
    query.error instanceof ApiError &&
    [401, 403, 404].includes(query.error.status);
  return (
    <main className="content notifications-content">
      <div className="page-heading">
        <div>
          <h1>Notifications</h1>
        </div>
        <button
          className="button"
          disabled={
            !online ||
            !!pending ||
            summary.isError ||
            !summary.data?.unreadCount
          }
          onClick={() => void markRead(null)}
        >
          <Check size={16} />
          {pending === 'all' ? 'Marking…' : 'Mark all as read'}
        </button>
      </div>
      {!online && (
        <Notice>
          You are offline. Loaded notifications are kept; read actions are
          paused.
        </Notice>
      )}
      {summary.isError ? (
        <Notice>
          Unread count is unavailable.{' '}
          <button className="button" onClick={() => void summary.refetch()}>
            Retry unread count
          </button>
        </Notice>
      ) : (
        summary.data && (
          <p className="notification-count" aria-live="polite">
            {summary.data.unreadCount} unread{' '}
            {summary.data.unreadCount === 1 ? 'notification' : 'notifications'}
          </p>
        )
      )}
      {error && (
        <p role="alert" className="error-copy">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {query.isPending ? (
        <LoadingState />
      ) : query.isError && (!query.data || inaccessible) ? (
        <ErrorState error={query.error} retry={retry} />
      ) : (
        <>
          {query.isError && <ErrorState error={query.error} retry={retry} />}
          {items.length ? (
            <div className="notification-list">
              {items.map((item) => (
                <article
                  key={item.id}
                  className={`notification-row${item.readAt ? '' : ' unread'}`}
                  aria-label={
                    item.readAt ? 'Read notification' : 'Unread notification'
                  }
                >
                  <Bell size={20} aria-hidden="true" />
                  <div className="grow">
                    {item.target ? (
                      <>
                        <p>
                          <strong>{item.target.actorName}</strong> assigned you
                          a task
                        </p>
                        <Link
                          className="text-link notification-task"
                          to={`/projects/${item.target.projectId}/tasks/${item.target.taskId}`}
                        >
                          {item.target.taskTitle}
                        </Link>
                        <small>
                          {item.target.projectName}
                          {item.target.taskArchived ? ' · Archived task' : ''}
                        </small>
                      </>
                    ) : (
                      <>
                        <strong>Task no longer accessible</strong>
                        <p>Your project access may have changed.</p>
                      </>
                    )}
                    <time dateTime={item.createdAt}>
                      {new Date(item.createdAt).toLocaleString('en')}
                    </time>
                  </div>
                  {item.readAt ? (
                    <span className="badge">Read</span>
                  ) : (
                    <button
                      className="button"
                      disabled={!online || !!pending}
                      onClick={() => void markRead(item.id)}
                    >
                      {pending === item.id ? 'Marking…' : 'Mark as read'}
                    </button>
                  )}
                </article>
              ))}
            </div>
          ) : !query.isError ? (
            <div className="empty">
              <Bell size={32} />
              <h2>No notifications</h2>
            </div>
          ) : null}
          {query.hasNextPage && (
            <div className="dialog-actions">
              <button
                className="button"
                disabled={query.isFetching}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage
                  ? 'Loading…'
                  : 'Load more notifications'}
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
