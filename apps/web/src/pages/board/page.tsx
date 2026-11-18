import { useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Columns3, Layers, Plus, Search } from 'lucide-react';
import {
  priorities,
  projectCapabilities,
  statusLabels,
  taskStatuses,
  type BoardSnapshot,
  type TaskStatus,
} from '@collabboard/contracts';
import { api } from '../../shared/api/client';
import {
  Avatar,
  Dialog,
  ErrorState,
  LoadingState,
  Notice,
} from '../../shared/ui/common';
import { useSession } from '../../app/providers/session';
import { useOnline } from '../../shared/lib/use-online';
import { TaskBoard, dueDateLabel } from '../../features/board/task-board';
import { CreateTaskDialog } from '../../features/tasks/create-task-dialog';

export function BoardPage({ sample = false }: { sample?: boolean }) {
  const { projectId, taskId } = useParams();
  const { user } = useSession();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const currentSearch = useRef(search);
  currentSearch.current = search;
  const online = useOnline();
  const [creating, setCreating] = useState<TaskStatus | null>(null);
  const id = sample ? 'sample' : projectId!;
  const base = sample ? '/demo' : `/projects/${id}/board`;
  const query = useQuery({
    queryKey: ['board', id, user?.id],
    queryFn: ({ signal }) =>
      api<BoardSnapshot>(sample ? '/demo' : `/projects/${id}/board`, {
        signal,
      }),
    refetchInterval: sample ? false : 30000,
    refetchOnWindowFocus: true,
  });
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(currentSearch.current);
    if (value) next.set(key, value);
    else next.delete(key);
    currentSearch.current = next;
    setSearch(next, { replace: true });
  };
  const suffix = search.size ? `?${search.toString()}` : '';
  if (query.isPending)
    return (
      <main className="content">
        <LoadingState />
      </main>
    );
  if (query.isError)
    return (
      <main className="content">
        <ErrorState error={query.error} retry={() => void query.refetch()} />
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
      (!search.get('assignee') || task.assigneeName === search.get('assignee')),
  );
  const column = taskStatuses.includes(search.get('column') as TaskStatus)
    ? (search.get('column') as TaskStatus)
    : 'todo';
  const selected = tasks.find((task) => task.id === taskId);
  const closeTask = () => navigate(base + suffix, { replace: true });
  return (
    <main className={`content board-content ${sample ? 'sample-content' : ''}`}>
      {sample && (
        <div className="sample-notice">
          <span className="badge">Public sample</span>
          <span>
            Synthetic data. A little inspiration for your next project.
          </span>
          <Link to={user ? '/projects' : '/sign-in'} className="text-link">
            Create your own project
          </Link>
        </div>
      )}
      {!online && (
        <Notice>
          You are offline. New changes are paused until your connection returns.
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
          <p>
            {project.description || 'A shared space to move your work forward.'}
          </p>
        </div>
        {sample && (
          <div className="avatar-group">
            <Avatar name="Alex Morgan" />
            <Avatar name="Jamie Lee" />
            <Avatar name="Sam Kim" />
          </div>
        )}
        {canCreate && (
          <button
            className="button primary"
            onClick={() => setCreating('todo')}
          >
            <Plus size={18} />
            New task
          </button>
        )}
      </div>
      <div className="project-tabs">
        <span>
          <Columns3 size={18} />
          Board
        </span>
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
        <label className="filter-field">
          <span className="sr-only">Filter by priority</span>
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
        <label className="filter-field">
          <span className="sr-only">Filter by status</span>
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
        {sample && (
          <label className="filter-field">
            <span className="sr-only">Filter by assignee</span>
            <select
              aria-label="Filter by assignee"
              value={search.get('assignee') ?? ''}
              onChange={(event) => setFilter('assignee', event.target.value)}
            >
              <option value="">All assignees</option>
              {['Alex Morgan', 'Jamie Lee', 'Sam Kim'].map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
        )}
        <span className="toolbar-summary">
          {filtered.length} of {tasks.length} tasks
        </span>
      </div>
      {tasks.length > 0 && filtered.length === 0 ? (
        <div className="empty">
          <Search size={28} />
          <h2>No matching tasks</h2>
          <p>Try another search or clear your filters.</p>
          <button className="button" onClick={() => setSearch({})}>
            Clear filters
          </button>
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
          {...(canCreate ? { onAdd: setCreating } : {})}
        />
      )}
      <div className="board-footer">
        <span>
          {sample
            ? 'Explore a task to see the details.'
            : 'Every next step has a place.'}
        </span>
        <span>
          {sample
            ? 'Read-only sample · No changes are saved'
            : `Board revision ${project.boardRevision}`}
        </span>
      </div>
      {creating && (
        <CreateTaskDialog
          projectId={id}
          status={creating}
          onClose={() => setCreating(null)}
        />
      )}
      {taskId && (
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
                <dd>{statusLabels[selected.status]}</dd>
                <dt>Priority</dt>
                <dd className={`priority ${selected.priority}`}>
                  {selected.priority[0]!.toUpperCase() +
                    selected.priority.slice(1)}
                </dd>
                <dt>Assignee</dt>
                <dd>
                  <Avatar name={selected.assigneeName} />
                  {selected.assigneeName ?? 'Unassigned'}
                </dd>
                <dt>Due date</dt>
                <dd>{dueDateLabel(selected) ?? 'No due date'}</dd>
              </dl>
              <section className="task-section">
                <h2>Description</h2>
                <p className="plain-text">
                  {selected.description || 'No description yet.'}
                </p>
              </section>
              {sample && (
                <section className="task-section">
                  <h2>Discussion</h2>
                  <div className="sample-comment">
                    <Avatar name="Alex Morgan" />
                    <div>
                      <strong>Alex Morgan</strong>
                      <p>
                        Let's keep the experience simple and make every next
                        step clear.
                      </p>
                      <small>Synthetic sample comment</small>
                    </div>
                  </div>
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
