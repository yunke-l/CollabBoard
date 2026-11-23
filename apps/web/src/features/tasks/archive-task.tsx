import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  projectCapabilities,
  type Project,
  type Task,
  type TaskResult,
} from '@collabboard/contracts';
import { api } from '../../shared/api/client';
import { useOnline } from '../../shared/lib/use-online';
import { refreshProject } from '../projects/use-project-access';

export function ArchiveTask({
  project,
  task,
  disabled = false,
  onPending,
}: {
  project: Project;
  task: Task;
  disabled?: boolean;
  onPending?: (pending: boolean) => void;
}) {
  const client = useQueryClient();
  const online = useOnline();
  const [confirmation, setConfirmation] = useState<{
    expectedVersion: number;
    requestId: string;
    restore: boolean;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const capability = projectCapabilities(
    project.role,
    project.status,
    !!task.archivedAt,
    online,
  );
  const allowed = capability.canArchiveTask || capability.canRestoreTask;
  async function confirm() {
    if (
      !confirmation ||
      !allowed ||
      pending ||
      disabled ||
      confirmation.expectedVersion !== task.version
    )
      return;
    setPending(true);
    onPending?.(true);
    setError('');
    try {
      const { restore, ...body } = confirmation;
      const result = await api<TaskResult>(
        `/tasks/${task.id}/${restore ? 'restore' : 'archive'}`,
        { method: 'POST', body },
      );
      await client.cancelQueries({ queryKey: ['task', project.id, task.id] });
      client.setQueriesData(
        { queryKey: ['task', project.id, task.id] },
        result.task,
      );
      setConfirmation(null);
      await refreshProject(client, project.id);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to change the task.',
      );
      await refreshProject(client, project.id);
    } finally {
      setPending(false);
      onPending?.(false);
    }
  }
  return (
    <div className="archive-task-action">
      {!confirmation && allowed && (
        <button
          className="button"
          disabled={disabled}
          onClick={() => {
            setError('');
            setConfirmation({
              expectedVersion: task.version,
              requestId: crypto.randomUUID(),
              restore: !!task.archivedAt,
            });
          }}
        >
          {task.archivedAt ? 'Restore task' : 'Archive task'}
        </button>
      )}
      {confirmation && (
        <div
          className="action-confirmation"
          role="group"
          aria-label="Confirm task archive or restore"
        >
          <p>
            {confirmation.restore
              ? 'Restore this task to the end of its previous column? Its assignee will be checked against current membership.'
              : 'Archive this task? It will leave the active board. Its details and history will remain available.'}
          </p>
          {error && (
            <p className="error-copy" role="alert">
              {error}
            </p>
          )}
          {confirmation.expectedVersion !== task.version ? (
            <>
              <p>
                This task changed. Review version {task.version} before trying
                again.
              </p>
              <button
                className="button"
                onClick={() => {
                  setConfirmation(null);
                  setError('');
                }}
              >
                Review latest task
              </button>
            </>
          ) : (
            <div className="dialog-actions">
              <button
                className="button"
                disabled={pending}
                onClick={() => setConfirmation(null)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                disabled={pending || disabled || !allowed}
                onClick={() => void confirm()}
              >
                {pending
                  ? 'Saving…'
                  : confirmation.restore
                    ? 'Confirm restore'
                    : 'Confirm archive'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
