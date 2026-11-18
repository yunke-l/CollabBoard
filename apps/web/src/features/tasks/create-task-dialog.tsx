import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createTaskSchema,
  priorities,
  statusLabels,
  taskStatuses,
  type TaskStatus,
} from '@collabboard/contracts';
import { api } from '../../shared/api/client';
import { Dialog } from '../../shared/ui/common';
import { useOnline } from '../../shared/lib/use-online';

export function CreateTaskDialog({
  projectId,
  status: initialStatus,
  onClose,
}: {
  projectId: string;
  status: TaskStatus;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<TaskStatus>(initialStatus);
  const [priority, setPriority] = useState('medium');
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState('');
  const attempt = useRef<{ content: string; requestId: string } | null>(null);
  const online = useOnline();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (body: unknown) =>
      api(`/projects/${projectId}/tasks`, { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['board', projectId] });
      onClose();
    },
  });
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    const values = {
      title: title.trim(),
      description: description.trim(),
      status,
      priority,
      dueDate: dueDate || null,
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
    }
  }
  return (
    <Dialog
      title="Create a task"
      onClose={() => {
        if (!mutation.isPending) onClose();
      }}
    >
      <p>Turn the next step into something you can move forward.</p>
      <form onSubmit={(event) => void submit(event)}>
        <label className="field">
          Task title
          <input
            autoFocus
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What needs to happen?"
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
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as TaskStatus)}
            >
              {taskStatuses.map((item) => (
                <option key={item} value={item}>
                  {statusLabels[item]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Priority
            <select
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            >
              {priorities.map((item) => (
                <option key={item} value={item}>
                  {item[0]!.toUpperCase() + item.slice(1)}
                </option>
              ))}
            </select>
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
            disabled={mutation.isPending || !online}
          >
            {mutation.isPending ? 'Creating…' : 'Create task'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
