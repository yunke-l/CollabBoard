import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createProjectSchema, type Project } from '@collabboard/contracts';
import { api } from '../../shared/api/client';
import { Dialog } from '../../shared/ui/common';
import { useOnline } from '../../shared/lib/use-online';

export function CreateProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const [name, setName] = useState('');
  const [fromSample, setFromSample] = useState(false);
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const attempt = useRef<{ content: string; requestId: string } | null>(null);
  const online = useOnline();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (body: unknown) =>
      api<Project>('/projects', { method: 'POST', body }),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      onCreated(project);
    },
  });
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    const content = JSON.stringify({
      name: name.trim(),
      description: description.trim(),
      fromSample,
    });
    if (attempt.current?.content !== content)
      attempt.current = { content, requestId: crypto.randomUUID() };
    const parsed = createProjectSchema.safeParse({
      name,
      description,
      fromSample,
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
          : 'Unable to create the project.',
      );
    }
  }
  return (
    <Dialog
      title="Create a project"
      busy={mutation.isPending}
      onClose={() => {
        if (!mutation.isPending) onClose();
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <label className="field">
          Project name
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            placeholder="e.g. Website launch"
            aria-describedby={error ? 'project-error' : undefined}
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
        <label className="sample-template-option">
          <input
            type="checkbox"
            checked={fromSample}
            onChange={(event) => setFromSample(event.target.checked)}
          />
          Start with sample tasks
        </label>
        {error && (
          <p id="project-error" role="alert" className="error-copy">
            {error}
          </p>
        )}
        {!online && (
          <p role="status">You are offline. Your draft is kept here.</p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="button"
            onClick={onClose}
            disabled={mutation.isPending}
          >
            Cancel
          </button>
          <button
            className="button primary"
            disabled={mutation.isPending || !online}
          >
            {mutation.isPending ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
