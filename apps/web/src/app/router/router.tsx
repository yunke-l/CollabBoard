import { createBrowserRouter, Link } from 'react-router';
import { AppLayout, PublicLayout, SessionBoundary } from '../layouts/layouts';
import { EntryPage } from '../../pages/entry/page';
import { SignInPage } from '../../pages/auth/page';
import { AccountFlow } from '../../pages/auth/account-flow';
import { ProjectsPage } from '../../pages/projects/page';
import { BoardPage } from '../../pages/board/page';
import { MembersPage } from '../../pages/members/page';
import { InvitationPage } from '../../pages/invitation/page';
import { SettingsPage } from '../../pages/settings/page';
import { ArchivedTasksPage } from '../../pages/archived-tasks/page';
import { NotificationsPage } from '../../pages/notifications/page';
import { ActivityPage } from '../../pages/activity/page';

function NotFound() {
  return (
    <main className="empty not-found">
      <span className="error-number">404</span>
      <h1>Page not found</h1>
      <Link className="button primary" to="/">
        Back to home
      </Link>
    </main>
  );
}
function RouteError() {
  return (
    <main className="empty" role="alert">
      <h1>Something went wrong</h1>
      <p>Reload the page to start again.</p>
      <a className="button primary" href="/">
        Back to home
      </a>
    </main>
  );
}
export const router = createBrowserRouter([
  {
    element: <PublicLayout />,
    errorElement: <RouteError />,
    children: [
      { path: '/', element: <EntryPage /> },
      { path: '/demo', element: <BoardPage sample /> },
      { path: '/demo/tasks/:taskId', element: <BoardPage sample /> },
      { path: '/invite', element: <InvitationPage /> },
    ],
  },
  { path: '/sign-in', element: <SignInPage />, errorElement: <RouteError /> },
  {
    path: '/sign-up',
    element: <AccountFlow key="sign-up" kind="sign-up" />,
    errorElement: <RouteError />,
  },
  {
    path: '/verify-email',
    element: <AccountFlow key="verify" kind="verify" />,
    errorElement: <RouteError />,
  },
  {
    path: '/recover-password',
    element: <AccountFlow key="recover" kind="recover" />,
    errorElement: <RouteError />,
  },
  {
    element: <SessionBoundary />,
    errorElement: <RouteError />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { path: '/projects', element: <ProjectsPage /> },
          { path: '/notifications', element: <NotificationsPage /> },
          { path: '/projects/:projectId/board', element: <BoardPage /> },
          { path: '/projects/:projectId/members', element: <MembersPage /> },
          { path: '/projects/:projectId/activity', element: <ActivityPage /> },
          { path: '/projects/:projectId/settings', element: <SettingsPage /> },
          {
            path: '/projects/:projectId/archived-tasks',
            element: <ArchivedTasksPage />,
          },
          {
            path: '/projects/:projectId/tasks/:taskId',
            element: <BoardPage />,
          },
        ],
      },
    ],
  },
  { path: '*', element: <NotFound /> },
]);
