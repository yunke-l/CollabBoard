import { useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChartNoAxesColumnIncreasing,
  Columns3,
  Layers,
  Plus,
  Search,
  UserRound,
} from 'lucide-react';
import {
  priorities,
  projectCapabilities,
  statusLabels,
  taskStatuses,
  type BoardSnapshot,
  type TaskStatus,
  type MemberSnapshot,
  type TaskResult,
} from '@collabboard/contracts';
import { api, ApiError } from '../../shared/api/client';
import {
  Avatar,
  Dialog,
  ErrorState,
  LoadingState,
  Notice,
} from '../../shared/ui/common';
import { useSession } from '../../app/providers/session';
import { useOnline } from '../../shared/lib/use-online';
import { TrialControls } from '../../features/trials/trial-controls';
import { TaskBoard, dueDateLabel } from '../../features/board/task-board';
import { CreateTaskDialog } from '../../features/tasks/create-task-dialog';
import { TaskDetail } from '../../features/tasks/task-detail';
import { useProjectAccess } from '../../features/projects/use-project-access';

const taskFilterKeys = ['q', 'priority', 'status', 'assignee'] as const;

export function BoardPage({ sample = false }: { sample?: boolean }) {
  const { projectId, taskId } = useParams();
  const { user } = useSession();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const currentSearch = useRef(search);
  currentSearch.current = search;
  const online = useOnline();
  const [creating, setCreating] = useState<TaskStatus | null>(null);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState('');
  const moveLock = useRef(false);
  const moveAttempt = useRef<{ content: string; requestId: string } | null>(
    null,
  );
  const id = sample ? 'sample' : projectId!;
  const base = sample ? '/demo' : `/projects/${id}/board`;
  const query = useQuery({
    queryKey: ['board', id, user?.id],
    queryFn: ({ signal }) =>
      api<BoardSnapshot>(sample ? '/demo' : `/projects/${id}/board`, {
        signal,
      }),
    refetchInterval: sample ? false : 30000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    structuralSharing: (old, next) =>
      old &&
      (old as BoardSnapshot).project.boardRevision >
        (next as BoardSnapshot).project.boardRevision
        ? old
        : next,
  });
  const memberQuery = useQuery({
    queryKey: ['members', id, user?.id],
    queryFn: ({ signal }) =>
      api<MemberSnapshot>(`/projects/${id}/members`, { signal }),
    enabled: !sample,
    refetchOnMount: 'always',
    refetchInterval: 30000,
  });
  useProjectAccess(id, sample ? null : (query.error ?? memberQuery.error));
  const openCreate = (status: TaskStatus) => {
    setCreating(status);
    void memberQuery.refetch();
  };
  async function move(
    taskId: string,
    status: TaskStatus,
    beforeTaskId: string | null,
  ) {
    if (moveLock.current || !online || sample) return;
    const key = ['board', id, user?.id];
    const snapshot = client.getQueryData<BoardSnapshot>(key);
    const task = snapshot?.tasks.find((item) => item.id === taskId);
    if (
      !snapshot ||
      !task ||
      !projectCapabilities(snapshot.project.role, snapshot.project.status)
        .canMoveTask
    )
      return;
    moveLock.current = true;
    setMoving(true);
    setMoveError('');
    const values = {
      expectedVersion: task.version,
      expectedBoardRevision: snapshot.project.boardRevision,
      status,
      beforeTaskId,
    };
    const content = JSON.stringify({ taskId, ...values });
    if (moveAttempt.current?.content !== content)
      moveAttempt.current = { content, requestId: crypto.randomUUID() };
    await client.cancelQueries({ queryKey: key });
    const columns = taskStatuses.flatMap((column) => {
      const tasks = snapshot.tasks
        .filter((item) => item.status === column && item.id !== taskId)
        .sort((a, b) => a.position - b.position);
      if (column === status) {
        const before = beforeTaskId
          ? tasks.findIndex((item) => item.id === beforeTaskId)
          : tasks.length;
        tasks.splice(before < 0 ? tasks.length : before, 0, {
          ...task,
          status,
        });
      }
      return tasks.map((item, position) => ({ ...item, position }));
    });
    client.setQueryData<BoardSnapshot>(key, { ...snapshot, tasks: columns });
    try {
      await api<TaskResult>(`/tasks/${taskId}/move`, {
        method: 'POST',
        body: { ...values, requestId: moveAttempt.current.requestId },
      });
      moveAttempt.current = null;
    } catch (failure) {
      client.setQueryData(key, snapshot);
      setMoveError(
        failure instanceof Error
          ? failure.message
          : 'The move could not be saved. The board has been refreshed.',
      );
    } finally {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['board', id] }),
        client.invalidateQueries({ queryKey: ['task', id] }),
        client.invalidateQueries({ queryKey: ['members', id] }),
        client.invalidateQueries({ queryKey: ['activity', id] }),
      ]);
      moveLock.current = false;
      setMoving(false);
    }
  }
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(currentSearch.current);
    if (value) next.set(key, value);
    else next.delete(key);
    currentSearch.current = next;
    setSearch(next, { replace: true });
  };
  const hasFilters = taskFilterKeys.some((key) => !!search.get(key));
  function clearFilters() {
    const next = new URLSearchParams(currentSearch.current);
    for (const key of taskFilterKeys) next.delete(key);
    currentSearch.current = next;
    setSearch(next, { replace: true });
  }
  const suffix = search.size ? `?${search.toString()}` : '';
  if (query.isPending)
    return (
      <main className="content">
        <LoadingState />
      </main>
    );
  if (
    !query.data ||
    (query.isError &&
      query.error instanceof ApiError &&
      [401, 403, 404].includes(query.error.status))
  )
    return (
      <main className="content">
        <ErrorState
          error={query.error ?? new Error('Unable to load the board.')}
          retry={() => void query.refetch()}
        />
      </main>
    );
  const { project, tasks } = query.data;
  const canCreate =
    !sample &&
    projectCapabilities(project.role, project.status, false, online)
      .canCreateTask;
  const filtered = tasks.filter(
    (task) =>
      task.title
        .toLocaleLowerCase('en')
        .includes((search.get('q') ?? '').trim().toLocaleLowerCase('en')) &&
      (!search.get('priority') || task.priority === search.get('priority')) &&
      (!search.get('status') || task.status === search.get('status')) &&
      (!search.get('assignee') ||
        (sample ? task.assigneeName : task.assigneeId) ===
          search.get('assignee')),
  );
  const column = taskStatuses.includes(search.get('column') as TaskStatus)
    ? (search.get('column') as TaskStatus)
    : 'todo';
  const selected = tasks.find((task) => task.id === taskId);
  const closeTask = () =>
    navigate(
      !sample && search.get('from') === 'archived'
        ? `/projects/${id}/archived-tasks`
        : base + suffix,
      { replace: true },
    );
  return (
    <main className={`content board-content ${sample ? 'sample-content' : ''}`}>
      {!online && (
        <Notice>
          You are offline. New changes are paused until your connection returns.
        </Notice>
      )}
      {query.isError && (
        <Notice>
          The latest refresh failed. Your current view and drafts are kept.{' '}
          <button className="button" onClick={() => void query.refetch()}>
            Retry refresh
          </button>
        </Notice>
      )}
      {moving && (
        <Notice>
          <span role="status">Saving task position…</span>
        </Notice>
      )}
      {moveError && (
        <p role="alert" className="error-copy">
          {moveError}
        </p>
      )}
      {!sample && project.status !== 'active' && (
        <Notice>
          This project is archived and read only.{' '}
          {project.role === 'Owner' && (
            <Link className="text-link" to={`/projects/${id}/settings`}>
              Open project settings to restore it
            </Link>
          )}
        </Notice>
      )}
      <div className="page-heading project-heading">
        <span className="project-symbol">
          <Layers size={24} />
        </span>
        <div className="grow">
          <div className="title-row">
            <h1>{project.name}</h1>
            <span className="badge">{sample ? 'Read only' : project.role}</span>
          </div>
          {project.description && <p>{project.description}</p>}
        </div>
        {sample && (
          <div className="avatar-group">
            <Avatar name="Alex Morgan" />
            <Avatar name="Jamie Lee" />
            <Avatar name="Sam Kim" />
          </div>
        )}
        {sample && (
          <Link to={user ? '/projects' : '/sign-in'} className="text-link">
            Create project
          </Link>
        )}
        {canCreate && (
          <button
            className="button primary"
            onClick={() => openCreate('todo')}
            disabled={moving}
          >
            <Plus size={18} />
            New task
          </button>
        )}
      </div>
      {sample && <TrialControls />}
      {!sample && project.isTrial && (
        <Notice>
          Trial project · expires{' '}
          {new Date(project.expiresAt!).toLocaleString('en')}. This project has
          its own private tasks and members.
        </Notice>
      )}
      <div className="project-tabs">
        <span>
          <Columns3 size={18} />
          Board
        </span>
        {!sample && (
          <>
            <Link className="text-link" to={`/projects/${id}/members`}>
              Members
            </Link>
            <Link className="text-link" to={`/projects/${id}/archived-tasks`}>
              Archived tasks
            </Link>
            <Link className="text-link" to={`/projects/${id}/activity`}>
              Activity
            </Link>
            {project.role === 'Owner' && (
              <Link className="text-link" to={`/projects/${id}/settings`}>
                Settings
              </Link>
            )}
          </>
        )}
        <span className="muted">{tasks.length} tasks</span>
      </div>
      <div className="board-toolbar">
        <label className="search-field">
          <Search size={18} />
          <input
            type="search"
            aria-label="Search tasks"
            placeholder="Search tasks…"
            value={search.get('q') ?? ''}
            onChange={(event) => setFilter('q', event.target.value)}
          />
        </label>
        <label className="filter-field" data-active={!!search.get('priority')}>
          <ChartNoAxesColumnIncreasing size={15} aria-hidden="true" />
          <select
            aria-label="Filter by priority"
            value={search.get('priority') ?? ''}
            onChange={(event) => setFilter('priority', event.target.value)}
          >
            <option value="">All priorities</option>
            {priorities.map((priority) => (
              <option value={priority} key={priority}>
                {priority[0]!.toUpperCase() + priority.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-field" data-active={!!search.get('status')}>
          <Columns3 size={15} aria-hidden="true" />
          <select
            aria-label="Filter by status"
            value={search.get('status') ?? ''}
            onChange={(event) => setFilter('status', event.target.value)}
          >
            <option value="">All statuses</option>
            {taskStatuses.map((status) => (
              <option key={status} value={status}>
                {statusLabels[status]}
              </option>
            ))}
          </select>
        </label>
        {
          <label
            className="filter-field"
            data-active={!!search.get('assignee')}
          >
            <UserRound size={15} aria-hidden="true" />
            <select
              aria-label="Filter by assignee"
              value={search.get('assignee') ?? ''}
              onChange={(event) => setFilter('assignee', event.target.value)}
            >
              <option value="">All assignees</option>
              {sample
                ? ['Alex Morgan', 'Jamie Lee', 'Sam Kim'].map((name) => (
                    <option key={name}>{name}</option>
                  ))
                : memberQuery.data?.members
                    .filter((member) => member.role !== 'Viewer')
                    .map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.displayName}
                      </option>
                    ))}
            </select>
          </label>
        }
        <button
          type="button"
          className="clear-filters"
          disabled={!hasFilters}
          onClick={clearFilters}
        >
          Clear filters
        </button>
        <span className="toolbar-summary">
          {filtered.length} of {tasks.length} tasks
        </span>
      </div>
      {tasks.length > 0 && filtered.length === 0 ? (
        <div className="empty">
          <Search size={28} />
          <h2>No matching tasks</h2>
          <p>Try another search or clear your filters.</p>
        </div>
      ) : (
        <TaskBoard
          tasks={filtered}
          allTasks={tasks}
          taskUrl={(task) =>
            `${sample ? '/demo' : `/projects/${id}`}/tasks/${task}${suffix}`
          }
          selectedColumn={column}
          onColumnChange={(status) => setFilter('column', status)}
          {...(canCreate ? { onAdd: openCreate } : {})}
          {...(canCreate
            ? {
                onMove: (
                  taskId: string,
                  status: TaskStatus,
                  before: string | null,
                ) => {
                  void move(taskId, status, before);
                },
              }
            : {})}
          canReorder={!hasFilters}
          moving={moving}
        />
      )}
      {creating && (
        <CreateTaskDialog
          projectId={id}
          status={creating}
          members={memberQuery.data?.members ?? []}
          canWrite={canCreate}
          onClose={() => setCreating(null)}
        />
      )}
      {taskId && !sample && (
        <TaskDetail
          key={taskId}
          taskId={taskId}
          project={project}
          members={memberQuery.data?.members ?? []}
          onClose={closeTask}
          onMove={move}
          moving={moving}
        />
      )}
      {taskId && sample && (
        <Dialog
          drawer
          title={
            selected
              ? sample
                ? selected.id
                : 'Task details'
              : 'Task not found'
          }
          onClose={closeTask}
        >
          {selected ? (
            <>
              <h1 className="task-title">{selected.title}</h1>
              {sample && <span className="badge">Read-only sample</span>}
              <dl className="task-properties">
                <dt>Status</dt>
                <dd className="task-status" data-status={selected.status}>
                  {statusLabels[selected.status]}
                </dd>
                <dt>Priority</dt>
                <dd className={`priority ${selected.priority}`}>
                  {selected.priority[0]!.toUpperCase() +
                    selected.priority.slice(1)}
                </dd>
                <dt>Assignee</dt>
                <dd>
                  <Avatar
                    name={selected.assigneeName}
                    userId={selected.assigneeId}
                  />
                  {selected.assigneeName ?? 'Unassigned'}
                </dd>
                <dt>Due date</dt>
                <dd>{dueDateLabel(selected) ?? 'No due date'}</dd>
              </dl>
              {selected.description && (
                <section className="task-section">
                  <h2>Description</h2>
                  <p className="plain-text">{selected.description}</p>
                </section>
              )}
            </>
          ) : (
            <p>This task is missing or no longer accessible.</p>
          )}
        </Dialog>
      )}
    </main>
  );
}
