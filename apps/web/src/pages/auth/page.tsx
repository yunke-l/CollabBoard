import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { User } from '@collabboard/contracts';
import { api } from '../../shared/api/client';
import {
  Avatar,
  Brand,
  ErrorState,
  LoadingState,
  ThemeSwitch,
} from '../../shared/ui/common';
import { useSession } from '../../app/providers/session';

export function SignInPage({ switching = false }: { switching?: boolean }) {
  const { user: currentUser, signIn, signInWithEmail } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  function enter() {
    const destination = switching
      ? '/projects'
      : (search.get('returnTo') ?? '/projects');
    navigate(
      (/^\/projects(?:\/|\?|$)/.test(destination) ||
        destination === '/invite') &&
        !destination.includes('\\')
        ? destination
        : '/projects',
      { replace: true },
    );
  }
  async function emailSignIn(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending('email');
    setError('');
    try {
      await signInWithEmail(email, password);
      enter();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Unable to sign in.',
      );
    } finally {
      setPending(null);
    }
  }
  const identities = useQuery({
    queryKey: ['local-identities'],
    queryFn: ({ signal }) => api<User[]>('/auth/local-identities', { signal }),
  });
  async function select(id: string) {
    setPending(id);
    setError('');
    try {
      await signIn(id);
      enter();
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
      <section className="auth-main">
        {switching ? (
          <button
            className="auth-back text-link"
            disabled={pending !== null}
            onClick={() => {
              if (location.state?.fromAccountControls) navigate(-1);
              else navigate('/projects', { replace: true });
            }}
          >
            Cancel
          </button>
        ) : (
          <Link to="/" className="auth-back text-link">
            Back to home
          </Link>
        )}
        <div className="auth-form">
          <Brand />
          <h1>{switching ? 'Switch account' : 'Sign in'}</h1>
          {switching && currentUser && (
            <p>Currently signed in as {currentUser.email}.</p>
          )}
          <form
            onSubmit={(event) => void emailSignIn(event)}
            className="email-sign-in"
          >
            <label className="field">
              Email
              <input
                aria-label="Email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className="field">
              Password
              <input
                aria-label="Password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button className="button primary" disabled={pending !== null}>
              {pending === 'email' ? 'Signing in…' : 'Sign in with email'}
            </button>
          </form>
          <div className="auth-links">
            <Link
              className="text-link"
              to={`/sign-up${search.get('returnTo') ? `?returnTo=${encodeURIComponent(search.get('returnTo')!)}` : ''}`}
            >
              Create account
            </Link>
            <Link className="text-link" to="/verify-email">
              Verify email
            </Link>
            <Link className="text-link" to="/recover-password">
              Forgot password?
            </Link>
          </div>
          <h2>Development shortcuts</h2>
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
                  disabled={
                    pending !== null ||
                    (switching && currentUser?.id === user.id)
                  }
                  onClick={() => void select(user.id)}
                >
                  <Avatar name={user.displayName} userId={user.id} />
                  <span>
                    <strong>{user.displayName}</strong>
                    <small>{user.email}</small>
                  </span>
                  <span>
                    {switching && currentUser?.id === user.id
                      ? 'Current account'
                      : pending === user.id
                        ? 'Signing in…'
                        : 'Continue'}
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
            View sample board
          </Link>
        </div>
        <ThemeSwitch />
      </section>
    </main>
  );
}
