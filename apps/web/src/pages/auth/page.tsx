import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { User } from '@collabboard/contracts';
import { api } from '../../shared/api/client';
import {
  Avatar,
  Brand,
  ErrorState,
  LoadingState,
  Notice,
  ThemeSwitch,
} from '../../shared/ui/common';
import { useSession } from '../../app/providers/session';

export function SignInPage() {
  const { signIn } = useSession();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const identities = useQuery({
    queryKey: ['local-identities'],
    queryFn: ({ signal }) => api<User[]>('/auth/local-identities', { signal }),
  });
  async function select(id: string) {
    setPending(id);
    setError('');
    try {
      await signIn(id);
      const destination = search.get('returnTo') ?? '/projects';
      navigate(
        /^\/projects(?:\/|\?|$)/.test(destination) &&
          !destination.includes('\\')
          ? destination
          : '/projects',
        { replace: true },
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to sign in. Please try again.',
      );
    } finally {
      setPending(null);
    }
  }
  return (
    <main className="auth-layout">
      <section className="auth-story">
        <Brand />
        <div>
          <span className="eyebrow">Clarity starts here</span>
          <h1>
            Good work happens
            <br />
            when we work together.
          </h1>
          <p>
            Keep the plan clear, the conversation close,
            <br />
            and the whole team moving forward.
          </p>
        </div>
        <span>One board. A shared direction.</span>
      </section>
      <section className="auth-main">
        <Link to="/" className="auth-back text-link">
          Back to home
        </Link>
        <div className="auth-form">
          <div className="mobile-only">
            <Brand />
          </div>
          <h1>Welcome to CollabBoard</h1>
          <p>Choose a local development account to get started.</p>
          <Notice>
            This development build uses synthetic accounts without passwords.
            Sessions stay in memory and expire after one hour.
          </Notice>
          {identities.isPending ? (
            <LoadingState />
          ) : identities.isError ? (
            <ErrorState
              error={identities.error}
              retry={() => void identities.refetch()}
            />
          ) : (
            <div className="identity-list">
              {identities.data.map((user) => (
                <button
                  className="identity-option"
                  key={user.id}
                  disabled={pending !== null}
                  onClick={() => void select(user.id)}
                >
                  <Avatar name={user.displayName} />
                  <span>
                    <strong>{user.displayName}</strong>
                    <small>{user.email}</small>
                  </span>
                  <span>
                    {pending === user.id ? 'Signing in…' : 'Continue'}
                  </span>
                </button>
              ))}
            </div>
          )}
          {error && (
            <p role="alert" className="error-copy">
              {error}
            </p>
          )}
          <Link to="/demo" className="text-link auth-sample">
            Just looking? Explore the sample board
          </Link>
        </div>
        <ThemeSwitch />
      </section>
    </main>
  );
}
