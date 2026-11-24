import {
  MemberSelect,
  assigneeOptions,
} from '../../features/projects/member-select';
import { SelectControl } from '../../shared/ui/select-control';
import { ChartNoAxesColumnIncreasing } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  priorities,
  projectCapabilities,
  statusLabels,
  updateTaskSchema,
  type MemberSnapshot,
  type Project,
  type Task,
  type TaskResult,
} from '@collabboard/contracts';
import { ApiError, api } from '../../shared/api/client';
import {
  Avatar,
  Dialog,
  ErrorState,
  LoadingState,
  Notice,
} from '../../shared/ui/common';
import { useSession } from '../../app/providers/session';
import { useOnline } from '../../shared/lib/use-online';
import { dueDateLabel } from '../board/task-board';
import { ArchiveTask } from './archive-task';
import { CommentSection } from '../comments/comment-section';
import { AttachmentSection } from '../files/attachment-section';
import { ActivityFeed } from '../activity/activity-feed';

type Draft = {
  title: string;
  description: string;
  priority: string;
  dueDate: string;
  assigneeId: string;
  expectedVersion: number;
};

export function TaskDetail({
  project,
  taskId,
  members,
  membersFailed,
  onClose,
  moving,
}: {
  project: Project;
  taskId: string;
  members: MemberSnapshot['members'] | undefined;
  membersFailed: boolean;
  onClose: () => void;
  moving: boolean;
}) {
  const { user } = useSession();
  const online = useOnline();
  const client = useQueryClient();
  const queryKey = ['task', project.id, taskId, user?.id];
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const task = await api<Task>(`/tasks/${taskId}`, { signal });
      if (task.projectId !== project.id)
        throw new Error('This task does not belong to this project.');
      return task;
    },
    refetchInterval: 30000,
    refetchOnMount: 'always',
    structuralSharing: (old, next) =>
      old && (old as Task).version > (next as Task).version ? old : next,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 404) {
      void client.invalidateQueries({ queryKey: ['board', project.id] });
      void client.invalidateQueries({ queryKey: ['members', project.id] });
    }
  }, [client, project.id, query.error]);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [commentPending, setCommentPending] = useState(false);
  const [filePending, setFilePending] = useState(false);
  const resourcePending = commentPending || filePending;
  const attempt = useRef<{ content: string; requestId: string } | null>(null);
  const canEdit = projectCapabilities(
    project.role,
    project.status,
    !!query.data?.archivedAt,
    online,
  ).canEditTask;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || pending || !canEdit || conflict || moving || resourcePending)
      return;
    setError('');
    const values = {
      ...draft,
      assigneeId: draft.assigneeId || null,
      dueDate: draft.dueDate || null,
    };
    const content = JSON.stringify(values);
    if (attempt.current?.content !== content)
      attempt.current = { content, requestId: crypto.randomUUID() };
    const parsed = updateTaskSchema.safeParse({
      ...values,
      requestId: attempt.current.requestId,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]!.message);
      return;
    }
    setPending(true);
    try {
      const result = await api<TaskResult>(`/tasks/${taskId}`, {
        method: 'PATCH',
        body: parsed.data,
      });
      await client.cancelQueries({ queryKey });
      client.setQueryData(queryKey, result.task);
      setDraft(null);
      setConflict(false);
      await client.invalidateQueries({ queryKey: ['board', project.id] });
      await client.invalidateQueries({ queryKey: ['activity', project.id] });
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to save the task. Your draft is kept.',
      );
      if (
        failure instanceof ApiError &&
        failure.detail.code === 'VERSION_CONFLICT'
      ) {
        setConflict(true);
        await query.refetch();
      }
      if (
        failure instanceof ApiError &&
        (failure.status === 403 ||
          failure.status === 404 ||
          failure.detail.code === 'INVALID_ASSIGNEE' ||
          failure.detail.code === 'PROJECT_ARCHIVED')
      ) {
        await Promise.all([
          client.invalidateQueries({ queryKey: ['board', project.id] }),
          client.invalidateQueries({ queryKey: ['members', project.id] }),
        ]);
      }
    } finally {
      setPending(false);
    }
  }
  function edit(task: Task) {
    void client.invalidateQueries({ queryKey: ['members', project.id] });
    setDraft({
      title: task.title,
      description: task.description,
      priority: task.priority,
      dueDate: task.dueDate ?? '',
      assigneeId: task.assigneeId ?? '',
      expectedVersion: task.version,
    });
    setError('');
    setConflict(false);
    attempt.current = null;
  }
  const task = query.data;
  return (
    <Dialog
      drawer
      title="Task details"
      busy={pending || archiving || resourcePending}
      onClose={() => {
        if (!pending && !archiving && !resourcePending) onClose();
      }}
    >
      {query.isPending ? (
        <LoadingState />
      ) : query.isError &&
        (!task ||
          (query.error instanceof ApiError &&
            [401, 403, 404].includes(query.error.status))) ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        task && (
          <>
            {query.isError && (
              <Notice>
                The latest refresh failed. Your task and draft are kept.{' '}
                <button className="button" onClick={() => void query.refetch()}>
                  Retry refresh
                </button>
              </Notice>
            )}
            {!draft ? (
              <>
                <h1 className="task-title">{task.title}</h1>
                {task.archivedAt && (
                  <Notice>
                    This task is archived. Details and history are kept. Restore
                    it before making changes.
                  </Notice>
                )}
                <dl className="task-properties">
                  <dt>Status</dt>
                  <dd className="task-status" data-status={task.status}>
                    {statusLabels[task.status]}
                  </dd>
                  <dt>Priority</dt>
                  <dd>
                    <span className={`priority ${task.priority}`}>
                      {task.priority}
                    </span>
                  </dd>
                  <dt>Assignee</dt>
                  <dd>
                    <Avatar name={task.assigneeName} userId={task.assigneeId} />
                    {task.assigneeName ?? 'Unassigned'}
                  </dd>
                  <dt>Due date</dt>
                  <dd>{dueDateLabel(task) ?? 'No due date'}</dd>
                </dl>
                {canEdit && (
                  <button
                    className="button primary"
                    onClick={() => edit(task)}
                    disabled={
                      moving || archiving || resourcePending || query.isFetching
                    }
                  >
                    Edit task
                  </button>
                )}
                <ArchiveTask
                  project={project}
                  task={task}
                  disabled={moving || resourcePending || query.isFetching}
                  onPending={setArchiving}
                />
                <section className="task-section">
                  <h2>Description</h2>
                  <p className="plain-text">
                    {task.description || 'No description yet.'}
                  </p>
                </section>
              </>
            ) : (
              <form onSubmit={(event) => void save(event)}>
                <h1 className="task-title">Edit task</h1>
                {!online && (
                  <Notice>
                    You are offline. Your draft is kept here. Saving will resume
                    when you are online.
                  </Notice>
                )}
                {project.role === 'Viewer' && (
                  <Notice>
                    Your role is now Viewer. Your draft is kept for copying;
                    saving is disabled.
                  </Notice>
                )}
                {project.status !== 'active' && (
                  <Notice>
                    This project is archived. Your draft is kept for copying.
                  </Notice>
                )}
                {task.archivedAt && (
                  <Notice>
                    This task was archived. Your draft is kept for copying;
                    saving is disabled.
                  </Notice>
                )}
                {conflict && (
                  <div className="conflict-review" role="alert">
                    <h2>This task has a newer version</h2>
                    <p>
                      Your draft is kept in the form below. Review the latest
                      saved values before continuing.
                    </p>
                    <dl>
                      <dt>Title</dt>
                      <dd>{task.title}</dd>
                      <dt>Description</dt>
                      <dd className="plain-text">
                        {task.description || 'No description'}
                      </dd>
                      <dt>Priority</dt>
                      <dd>
                        <span className={`priority ${task.priority}`}>
                          {task.priority}
                        </span>
                      </dd>
                      <dt>Assignee</dt>
                      <dd>{task.assigneeName ?? 'Unassigned'}</dd>
                      <dt>Due date</dt>
                      <dd>{task.dueDate ?? 'No due date'}</dd>
                    </dl>
                    <button
                      type="button"
                      className="button"
                      disabled={
                        !canEdit ||
                        pending ||
                        query.isFetching ||
                        task.version <= draft.expectedVersion
                      }
                      onClick={() => {
                        setDraft({ ...draft, expectedVersion: task.version });
                        setConflict(false);
                        setError('');
                      }}
                    >
                      {task.version <= draft.expectedVersion
                        ? 'Loading latest version…'
                        : `Continue editing against version ${task.version}`}
                    </button>
                  </div>
                )}
                <label className="field">
                  Task title
                  <input
                    autoFocus
                    required
                    readOnly={pending || project.role === 'Viewer'}
                    value={draft.title}
                    onChange={(event) =>
                      setDraft({ ...draft, title: event.target.value })
                    }
                  />
                </label>
                <label className="field">
                  Description
                  <textarea
                    aria-label="Description"
                    rows={6}
                    readOnly={pending || project.role === 'Viewer'}
                    value={draft.description}
                    onChange={(event) =>
                      setDraft({ ...draft, description: event.target.value })
                    }
                  />
                </label>
                <label className="field">
                  Priority
                  <SelectControl
                    icon={ChartNoAxesColumnIncreasing}
                    disabled={pending || project.role === 'Viewer'}
                    value={draft.priority}
                    onChange={(event) =>
                      setDraft({ ...draft, priority: event.target.value })
                    }
                  >
                    {priorities.map((priority) => (
                      <option key={priority} value={priority}>
                        {priority}
                      </option>
                    ))}
                  </SelectControl>
                </label>
                <label className="field">
                  Assignee
                  <MemberSelect
                    disabled={pending || project.role === 'Viewer'}
                    value={draft.assigneeId}
                    onChange={(event) =>
                      setDraft({ ...draft, assigneeId: event.target.value })
                    }
                    options={assigneeOptions(members)}
                    placeholder="Unassigned"
                    emptyLabel="No assignees available"
                    loadFailed={membersFailed}
                  />
                </label>
                <label className="field">
                  Due date
                  <input
                    type="date"
                    readOnly={pending || project.role === 'Viewer'}
                    value={draft.dueDate}
                    onChange={(event) =>
                      setDraft({ ...draft, dueDate: event.target.value })
                    }
                  />
                </label>
                {error && (
                  <p className="error-copy" role="alert">
                    {error}
                  </p>
                )}
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="button"
                    disabled={pending}
                    onClick={() => {
                      setDraft(null);
                      setError('');
                      setConflict(false);
                    }}
                  >
                    Discard draft
                  </button>
                  <button
                    className="button primary"
                    disabled={
                      pending ||
                      !canEdit ||
                      conflict ||
                      moving ||
                      resourcePending
                    }
                  >
                    {pending ? 'Saving…' : 'Save changes'}
                  </button>
                </div>
              </form>
            )}
            <CommentSection
              project={project}
              task={task}
              disabled={pending || archiving || moving || filePending}
              onPending={setCommentPending}
            />
            <AttachmentSection
              project={project}
              task={task}
              disabled={pending || archiving || moving || commentPending}
              onPending={setFilePending}
            />
            <ActivityFeed projectId={project.id} taskId={task.id} />
            <p className="task-version">Version {task.version}</p>
          </>
        )
      )}
    </Dialog>
  );
}
