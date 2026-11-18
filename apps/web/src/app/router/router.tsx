import { createBrowserRouter, Link } from 'react-router';
import { AppLayout, PublicLayout, SessionBoundary } from '../layouts/layouts';
import { EntryPage } from '../../pages/entry/page';
import { SignInPage } from '../../pages/auth/page';
import { ProjectsPage } from '../../pages/projects/page';
import { BoardPage } from '../../pages/board/page';

function NotFound() {
  return (
    <main className="empty not-found">
      <span className="error-number">404</span>
      <h1>This page took a different path</h1>
      <p>Let's get you back to something familiar.</p>
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
    ],
  },
  { path: '/sign-in', element: <SignInPage />, errorElement: <RouteError /> },
  {
    element: <SessionBoundary />,
    errorElement: <RouteError />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { path: '/projects', element: <ProjectsPage /> },
          { path: '/projects/:projectId/board', element: <BoardPage /> },
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
