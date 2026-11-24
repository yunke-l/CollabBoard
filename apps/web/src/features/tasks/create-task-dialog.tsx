import {
  MemberSelect,
  assigneeOptions,
} from '../../features/projects/member-select';
import { SelectControl } from '../../shared/ui/select-control';
import { Columns3, ChartNoAxesColumnIncreasing } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createTaskSchema,
  priorities,
  statusLabels,
  taskStatuses,
  type TaskStatus,
  type ProjectMember,
} from '@collabboard/contracts';
import { api, ApiError } from '../../shared/api/client';
import { Dialog } from '../../shared/ui/common';
import { useOnline } from '../../shared/lib/use-online';

export function CreateTaskDialog({
  projectId,
  status: initialStatus,
  onClose,
  members,
  membersFailed,
  canWrite,
}: {
  projectId: string;
  status: TaskStatus;
  onClose: () => void;
  members: ProjectMember[] | undefined;
  membersFailed: boolean;
  canWrite: boolean;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<TaskStatus>(initialStatus);
  const [priority, setPriority] = useState('medium');
  const [dueDate, setDueDate] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [error, setError] = useState('');
  const attempt = useRef<{ content: string; requestId: string } | null>(null);
  const online = useOnline();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (body: unknown) =>
      api(`/projects/${projectId}/tasks`, { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['board', projectId] });
      await queryClient.invalidateQueries({
        queryKey: ['activity', projectId],
      });
      onClose();
    },
  });
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (mutation.isPending || !online || !canWrite) return;
    setError('');
    const values = {
      title: title.trim(),
      description: description.trim(),
      status,
      priority,
      dueDate: dueDate || null,
      assigneeId: assigneeId || null,
    };
    const content = JSON.stringify(values);
    if (attempt.current?.content !== content)
      attempt.current = { content, requestId: crypto.randomUUID() };
    const parsed = createTaskSchema.safeParse({
      ...values,
      requestId: attempt.current.requestId,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]!.message);
      return;
    }
    try {
      await mutation.mutateAsync(parsed.data);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to create the task.',
      );
      if (
        failure instanceof ApiError &&
        ([403, 404].includes(failure.status) ||
          failure.detail.code === 'PROJECT_ARCHIVED')
      ) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['board', projectId] }),
          queryClient.invalidateQueries({ queryKey: ['members', projectId] }),
        ]);
      }
    }
  }
  return (
    <Dialog
      title="Create a task"
      busy={mutation.isPending}
      onClose={() => {
        if (!mutation.isPending) onClose();
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <label className="field">
          Assignee
          <MemberSelect
            value={assigneeId}
            onChange={(event) => setAssigneeId(event.target.value)}
            options={assigneeOptions(members)}
            placeholder="Unassigned"
            emptyLabel="No assignees available"
            loadFailed={membersFailed}
          />
        </label>
        <label className="field">
          Task title
          <input
            autoFocus
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-describedby={error ? 'task-error' : undefined}
          />
        </label>
        <label className="field">
          Description <span className="muted">Optional</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
          />
        </label>
        <div className="form-grid">
          <label className="field">
            Status
            <SelectControl
              icon={Columns3}
              value={status}
              onChange={(event) => setStatus(event.target.value as TaskStatus)}
            >
              {taskStatuses.map((item) => (
                <option key={item} value={item}>
                  {statusLabels[item]}
                </option>
              ))}
            </SelectControl>
          </label>
          <label className="field">
            Priority
            <SelectControl
              icon={ChartNoAxesColumnIncreasing}
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            >
              {priorities.map((item) => (
                <option key={item} value={item}>
                  {item[0]!.toUpperCase() + item.slice(1)}
                </option>
              ))}
            </SelectControl>
          </label>
        </div>
        <label className="field">
          Due date <span className="muted">Optional</span>
          <input
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
          />
        </label>
        {error && (
          <p id="task-error" role="alert" className="error-copy">
            {error}
          </p>
        )}
        {!online && (
          <p role="status">You are offline. Your draft is kept here.</p>
        )}
        <div className="dialog-actions">
          <button
            className="button"
            type="button"
            onClick={onClose}
            disabled={mutation.isPending}
          >
            Cancel
          </button>
          <button
            className="button primary"
            disabled={mutation.isPending || !online || !canWrite}
          >
            {mutation.isPending ? 'Creating…' : 'Create task'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
