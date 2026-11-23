import { useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Plus } from 'lucide-react';
import {
  createInvitationSchema,
  projectCapabilities,
  limits,
  type Invitation,
  type MemberSnapshot,
  type ProjectMember,
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
import { useProjectAccess } from '../../features/projects/use-project-access';
import { LeaveProject } from '../../features/projects/leave-project';
import { PendingInvitations } from '../../features/projects/pending-invitations';

function credential() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function MembersPage() {
  const { projectId = '' } = useParams();
  const { user } = useSession();
  const online = useOnline();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['members', projectId, user?.id],
    queryFn: ({ signal }) =>
      api<MemberSnapshot>(`/projects/${projectId}/members`, { signal }),
    refetchInterval: 30000,
    refetchOnMount: 'always',
  });
  useProjectAccess(projectId, query.error);
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'Editor' | 'Viewer'>('Editor');
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [action, setAction] = useState<{
    member: ProjectMember;
    role: 'Editor' | 'Viewer' | null;
  } | null>(null);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const attempt = useRef<{
    content: string;
    requestId: string;
    token: string;
  } | null>(null);
  const actionId = useRef(crypto.randomUUID());
  const canManage = query.data
    ? projectCapabilities(
        query.data.project.role,
        query.data.project.status,
        false,
        online,
      ).canManageMembers
    : false;
  async function refresh() {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['members', projectId] }),
      client.invalidateQueries({ queryKey: ['invitations', projectId] }),
      client.invalidateQueries({ queryKey: ['board', projectId] }),
      client.invalidateQueries({ queryKey: ['activity', projectId] }),
    ]);
  }
  async function invite(event: FormEvent) {
    event.preventDefault();
    if (pending || !canManage) return;
    setError('');
    const content = JSON.stringify({ email: email.trim().toLowerCase(), role });
    if (attempt.current?.content !== content)
      attempt.current = {
        content,
        requestId: crypto.randomUUID(),
        token: credential(),
      };
    const input = createInvitationSchema.safeParse({
      email: email.trim(),
      role,
      requestId: attempt.current.requestId,
      token: attempt.current.token,
    });
    if (!input.success) {
      setError(input.error.issues[0]!.message);
      return;
    }
    setPending(true);
    try {
      await api(`/projects/${projectId}/invitations`, {
        method: 'POST',
        body: input.data,
      });
      setLink(
        `${window.location.origin}/invite#token=${attempt.current.token}`,
      );
      setCopied(false);
      await refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to create the invitation.',
      );
    } finally {
      setPending(false);
    }
  }
  async function confirm() {
    if (pending || !canManage) return;
    setPending(true);
    setError('');
    try {
      if (action)
        await api(`/projects/${projectId}/members/${action.member.id}`, {
          method: action.role ? 'PATCH' : 'DELETE',
          body: {
            requestId: actionId.current,
            ...(action.role ? { role: action.role } : {}),
          },
        });
      else if (revoking)
        await api(`/projects/${projectId}/invitations/${revoking.id}/revoke`, {
          method: 'POST',
          body: { requestId: actionId.current },
        });
      setAction(null);
      setRevoking(null);
      await refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to save this change.',
      );
      await query.refetch();
    } finally {
      setPending(false);
    }
  }
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
  const { project, members } = query.data;
  return (
    <main className="content members-content">
      <Link className="text-link" to={`/projects/${projectId}/board`}>
        ← Back to board
      </Link>
      <div className="page-heading project-heading">
        <div>
          <h1>Members</h1>
          <p>
            {project.name} · {members.length} of {limits.members} members
          </p>
        </div>
        {canManage && (
          <button
            className="button primary"
            onClick={() => {
              setInviting(true);
              setLink('');
              setError('');
              setEmail('');
              attempt.current = null;
            }}
          >
            <Plus size={18} />
            Invite member
          </button>
        )}
        <LeaveProject project={project} />
      </div>
      {!online && <Notice>You are offline. Member changes are paused.</Notice>}
      {project.role !== 'Owner' && (
        <Notice>
          Only the project Owner can invite members or change their roles.
        </Notice>
      )}
      {project.status !== 'active' && (
        <Notice>This project is archived. Member changes are paused.</Notice>
      )}
      {error && !inviting && !action && !revoking && (
        <p role="alert" className="error-copy">
          {error}
        </p>
      )}
      <div className="member-list">
        {members.map((member) => (
          <article className="member-row" key={member.id}>
            <Avatar name={member.displayName} userId={member.id} />
            <div className="grow">
              <strong>
                {member.displayName}
                {member.id === user?.id ? ' (you)' : ''}
              </strong>
              <small>{member.email}</small>
            </div>
            <span className="badge">{member.role}</span>
            {canManage && member.role !== 'Owner' && (
              <div className="member-actions">
                <button
                  className="button"
                  onClick={() => {
                    actionId.current = crypto.randomUUID();
                    setError('');
                    setAction({
                      member,
                      role: member.role === 'Editor' ? 'Viewer' : 'Editor',
                    });
                  }}
                >
                  Make {member.role === 'Editor' ? 'Viewer' : 'Editor'}
                </button>
                <button
                  className="button danger"
                  onClick={() => {
                    actionId.current = crypto.randomUUID();
                    setError('');
                    setAction({ member, role: null });
                  }}
                >
                  Remove
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      {project.role === 'Owner' && (
        <PendingInvitations
          projectId={projectId}
          canManage={canManage}
          onRevoke={(invitation) => {
            actionId.current = crypto.randomUUID();
            setRevoking(invitation);
            setError('');
          }}
        />
      )}
      {inviting && (
        <Dialog
          busy={pending}
          title={link ? 'Invitation link' : 'Invite a member'}
          onClose={() => {
            if (!pending) {
              setInviting(false);
              setLink('');
            }
          }}
        >
          {link ? (
            <>
              <p>
                Share this single-use link with {email}. It expires in 72 hours.
                No email has been sent. Creating another invitation for this
                email invalidates the previous link.
              </p>
              <label className="field">
                Invitation link
                <input
                  readOnly
                  value={link}
                  onFocus={(event) => event.target.select()}
                />
              </label>
              <button
                className="button primary"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(link)
                    .then(() => setCopied(true))
                    .catch(() => setError('Select and copy the link above.'));
                }}
              >
                <Copy size={16} />
                {copied ? 'Copied' : 'Copy link'}
              </button>
            </>
          ) : (
            <form onSubmit={(event) => void invite(event)}>
              <p>
                Invite a teammate as an Editor or a Viewer. They must accept
                with the matching verified email.
              </p>
              <label className="field">
                Email address
                <input
                  autoFocus
                  type="email"
                  required
                  value={email}
                  disabled={pending}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label className="field">
                Role
                <select
                  value={role}
                  disabled={pending}
                  onChange={(event) =>
                    setRole(event.target.value as 'Editor' | 'Viewer')
                  }
                >
                  <option>Editor</option>
                  <option>Viewer</option>
                </select>
              </label>
              <div className="dialog-actions">
                <button
                  type="button"
                  className="button"
                  disabled={pending}
                  onClick={() => setInviting(false)}
                >
                  Cancel
                </button>
                <button
                  className="button primary"
                  disabled={pending || !canManage}
                >
                  {pending ? 'Creating…' : 'Create invitation'}
                </button>
              </div>
            </form>
          )}
          {error && (
            <p role="alert" className="error-copy">
              {error}
            </p>
          )}
        </Dialog>
      )}
      {(action || revoking) && (
        <Dialog
          busy={pending}
          title={
            action
              ? action.role
                ? 'Change member role'
                : 'Remove member'
              : 'Revoke invitation'
          }
          onClose={() => {
            if (!pending) {
              setAction(null);
              setRevoking(null);
            }
          }}
        >
          <p>
            {action
              ? action.role
                ? `Change ${action.member.displayName} to ${action.role}? ${action.role === 'Viewer' ? 'Their active task assignments will be cleared, and they will no longer be able to make changes.' : 'They will be able to edit tasks and receive assignments.'}`
                : `Remove ${action.member.displayName}? Their active task assignments will be cleared and they will lose project access.`
              : `Revoke the invitation for ${revoking?.email}? Its link will stop working.`}
          </p>
          {error && (
            <p role="alert" className="error-copy">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="button"
              disabled={pending}
              onClick={() => {
                setAction(null);
                setRevoking(null);
              }}
            >
              Cancel
            </button>
            <button
              className="button primary"
              disabled={pending || !canManage}
              onClick={() => void confirm()}
            >
              {pending ? 'Saving…' : 'Confirm'}
            </button>
          </div>
        </Dialog>
      )}
    </main>
  );
}
