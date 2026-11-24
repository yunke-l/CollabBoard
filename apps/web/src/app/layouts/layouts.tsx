import {
  Link,
  Navigate,
  NavLink,
  Outlet,
  useLocation,
  useMatch,
  useNavigate,
} from 'react-router';
import { useState } from 'react';
import { Columns3, FolderKanban, LogOut, UsersRound } from 'lucide-react';
import {
  Avatar,
  Brand,
  Dialog,
  LoadingState,
  ThemeSwitch,
} from '../../shared/ui/common';
import { useSession } from '../providers/session';
import { NotificationLink } from '../../features/notifications/notification-link';
import { ConnectionStatus } from '../../features/events/connection-status';
import { useOnline } from '../../shared/lib/use-online';

export function PublicLayout() {
  const { user } = useSession();
  return (
    <>
      <header className="public-header">
        <Brand />
        <nav aria-label="Main navigation">
          <Link to="/demo" className="text-link">
            View sample
          </Link>
          <ThemeSwitch />
          <Link className="button primary" to={user ? '/projects' : '/sign-in'}>
            {user ? 'My projects' : 'Sign in'}
          </Link>
        </nav>
      </header>
      <Outlet />
      <footer className="public-footer">
        <Brand />
      </footer>
    </>
  );
}
export function SampleLayout() {
  const { user, ready } = useSession();
  if (!ready)
    return (
      <main className="content">
        <LoadingState />
      </main>
    );
  return user ? <AppLayout /> : <PublicLayout />;
}

export function SessionBoundary() {
  const { user, ready } = useSession();
  const location = useLocation();
  if (!ready)
    return (
      <main className="content">
        <LoadingState />
      </main>
    );
  return user ? (
    <Outlet />
  ) : (
    <Navigate
      replace
      to={`/sign-in?returnTo=${encodeURIComponent(location.pathname + location.search)}`}
    />
  );
}
export function AppLayout() {
  const { user, signOut } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const viewingSample = useMatch('/demo/*');
  const sampleSearch = viewingSample
    ? location.search
    : '?' +
      new URLSearchParams({
        returnTo: location.pathname + location.search + location.hash,
      }).toString();
  const online = useOnline();
  const [confirmation, setConfirmation] = useState<
    'switch' | 'sign-out' | null
  >(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState('');
  async function leaveSession() {
    if (!online || signingOut) return;
    setSigningOut(true);
    setSignOutError('');
    try {
      await signOut();
    } catch (failure) {
      setSignOutError(
        failure instanceof Error
          ? failure.message
          : 'Unable to sign out. Try again.',
      );
    } finally {
      setSigningOut(false);
    }
  }
  const accountActions = (
    <>
      <button
        className="icon-button"
        title="Switch account"
        aria-label="Switch account"
        aria-haspopup="dialog"
        onClick={() => setConfirmation('switch')}
      >
        <UsersRound size={18} />
      </button>
      <button
        className="icon-button"
        aria-label="Sign out"
        aria-haspopup="dialog"
        disabled={!online || signingOut}
        title={online ? 'Sign out' : 'Reconnect to sign out'}
        onClick={() => {
          setSignOutError('');
          setConfirmation('sign-out');
        }}
      >
        <LogOut size={18} />
      </button>
    </>
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Application navigation">
          <NavLink to="/projects">
            <FolderKanban size={20} />
            Projects
          </NavLink>
          <NavLink to={{ pathname: '/demo', search: sampleSearch }}>
            <Columns3 size={20} />
            Sample board
          </NavLink>
        </nav>
        <div className="sidebar-bottom">
          <div className="profile">
            <Avatar name={user?.displayName ?? null} userId={user?.id} />
            <div>
              <strong>{user?.displayName}</strong>
            </div>
            {accountActions}
          </div>
        </div>
      </aside>
      <div className="app-main">
        <header className="app-header">
          <div className="mobile-brand">
            <Brand />
          </div>
          <Link to="/projects" className="text-link desktop-only">
            Projects
          </Link>
          <ConnectionStatus />
          <ThemeSwitch />
          <NotificationLink />
          <div className="mobile-only mobile-account-actions">
            {accountActions}
          </div>
        </header>
        {confirmation === 'switch' && (
          <Dialog title="Switch account?" onClose={() => setConfirmation(null)}>
            <p>
              You’ll stay signed in as {user?.email} until you sign in to
              another account.
            </p>
            <div className="dialog-actions">
              <button className="button" onClick={() => setConfirmation(null)}>
                Cancel
              </button>
              <button
                className="button primary"
                onClick={() =>
                  navigate('/switch-account', {
                    state: { fromAccountControls: true },
                  })
                }
              >
                Switch account
              </button>
            </div>
          </Dialog>
        )}
        {confirmation === 'sign-out' && (
          <Dialog
            title="Sign out?"
            busy={signingOut}
            onClose={() => setConfirmation(null)}
          >
            <p>Sign out of {user?.email} on this device?</p>
            {signOutError && (
              <p role="alert" className="error-copy">
                {signOutError}
              </p>
            )}
            {!online && <p role="status">Reconnect to sign out.</p>}
            <div className="dialog-actions">
              <button
                className="button"
                disabled={signingOut}
                onClick={() => setConfirmation(null)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                disabled={signingOut || !online}
                onClick={() => void leaveSession()}
              >
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          </Dialog>
        )}
        <Outlet />
      </div>
    </div>
  );
}
