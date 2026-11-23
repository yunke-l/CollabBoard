import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { FolderKanban, Layers, Plus } from 'lucide-react';
import type { CursorPage, Project } from '@collabboard/contracts';
import { api } from '../../shared/api/client';
import { ErrorState, LoadingState, Notice } from '../../shared/ui/common';
import { useSession } from '../../app/providers/session';
import { TrialControls } from '../../features/trials/trial-controls';
import { CreateProjectDialog } from '../../features/projects/create-project-dialog';

export function ProjectsPage() {
  const { user } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [creating, setCreating] = useState(false);
  const query = useInfiniteQuery({
    queryKey: ['projects', user?.id],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      api<CursorPage<Project>>(
        `/projects${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor,
  });
  const allProjects = query.data?.pages.flatMap((page) => page.items) ?? [];
  const projects = allProjects.filter((project) => project.status === tab);
  return (
    <main className="content">
      {location.state?.notice && <Notice>{location.state.notice}</Notice>}
      <div className="page-heading">
        <div>
          <h1>Your projects</h1>
        </div>
        <button className="button primary" onClick={() => setCreating(true)}>
          <Plus size={18} />
          New project
        </button>
      </div>
      <TrialControls />
      <div className="tabs" role="group" aria-label="Project status">
        {(['active', 'archived'] as const).map((value) => (
          <button
            aria-pressed={tab === value}
            key={value}
            onClick={() => setTab(value)}
          >
            {value === 'active' ? 'Active' : 'Archived'}
            <span>
              {allProjects.filter((project) => project.status === value).length}
              {query.hasNextPage ? '+' : ''}
            </span>
          </button>
        ))}
      </div>
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : projects.length === 0 ? (
        <div className="empty">
          <FolderKanban size={32} />
          <h2>
            {query.hasNextPage
              ? `No ${tab} projects in the loaded results`
              : tab === 'active'
                ? 'No active projects'
                : 'No archived projects'}
          </h2>
          {query.hasNextPage && (
            <p>Load more projects to check the next page.</p>
          )}
          {tab === 'active' && !query.hasNextPage && (
            <button
              className="button primary"
              onClick={() => setCreating(true)}
            >
              <Plus size={16} />
              Create project
            </button>
          )}
          <Link to="/demo" className="text-link">
            View sample board
          </Link>
        </div>
      ) : (
        <div className="project-grid">
          {projects.map((project) => (
            <Link
              key={project.id}
              to={`/projects/${project.id}/board`}
              className="project-card"
            >
              <div className="card-top">
                <span className="project-symbol">
                  <Layers size={22} />
                </span>
                <span className="badge">{project.role}</span>
              </div>
              <h2>{project.name}</h2>
              {project.isTrial && (
                <small className="badge">
                  Trial · expires{' '}
                  {new Date(project.expiresAt!).toLocaleDateString('en')}
                </small>
              )}
              {project.description && <p>{project.description}</p>}
              <div className="project-card-footer">
                {project.status === 'active' ? 'Open board' : 'View project'}
                <span>
                  {new Date(project.createdAt).toLocaleDateString('en', {
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
      {query.hasNextPage && (
        <div className="dialog-actions">
          <button
            className="button"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Load more projects'}
          </button>
        </div>
      )}
      {creating && (
        <CreateProjectDialog
          onClose={() => setCreating(false)}
          onCreated={(project) => navigate(`/projects/${project.id}/board`)}
        />
      )}
    </main>
  );
}
