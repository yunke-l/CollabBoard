import {
  MemberSelect,
  assigneeOptions,
} from '../../features/projects/member-select';
import { useRef, useState } from 'react';
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChartNoAxesColumnIncreasing, Columns3, Search } from 'lucide-react';
import {
  priorities,
  projectCapabilities,
  statusLabels,
  taskStatuses,
  type BoardSnapshot,
  type TaskStatus,
  type Task,
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
import { SelectControl } from '../../shared/ui/select-control';
import { useProjectControls } from '../../app/layouts/project-layout';
import { TaskBoard, dueDateLabel } from '../../features/board/task-board';
import { TaskDetail } from '../../features/tasks/task-detail';
import { useProjectAccess } from '../../features/projects/use-project-access';

import { SampleTaskHistory } from '../../features/tasks/sample-task-history';

const taskFilterKeys = ['q', 'priority', 'status', 'assignee'] as const;

function moveInBoard(
  allTasks: Task[],
  task: Task,
  status: TaskStatus,
  beforeTaskId: string | null,
) {
  const taskId = task.id;
  return taskStatuses.flatMap((column) => {
    const tasks = allTasks
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
}

export function BoardPage({ sample = false }: { sample?: boolean }) {
  const { projectId, taskId } = useParams();
  const { user } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const client = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const currentSearch = useRef(search);
  currentSearch.current = search;
  const online = useOnline();
  const {
    openCreate,
    moving,
    setMoving,
    sampleBoard,
    sampleTasks,
    setSampleTasks,
  } = useProjectControls();
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
    refetchOnMount: sample ? false : 'always',
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
  async function move(
    taskId: string,
    status: TaskStatus,
    beforeTaskId: string | null,
  ) {
    if (sample) {
      const initial = query.data?.tasks;
      if (initial)
        setSampleTasks((current) => {
          const tasks = current ?? initial;
          const task = tasks.find((item) => item.id === taskId);
          return task
            ? moveInBoard(tasks, task, status, beforeTaskId)
            : current;
        });
      return;
    }
    if (moveLock.current || !online) return;
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
    const columns = moveInBoard(snapshot.tasks, task, status, beforeTaskId);
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
      <>
        <LoadingState />
      </>
    );
  if (
    !query.data ||
    (query.isError &&
      query.error instanceof ApiError &&
      [401, 403, 404].includes(query.error.status))
  )
    return (
      <>
        <ErrorState
          error={query.error ?? new Error('Unable to load the board.')}
          retry={() => void query.refetch()}
        />
      </>
    );
  const { project } = query.data;
  const tasks = sample && sampleTasks ? sampleTasks : query.data.tasks;
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
      sample && location.state?.fromSampleActivity
        ? '/demo/activity' + suffix
        : !sample && search.get('from') === 'archived'
          ? `/projects/${id}/archived-tasks`
          : base + suffix,
      { replace: true },
    );
  return (
    <>
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
        <SelectControl
          icon={ChartNoAxesColumnIncreasing}
          active={!!search.get('priority')}
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
        </SelectControl>
        <SelectControl
          icon={Columns3}
          active={!!search.get('status')}
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
        </SelectControl>
        <MemberSelect
          active={!!search.get('assignee')}
          aria-label="Filter by assignee"
          value={search.get('assignee') ?? ''}
          options={
            sample
              ? ['Alex Morgan', 'Jamie Lee', 'Sam Kim'].map((name) => ({
                  value: name,
                  label: name,
                }))
              : assigneeOptions(memberQuery.data?.members)
          }
          placeholder="All assignees"
          emptyLabel="No assignees available"
          loadFailed={memberQuery.isError}
          onChange={(event) => setFilter('assignee', event.target.value)}
        />
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
          {...(sample || canCreate
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
      {taskId && !sample && (
        <TaskDetail
          key={taskId}
          taskId={taskId}
          project={project}
          members={memberQuery.data?.members}
          membersFailed={memberQuery.isError}
          onClose={closeTask}
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
              <dl className="task-properties">
                <dt>Status</dt>
                <dd className="task-status" data-status={selected.status}>
                  <select
                    aria-label="Sample task status"
                    value={selected.status}
                    onChange={(event) =>
                      void move(
                        selected.id,
                        event.target.value as TaskStatus,
                        null,
                      )
                    }
                  >
                    {taskStatuses.map((value) => (
                      <option key={value} value={value}>
                        {statusLabels[value]}
                      </option>
                    ))}
                  </select>
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
              {sampleBoard && (
                <SampleTaskHistory board={sampleBoard} taskId={selected.id} />
              )}
            </>
          ) : (
            <p>This task is missing or no longer accessible.</p>
          )}
        </Dialog>
      )}
    </>
  );
}
