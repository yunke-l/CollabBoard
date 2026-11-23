import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Project } from '@collabboard/contracts';
import { api } from '../../shared/api/client';
import { Dialog, Notice } from '../../shared/ui/common';
import { useOnline } from '../../shared/lib/use-online';
import { useSession } from '../../app/providers/session';
import { clearProject } from '../projects/use-project-access';

type CurrentTrial = { projectId: string; expiresAt: string };
export function TrialControls({ project }: { project?: Project }) {
  const { user } = useSession();
  const online = useOnline();
  const client = useQueryClient();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['trial', user?.id],
    queryFn: async ({ signal }) =>
      (
        await api<{ trial: CurrentTrial | null }>('/demo/projects/current', {
          signal,
        })
      ).trial,
    enabled: !!user && !project,
    refetchInterval: 30000,
  });
  const [action, setAction] = useState<'start' | 'reset' | 'cleanup' | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const attempt = useRef<{ action: string; requestId: string } | null>(null);
  if (!user || (project && !project.isTrial)) return null;
  const target = project
    ? { projectId: project.id, expiresAt: project.expiresAt! }
    : query.data;
  const owner = !project || project.role === 'Owner';
  async function confirm() {
    if (!action || pending || !online) return;
    const key = `${action}:${target?.projectId ?? ''}`;
    if (attempt.current?.action !== key)
      attempt.current = { action: key, requestId: crypto.randomUUID() };
    setPending(true);
    setError('');
    try {
      const result = await api<CurrentTrial>(
        action === 'start'
          ? '/demo/projects'
          : `/demo/projects/${target!.projectId}/${action}`,
        { method: 'POST', body: { requestId: attempt.current.requestId } },
      );
      if (target && action !== 'start')
        await clearProject(client, target.projectId);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['projects'] }),
        client.invalidateQueries({ queryKey: ['trial'] }),
      ]);
      setAction(null);
      attempt.current = null;
      navigate(
        action === 'cleanup'
          ? '/projects'
          : `/projects/${result.projectId}/board`,
        { replace: true },
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to change this trial.',
      );
      void query.refetch();
    } finally {
      setPending(false);
    }
  }
  return (
    <div
      className={project ? 'trial-controls settings-section' : 'trial-controls'}
    >
      {project && (
        <>
          <h2>Trial project</h2>
          <Notice>
            This isolated trial expires{' '}
            {new Date(target!.expiresAt).toLocaleString('en')}. Resetting
            replaces its tasks, comments, invitations, and membership with a
            fresh private sample. Ordinary projects are kept.
          </Notice>
        </>
      )}
      <div className="trial-actions">
        {!project && target && (
          <Link className="button" to={`/projects/${target.projectId}/board`}>
            Open trial
          </Link>
        )}
        {!project && !target && (
          <button
            className="button"
            disabled={!online || query.isPending}
            onClick={() => {
              setAction('start');
              setError('');
            }}
          >
            Start a seven-day trial
          </button>
        )}
        {target && owner && (
          <>
            <button
              className="button"
              disabled={!online || pending}
              onClick={() => {
                setAction('reset');
                setError('');
              }}
            >
              Reset trial
            </button>
            <button
              className="button danger"
              disabled={!online || pending}
              onClick={() => {
                setAction('cleanup');
                setError('');
              }}
            >
              Clean up trial
            </button>
          </>
        )}
      </div>
      {query.isError && !project && (
        <p className="error-copy" role="alert">
          Unable to check your current trial.{' '}
          <button className="button" onClick={() => void query.refetch()}>
            Retry
          </button>
        </p>
      )}
      {action && (
        <Dialog
          busy={pending}
          title={
            action === 'start'
              ? 'Start your trial'
              : action === 'reset'
                ? 'Reset trial'
                : 'Clean up trial'
          }
          onClose={() => {
            if (!pending) setAction(null);
          }}
        >
          <p>
            {action === 'start'
              ? 'Create your own copy of the sample board. It expires in seven days and counts separately from ordinary projects. You can invite members, reset it, or clean it up early.'
              : action === 'reset'
                ? 'The current trial will become inaccessible immediately. Its members and attachments will not carry over. Your new sample has a fresh seven-day lifetime.'
                : 'The trial and its invitations will become inaccessible immediately. Its data and private files will be queued for removal.'}
          </p>
          {error && (
            <p className="error-copy" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="button"
              disabled={pending}
              onClick={() => setAction(null)}
            >
              Cancel
            </button>
            <button
              className={`button ${action === 'cleanup' ? 'danger' : 'primary'}`}
              disabled={pending || !online}
              onClick={() => void confirm()}
            >
              {pending
                ? 'Saving…'
                : action === 'start'
                  ? 'Create trial'
                  : action === 'reset'
                    ? 'Confirm reset'
                    : 'Confirm cleanup'}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
