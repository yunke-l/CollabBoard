import { Link } from 'react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { ActivityEntry, CursorPage } from '@collabboard/contracts';
import { useSession } from '../../app/providers/session';
import { api, ApiError } from '../../shared/api/client';
import { ErrorState, LoadingState } from '../../shared/ui/common';
import { useProjectAccess } from '../projects/use-project-access';

const actions: Record<string, string> = {
  'project.created': 'created the project',
  'project.updated': 'updated project details',
  'project.archived': 'archived the project',
  'project.restored': 'restored the project',
  'project.ownership_transferred': 'transferred project ownership',
  'task.created': 'created a task',
  'task.updated': 'updated a task',
  'task.moved': 'moved a task',
  'task.archived': 'archived a task',
  'task.restored': 'restored a task',
  'task.unassigned': 'cleared an ineligible assignment',
  'member.joined': 'joined the project',
  'member.left': 'left the project',
  'member.removed': 'removed a member',
  'member.role_changed': 'changed a member role',
  'invitation.created': 'created an invitation',
  'invitation.revoked': 'revoked an invitation',
  'comment.created': 'added a comment',
  'comment.updated': 'edited a comment',
  'comment.deleted': 'deleted a comment',
  'attachment.created': 'added an attachment',
  'attachment.deleted': 'deleted an attachment',
};
const fields: Record<string, string> = {
  name: 'Name',
  title: 'Title',
  description: 'Description',
  status: 'Status',
  priority: 'Priority',
  dueDate: 'Due date',
  assigneeId: 'Assignee',
  ownerId: 'Owner',
  archivedAt: 'Archive state',
  position: 'Position',
};
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function valueLabel(
  key: string,
  value: unknown,
  people: Record<string, string>,
) {
  if (value === null || value === undefined || value === '')
    return key === 'archivedAt' ? 'Active' : 'None';
  if (key.endsWith('Id')) return people[String(value)] ?? 'Former member';
  if (key === 'status')
    return (
      (
        { todo: 'To Do', in_progress: 'In Progress', done: 'Done' } as Record<
          string,
          string
        >
      )[String(value)] ?? String(value)
    );
  if (key === 'position' && typeof value === 'number') return String(value + 1);
  if (key === 'archivedAt') return 'Archived';
  return String(value);
}

function Changes({ entry }: { entry: ActivityEntry }) {
  const before = object(entry.changes.before);
  const after = object(entry.changes.after);
  const keys = Object.keys(fields).filter(
    (key) => (key in before || key in after) && before[key] !== after[key],
  );
  const roleChanged =
    typeof entry.changes.before === 'string' &&
    typeof entry.changes.after === 'string';
  if (!keys.length && !roleChanged) return null;
  return (
    <details className="activity-changes">
      <summary>View changes</summary>
      <dl>
        {roleChanged && (
          <>
            <dt>Role</dt>
            <dd>
              {String(entry.changes.before)} → {String(entry.changes.after)}
            </dd>
          </>
        )}
        {keys.map((key) => (
          <div key={key}>
            <dt>{fields[key]}</dt>
            <dd className="plain-text">
              {valueLabel(key, before[key], entry.people)} →{' '}
              {valueLabel(key, after[key], entry.people)}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function ActivityFeed({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId?: string;
}) {
  const { user } = useSession();
  const query = useInfiniteQuery({
    queryKey: ['activity', projectId, taskId ?? null, user?.id],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => {
      const params = new URLSearchParams();
      if (taskId) params.set('taskId', taskId);
      if (pageParam) params.set('cursor', pageParam);
      return api<CursorPage<ActivityEntry>>(
        `/projects/${projectId}/activity${params.size ? `?${params}` : ''}`,
        { signal },
      );
    },
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: 30000,
    refetchOnMount: 'always',
    refetchOnReconnect: 'always',
  });
  useProjectAccess(projectId, query.error);
  const items = [
    ...new Map(
      query.data?.pages
        .flatMap((page) => page.items)
        .map((item) => [item.id, item]),
    ).values(),
  ];
  const denied =
    query.error instanceof ApiError &&
    [401, 403, 404].includes(query.error.status);
  const retry = () => {
    if (query.isFetchNextPageError) void query.fetchNextPage();
    else void query.refetch();
  };
  return (
    <section
      className="task-section activity-section"
      aria-label={taskId ? 'Task activity' : 'Project activity'}
    >
      <h2>Activity</h2>
      {query.isPending ? (
        <LoadingState />
      ) : query.isError && (!query.data || denied) ? (
        <ErrorState error={query.error} retry={retry} />
      ) : (
        <>
          {query.isError && <ErrorState error={query.error} retry={retry} />}
          {items.length ? (
            <ol className="activity-list">
              {items.map((entry) => (
                <li key={entry.id}>
                  <p>
                    <strong>{entry.actorName}</strong>
                    {!entry.actorActive && (
                      <small> (left the project)</small>
                    )}{' '}
                    {actions[entry.action] ?? 'updated the project'}
                    {typeof entry.changes.memberId === 'string' &&
                    entry.people[entry.changes.memberId]
                      ? ` · ${entry.people[entry.changes.memberId]}`
                      : ''}
                  </p>
                  {!taskId && entry.taskId && (
                    <Link
                      className="text-link"
                      to={`/projects/${projectId}/tasks/${entry.taskId}`}
                    >
                      {entry.taskTitle ?? 'View task'}
                    </Link>
                  )}
                  <time dateTime={entry.createdAt}>
                    {new Date(entry.createdAt).toLocaleString('en')}
                  </time>
                  <Changes entry={entry} />
                </li>
              ))}
            </ol>
          ) : !query.isError ? (
            <p>No activity yet.</p>
          ) : null}
          {query.hasNextPage && (
            <button
              className="button"
              disabled={query.isFetching}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Load more activity'}
            </button>
          )}
        </>
      )}
    </section>
  );
}
