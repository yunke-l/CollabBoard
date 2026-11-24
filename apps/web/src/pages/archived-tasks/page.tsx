import { Link, useParams } from 'react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  statusLabels,
  type ArchivedTaskSnapshot,
} from '@collabboard/contracts';
import { useSession } from '../../app/providers/session';
import { api, ApiError } from '../../shared/api/client';
import { ErrorState, LoadingState, Notice } from '../../shared/ui/common';
import { useProjectAccess } from '../../features/projects/use-project-access';
import { ArchiveTask } from '../../features/tasks/archive-task';
import { useOnline } from '../../shared/lib/use-online';

export function ArchivedTasksPage() {
  const { projectId = '' } = useParams();
  const { user } = useSession();
  const online = useOnline();
  const query = useInfiniteQuery({
    queryKey: ['archived-tasks', projectId, user?.id],
    queryFn: ({ signal, pageParam }) =>
      api<ArchivedTaskSnapshot>(
        `/projects/${projectId}/archived-tasks${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: 30000,
    refetchOnMount: 'always',
  });
  useProjectAccess(projectId, query.error);
  if (query.isPending)
    return (
      <div>
        <LoadingState />
      </div>
    );
  if (
    query.isError &&
    (!query.data ||
      (query.error instanceof ApiError &&
        [401, 403, 404].includes(query.error.status)))
  )
    return (
      <div>
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      </div>
    );
  const project = query.data!.pages[0]!.project;
  const tasks = [
    ...new Map(
      query
        .data!.pages.flatMap((page) => page.items)
        .map((task) => [task.id, task]),
    ).values(),
  ];
  return (
    <div>
      <div className="page-heading">
        <div>
          <h2>Archived tasks</h2>
        </div>
      </div>
      {!online && (
        <Notice>
          You are offline. Archived tasks remain available here; restoration is
          paused.
        </Notice>
      )}
      {project.status === 'archived' && (
        <Notice>
          Restore the project before restoring tasks.{' '}
          {project.role === 'Owner' && (
            <Link className="text-link" to={`/projects/${projectId}/settings`}>
              Open project settings
            </Link>
          )}
        </Notice>
      )}
      {query.isError && (
        <Notice>
          The latest refresh failed.{' '}
          <button className="button" onClick={() => void query.refetch()}>
            Retry refresh
          </button>
        </Notice>
      )}
      {tasks.length === 0 ? (
        <div className="empty">
          <h2>No archived tasks</h2>
        </div>
      ) : (
        <div className="archived-task-list">
          {tasks.map((task) => (
            <article className="archived-task-row" key={task.id}>
              <div className="grow">
                <Link
                  className="text-link"
                  to={`/projects/${projectId}/tasks/${task.id}?from=archived`}
                >
                  {task.title}
                </Link>
                <p className="muted">
                  <span className="task-status" data-status={task.status}>
                    {statusLabels[task.status]}
                  </span>{' '}
                  ·{' '}
                  <span className={`priority ${task.priority}`}>
                    {task.priority} priority
                  </span>{' '}
                  · {task.assigneeName ?? 'Unassigned'}
                </p>
              </div>
              <ArchiveTask task={task} project={project} />
            </article>
          ))}
        </div>
      )}
      {query.hasNextPage && (
        <div className="load-more">
          <button
            className="button"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Load more archived tasks'}
          </button>
        </div>
      )}
    </div>
  );
}
