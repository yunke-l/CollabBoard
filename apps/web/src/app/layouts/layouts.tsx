import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { useState } from 'react';
import { Columns3, FolderKanban, LogOut } from 'lucide-react';
import {
  Avatar,
  Brand,
  LoadingState,
  Notice,
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
  const online = useOnline();
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
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Application navigation">
          <NavLink to="/projects">
            <FolderKanban size={20} />
            Projects
          </NavLink>
          <NavLink to="/demo">
            <Columns3 size={20} />
            Sample board
          </NavLink>
        </nav>
        <div className="sidebar-bottom">
          <ThemeSwitch />
          <div className="profile">
            <Avatar name={user?.displayName ?? null} userId={user?.id} />
            <div>
              <strong>{user?.displayName}</strong>
            </div>
            <button
              className="icon-button"
              aria-label="Sign out"
              disabled={!online || signingOut}
              title={online ? 'Sign out' : 'Reconnect to sign out'}
              onClick={() => void leaveSession()}
            >
              <LogOut size={18} />
            </button>
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
          <NotificationLink />
          <div className="mobile-only">
            <ThemeSwitch />
          </div>
          <button
            className="icon-button mobile-only"
            aria-label="Sign out"
            disabled={!online || signingOut}
            title={online ? 'Sign out' : 'Reconnect to sign out'}
            onClick={() => void leaveSession()}
          >
            <LogOut size={18} />
          </button>
        </header>
        {signOutError && (
          <Notice>
            <span role="alert">{signOutError}</span>
          </Notice>
        )}
        <Outlet />
      </div>
    </div>
  );
}
