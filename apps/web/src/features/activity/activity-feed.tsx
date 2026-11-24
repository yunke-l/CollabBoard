import {
  Activity,
  ArrowUpRight,
  CheckSquare,
  Folder,
  Mail,
  MessageSquare,
  Paperclip,
  Users,
} from 'lucide-react';
import { Link, useLocation } from 'react-router';
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
const eventIcons = {
  project: Folder,
  task: CheckSquare,
  member: Users,
  invitation: Mail,
  comment: MessageSquare,
  attachment: Paperclip,
};
const dayFormat = new Intl.DateTimeFormat('en', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});
const timeFormat = new Intl.DateTimeFormat('en', {
  hour: 'numeric',
  minute: '2-digit',
});

function ActivityDay({
  day,
  entries,
  projectId,
  taskId,
}: {
  day: string;
  entries: ActivityEntry[];
  projectId: string;
  taskId?: string | undefined;
}) {
  const location = useLocation();
  return (
    <div className="activity-day">
      <h3>{day}</h3>
      <ol>
        {entries.map((entry) => {
          const kind = entry.action.split('.')[0] as keyof typeof eventIcons;
          const Icon = eventIcons[kind] ?? Activity;
          return (
            <li key={entry.id}>
              <span
                className="activity-marker"
                data-kind={kind}
                aria-hidden="true"
              >
                <Icon size={16} />
              </span>
              <div className="activity-item">
                <div className="activity-line">
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
                  <time dateTime={entry.createdAt}>
                    {timeFormat.format(new Date(entry.createdAt))}
                  </time>
                </div>
                {!taskId && entry.taskId && (
                  <Link
                    className="activity-task"
                    to={
                      projectId === 'sample'
                        ? {
                            pathname: `/demo/tasks/${entry.taskId}`,
                            search: location.search,
                          }
                        : `/projects/${projectId}/tasks/${entry.taskId}`
                    }
                    state={
                      projectId === 'sample'
                        ? { fromSampleActivity: true }
                        : null
                    }
                  >
                    {entry.taskTitle ?? 'View task'}
                    <ArrowUpRight size={13} aria-hidden="true" />
                  </Link>
                )}
                <Changes entry={entry} />
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
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
          <div>
            <dt>Role</dt>
            <dd>
              {String(entry.changes.before)} → {String(entry.changes.after)}
            </dd>
          </div>
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

export function ActivityTimeline({
  items,
  projectId,
  taskId,
}: {
  items: ActivityEntry[];
  projectId: string;
  taskId?: string | undefined;
}) {
  const byDay = new Map<string, ActivityEntry[]>();
  for (const entry of items) {
    const day = dayFormat.format(new Date(entry.createdAt));
    const group = byDay.get(day);
    if (group) group.push(entry);
    else byDay.set(day, [entry]);
  }
  return (
    <div className="activity-list">
      {Array.from(byDay, ([day, entries]) => (
        <ActivityDay
          key={day}
          day={day}
          entries={entries}
          projectId={projectId}
          taskId={taskId}
        />
      ))}
    </div>
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
      className={taskId ? 'task-section activity-section' : 'activity-section'}
      aria-label={taskId ? 'Task activity' : 'Project activity'}
    >
      <h2>{taskId ? 'Activity' : 'Project activity'}</h2>
      {query.isPending ? (
        <LoadingState />
      ) : query.isError && (!query.data || denied) ? (
        <ErrorState error={query.error} retry={retry} />
      ) : (
        <>
          {query.isError && <ErrorState error={query.error} retry={retry} />}
          {items.length ? (
            <ActivityTimeline
              items={items}
              projectId={projectId}
              taskId={taskId}
            />
          ) : !query.isError ? (
            <div className="empty activity-empty">
              <Activity size={24} aria-hidden="true" />
              <p>No activity yet.</p>
            </div>
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
