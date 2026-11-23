import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  invitationTokenSchema,
  type InvitationPreview,
} from '@collabboard/contracts';
import { api } from '../../shared/api/client';
import { ErrorState, LoadingState, Notice } from '../../shared/ui/common';
import { useSession } from '../../app/providers/session';
import { useOnline } from '../../shared/lib/use-online';

const key = 'collabboard.pending-invitation';
let memoryCredential: { token: string; expiresAt: number } | null = null;
function takeCredential() {
  const fragment = window.location.hash;
  if (fragment)
    window.history.replaceState(window.history.state, '', '/invite');
  if (fragment) {
    memoryCredential = null;
    const parsed = invitationTokenSchema.safeParse(
      new URLSearchParams(fragment.slice(1)).get('token'),
    );
    if (parsed.success)
      memoryCredential = {
        token: parsed.data,
        expiresAt: Date.now() + 15 * 60 * 1000,
      };
    try {
      sessionStorage.removeItem(key);
      if (memoryCredential)
        sessionStorage.setItem(key, JSON.stringify(memoryCredential));
    } catch {
      /* The credential remains in memory for this navigation. */
    }
    return memoryCredential?.token ?? null;
  }
  if (memoryCredential && memoryCredential.expiresAt > Date.now())
    return memoryCredential.token;
  memoryCredential = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (
      saved?.expiresAt > Date.now() &&
      invitationTokenSchema.safeParse(saved.token).success
    ) {
      memoryCredential = saved;
      return saved.token as string;
    }
    sessionStorage.removeItem(key);
  } catch {
    /* Reopen the original link if temporary browser storage is unavailable. */
  }
  return null;
}
function clearCredential() {
  memoryCredential = null;
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* No persisted credential. */
  }
}

export function InvitationPage() {
  const [token, setToken] = useState(takeCredential);
  const location = useLocation();
  useEffect(() => {
    if (location.hash) setToken(takeCredential());
  }, [location.hash]);
  const { user } = useSession();
  const client = useQueryClient();
  const navigate = useNavigate();
  const online = useOnline();
  const requestId = useMemo(() => crypto.randomUUID(), [token]);
  const previewId = useMemo(() => crypto.randomUUID(), [token]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const query = useQuery({
    queryKey: ['invitation-preview', previewId],
    queryFn: () =>
      api<InvitationPreview>('/invitations/preview', {
        method: 'POST',
        body: { token },
      }),
    enabled: !!token,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  });
  async function accept() {
    if (pending || !online) return;
    setPending(true);
    setError('');
    try {
      const result = await api<{ projectId: string }>('/invitations/accept', {
        method: 'POST',
        body: { token, requestId },
      });
      clearCredential();
      client.removeQueries({ queryKey: ['invitation-preview'] });
      await client.invalidateQueries({ queryKey: ['projects'] });
      navigate(`/projects/${result.projectId}/board`, { replace: true });
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to accept the invitation.',
      );
      await query.refetch();
    } finally {
      setPending(false);
    }
  }
  if (!token)
    return (
      <main className="empty">
        <h1>Invitation link needed</h1>
        <p>
          Open the original invitation link. For your privacy, its credential is
          removed from the address bar and kept temporarily in this tab.
        </p>
        <Link className="button" to="/">
          Back to home
        </Link>
      </main>
    );
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
  const invitation = query.data;
  const available =
    invitation.projectStatus === 'active' &&
    (invitation.status === 'pending' || invitation.status === 'accepted');
  return (
    <main className="invitation-content">
      <h1>Join {invitation.projectName}</h1>
      <p>
        Role: <strong>{invitation.role}</strong>
      </p>
      <p>
        Invitation expires {new Date(invitation.expiresAt).toLocaleString('en')}
        .
      </p>
      {invitation.trialExpiresAt && (
        <Notice>
          This trial project expires{' '}
          {new Date(invitation.trialExpiresAt).toLocaleString('en')}.
        </Notice>
      )}
      {!available ? (
        <Notice>
          {invitation.projectStatus !== 'active'
            ? 'This project is archived or no longer available.'
            : `This invitation is ${invitation.status}. Ask the Owner for a new link.`}
        </Notice>
      ) : !user ? (
        <Link className="button primary" to="/sign-in?returnTo=%2Finvite">
          Sign in to accept
        </Link>
      ) : (
        <>
          <Notice>
            Signed in as {user.email}. The invitation must match your verified
            email.
          </Notice>
          <button
            className="button primary"
            onClick={() => void accept()}
            disabled={pending || !online}
          >
            {pending
              ? 'Joining…'
              : invitation.status === 'accepted'
                ? 'Open joined project'
                : 'Accept invitation'}
          </button>
          <Link className="text-link" to="/sign-in?returnTo=%2Finvite">
            Use another account
          </Link>
        </>
      )}
      {!online && <Notice>You are offline. Acceptance is paused.</Notice>}
      {error && (
        <p role="alert" className="error-copy">
          {error}
        </p>
      )}
      <Link
        className="text-link"
        to={user ? '/projects' : '/'}
        onClick={clearCredential}
      >
        Cancel
      </Link>
    </main>
  );
}
