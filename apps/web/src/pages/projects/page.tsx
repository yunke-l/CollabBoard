import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { FolderKanban, Layers, Plus } from 'lucide-react';
import type { CursorPage, Project } from '@collabboard/contracts';
import { api } from '../../shared/api/client';
import { ErrorState, LoadingState } from '../../shared/ui/common';
import { useSession } from '../../app/providers/session';
import { CreateProjectDialog } from '../../features/projects/create-project-dialog';

export function ProjectsPage() {
  const { user } = useSession();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: ['projects', user?.id],
    queryFn: ({ signal }) => api<CursorPage<Project>>('/projects', { signal }),
  });
  const projects =
    query.data?.items.filter((project) => project.status === tab) ?? [];
  return (
    <main className="content">
      <div className="page-heading">
        <div>
          <h1>Your projects</h1>
          <p>A clear view of the work you're doing together.</p>
        </div>
        <button className="button primary" onClick={() => setCreating(true)}>
          <Plus size={18} />
          New project
        </button>
      </div>
      <div className="tabs" role="group" aria-label="Project status">
        {(['active', 'archived'] as const).map((value) => (
          <button
            aria-pressed={tab === value}
            key={value}
            onClick={() => setTab(value)}
          >
            {value === 'active' ? 'Active' : 'Archived'}
            <span>
              {query.data?.items.filter((project) => project.status === value)
                .length ?? 0}
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
            {tab === 'active'
              ? 'A fresh start for your next project'
              : 'No archived projects'}
          </h2>
          <p>
            {tab === 'active'
              ? 'Create a project, add your first task, and give your work a home.'
              : 'Archived projects will appear here.'}
          </p>
          {tab === 'active' && (
            <button
              className="button primary"
              onClick={() => setCreating(true)}
            >
              <Plus size={16} />
              Create your first project
            </button>
          )}
          <Link to="/demo" className="text-link">
            Explore a sample project
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
              <p>
                {project.description ||
                  'A new space to make progress together.'}
              </p>
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
      {creating && (
        <CreateProjectDialog
          onClose={() => setCreating(false)}
          onCreated={(project) => navigate(`/projects/${project.id}/board`)}
        />
      )}
    </main>
  );
}
