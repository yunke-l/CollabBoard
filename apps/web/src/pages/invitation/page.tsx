import { useLayoutEffect, useState } from 'react';
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
type Credential = { token: string; expiresAt: number };
let memoryCredential: Credential | null = null;

function readCredential(fragment: string): Credential | null {
  if (fragment) {
    const parsed = invitationTokenSchema.safeParse(
      new URLSearchParams(fragment.slice(1)).get('token'),
    );
    return parsed.success
      ? { token: parsed.data, expiresAt: Date.now() + 15 * 60 * 1000 }
      : null;
  }
  if (memoryCredential && memoryCredential.expiresAt > Date.now())
    return memoryCredential;
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (
      saved?.expiresAt > Date.now() &&
      invitationTokenSchema.safeParse(saved.token).success
    )
      return saved;
  } catch {
    /* Reopen the original link if temporary browser storage is unavailable. */
  }
  return null;
}
function storeCredential(credential: Credential | null) {
  memoryCredential = credential;
  try {
    sessionStorage.removeItem(key);
    if (credential) sessionStorage.setItem(key, JSON.stringify(credential));
  } catch {
    /* The credential remains in memory for this navigation. */
  }
}

export function InvitationPage() {
  const location = useLocation();
  return <InvitationView key={location.hash} fragment={location.hash} />;
}

function InvitationView({ fragment }: { fragment: string }) {
  const [credential] = useState(() => readCredential(fragment));
  const token = credential?.token;
  useLayoutEffect(() => {
    if (fragment)
      window.history.replaceState(window.history.state, '', '/invite');
    storeCredential(credential);
  }, [credential, fragment]);
  const { user } = useSession();
  const client = useQueryClient();
  const navigate = useNavigate();
  const online = useOnline();
  const [requestId] = useState(() => crypto.randomUUID());
  const [previewId] = useState(() => crypto.randomUUID());
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
      storeCredential(null);
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
        onClick={() => storeCredential(null)}
      >
        Cancel
      </Link>
    </main>
  );
}
