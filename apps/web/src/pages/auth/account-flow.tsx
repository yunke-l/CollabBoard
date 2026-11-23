import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import {
  signUpSchema,
  verifyEmailSchema,
  emailSchema,
  resetPasswordSchema,
} from '@collabboard/contracts';
import { api } from '../../shared/api/client';
import { Brand, Notice, ThemeSwitch } from '../../shared/ui/common';
import { useOnline } from '../../shared/lib/use-online';

type Kind = 'sign-up' | 'verify' | 'recover';
export function AccountFlow({ kind }: { kind: Kind }) {
  const [search] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const online = useOnline();
  const [email, setEmail] = useState(search.get('email') ?? '');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [developmentCode, setDevelopmentCode] = useState<string>(
    location.state?.developmentCode ?? '',
  );
  const [recovering, setRecovering] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const title =
    kind === 'sign-up'
      ? 'Create your account'
      : kind === 'verify'
        ? 'Verify your email'
        : recovering
          ? 'Choose a new password'
          : 'Recover your password';
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !online) return;
    const schema =
      kind === 'sign-up'
        ? signUpSchema
        : kind === 'verify'
          ? verifyEmailSchema
          : recovering
            ? resetPasswordSchema
            : emailSchema;
    const parsed = schema.safeParse({ email, displayName, password, code });
    if (!parsed.success) {
      setError(parsed.error.issues[0]!.message);
      return;
    }
    setPending(true);
    setError('');
    setSuccess('');
    try {
      const result = await api<{ developmentCode?: string }>(
        kind === 'sign-up'
          ? '/auth/sign-up'
          : kind === 'verify'
            ? '/auth/verify-email'
            : recovering
              ? '/auth/reset-password'
              : '/auth/recover',
        { method: 'POST', body: parsed.data },
      );
      if (kind === 'sign-up')
        navigate(
          `/verify-email?email=${encodeURIComponent(email)}${search.get('returnTo') ? `&returnTo=${encodeURIComponent(search.get('returnTo')!)}` : ''}`,
          { state: { developmentCode: result.developmentCode } },
        );
      else if (kind === 'verify') {
        setSuccess('Email verified. You can sign in now.');
        setDevelopmentCode('');
      } else if (!recovering) {
        setRecovering(true);
        setDevelopmentCode(result.developmentCode ?? '');
      } else {
        setSuccess(
          'Password reset. Previous sessions are signed out. Sign in with your new password.',
        );
        setDevelopmentCode('');
        setPassword('');
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to complete this step.',
      );
    } finally {
      setPending(false);
    }
  }
  async function resend() {
    const parsed = emailSchema.safeParse({ email });
    if (!parsed.success) {
      setError(parsed.error.issues[0]!.message);
      return;
    }
    setPending(true);
    setError('');
    try {
      const result = await api<{ developmentCode: string }>(
        '/auth/resend-verification',
        { method: 'POST', body: parsed.data },
      );
      setDevelopmentCode(result.developmentCode);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to resend the code.',
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="auth-layout account-layout">
      <section className="auth-main">
        <Link className="auth-back text-link" to="/sign-in">
          Back to sign in
        </Link>
        <div className="auth-form">
          <Brand />
          <h1>{title}</h1>
          <Notice>
            Local development identity. Verification and recovery codes appear
            in the development mailbox below; no email is sent.
          </Notice>
          {developmentCode && (
            <div className="development-mailbox" role="status">
              <strong>Development mailbox</strong>
              <p>
                Your code:{' '}
                <code data-testid="development-code">{developmentCode}</code>
              </p>
              <small>Valid for ten minutes.</small>
            </div>
          )}
          {success ? (
            <>
              <p role="status">{success}</p>
              <Link
                className="button primary"
                to={`/sign-in${search.get('returnTo') ? `?returnTo=${encodeURIComponent(search.get('returnTo')!)}` : ''}`}
              >
                Sign in
              </Link>
            </>
          ) : (
            <form onSubmit={(event) => void submit(event)}>
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
              {kind === 'sign-up' && (
                <label className="field">
                  Display name
                  <input
                    aria-label="Display name"
                    autoComplete="nickname"
                    required
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                </label>
              )}
              {(kind === 'verify' || recovering) && (
                <label className="field">
                  Verification code
                  <input
                    aria-label="Verification code"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </label>
              )}
              {(kind === 'sign-up' || recovering) && (
                <label className="field">
                  Password
                  <input
                    aria-label="Password"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={128}
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <small>Use 12–128 characters.</small>
                </label>
              )}
              {error && (
                <p className="error-copy" role="alert">
                  {error}
                </p>
              )}
              {!online && (
                <Notice>
                  You are offline. Your form is kept until you reconnect.
                </Notice>
              )}
              <button className="button primary" disabled={pending || !online}>
                {pending
                  ? 'Working…'
                  : kind === 'sign-up'
                    ? 'Create account'
                    : kind === 'verify'
                      ? 'Verify email'
                      : recovering
                        ? 'Reset password'
                        : 'Request recovery code'}
              </button>
              {kind === 'verify' && (
                <button
                  type="button"
                  className="button"
                  disabled={pending || !online}
                  onClick={() => void resend()}
                >
                  Resend verification code
                </button>
              )}
            </form>
          )}
        </div>
        <ThemeSwitch />
      </section>
    </main>
  );
}
