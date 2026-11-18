import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { Columns3, FolderKanban, LogOut } from 'lucide-react';
import { Avatar, Brand, ThemeSwitch } from '../../shared/ui/common';
import { useSession } from '../providers/session';

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
        <span>A little more clarity. A lot more progress.</span>
      </footer>
    </>
  );
}
export function SessionBoundary() {
  const { user } = useSession();
  const location = useLocation();
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
            Public sample
          </NavLink>
        </nav>
        <div className="sidebar-bottom">
          <ThemeSwitch />
          <div className="profile">
            <Avatar name={user?.displayName ?? null} />
            <div>
              <strong>{user?.displayName}</strong>
              <small>Local account</small>
            </div>
            <button
              className="icon-button"
              aria-label="Sign out"
              onClick={() => void signOut()}
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
          <span className="badge">Local development</span>
          <div className="mobile-only">
            <ThemeSwitch />
          </div>
          <button
            className="icon-button mobile-only"
            aria-label="Sign out"
            onClick={() => void signOut()}
          >
            <LogOut size={18} />
          </button>
        </header>
        <Outlet />
      </div>
    </div>
  );
}
