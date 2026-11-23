import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { Project } from '@collabboard/contracts';
import { api } from '../../shared/api/client';
import { Dialog } from '../../shared/ui/common';
import { useOnline } from '../../shared/lib/use-online';
import { clearProject, refreshProject } from './use-project-access';

export function LeaveProject({ project }: { project: Project }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(crypto.randomUUID());
  async function leave() {
    if (pending || !online || project.role === 'Owner') return;
    setPending(true);
    setError('');
    try {
      await api(`/projects/${project.id}/leave`, {
        method: 'POST',
        body: { requestId: requestId.current },
      });
      await clearProject(client, project.id);
      navigate('/projects', {
        replace: true,
        state: { notice: `You left ${project.name}.` },
      });
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to leave this project.',
      );
      await refreshProject(client, project.id);
      setPending(false);
    }
  }
  return (
    <>
      <button
        className="button danger"
        disabled={!online}
        onClick={() => {
          setOpen(true);
          setError('');
          requestId.current = crypto.randomUUID();
        }}
      >
        Leave project
      </button>
      {open && (
        <Dialog
          busy={pending}
          title="Leave project"
          onClose={() => {
            if (!pending) setOpen(false);
          }}
        >
          {project.role === 'Owner' ? (
            <>
              <p>
                Transfer ownership to another member before leaving.{' '}
                {project.status === 'archived' &&
                  'Restore the project first to transfer ownership.'}
              </p>
              <div className="dialog-actions">
                <Link
                  className="button primary"
                  to={`/projects/${project.id}/settings`}
                >
                  Open project settings
                </Link>
              </div>
            </>
          ) : (
            <>
              <p>
                You will lose access to {project.name}. Your active tasks will
                become unassigned. An Owner can invite you again.
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
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="button danger"
                  disabled={pending || !online}
                  onClick={() => void leave()}
                >
                  {pending ? 'Leaving…' : 'Confirm departure'}
                </button>
              </div>
            </>
          )}
        </Dialog>
      )}
    </>
  );
}
