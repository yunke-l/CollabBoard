import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  Link,
  Outlet,
  useMatch,
  useLocation,
  useOutletContext,
  useParams,
} from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Archive,
  Columns3,
  Layers,
  Plus,
  Settings,
  Users,
} from 'lucide-react';
import {
  projectCapabilities,
  type SampleBoardSnapshot,
  type MemberSnapshot,
  type Project,
  type TaskStatus,
  type Task,
} from '@collabboard/contracts';
import { api, ApiError } from '../../shared/api/client';
import {
  Avatar,
  ErrorState,
  LoadingState,
  Notice,
} from '../../shared/ui/common';
import { useOnline } from '../../shared/lib/use-online';
import { useSession } from '../providers/session';
import { CreateTaskDialog } from '../../features/tasks/create-task-dialog';
import { useProjectAccess } from '../../features/projects/use-project-access';

const tabs = [
  { path: 'board', label: 'Board', icon: Columns3 },
  { path: 'members', label: 'Members', icon: Users },
  { path: 'archived-tasks', label: 'Archived tasks', icon: Archive },
  { path: 'activity', label: 'Activity', icon: Activity },
  { path: 'settings', label: 'Settings', icon: Settings },
];

export function ProjectLayout({ sample = false }: { sample?: boolean }) {
  const { projectId } = useParams();
  const { user } = useSession();
  const query = useQuery<Project | SampleBoardSnapshot>({
    queryKey: sample
      ? ['board', 'sample', user?.id]
      : ['project', projectId, user?.id],
    queryFn: ({ signal }) =>
      sample
        ? api<SampleBoardSnapshot>('/demo', { signal })
        : api<Project>(`/projects/${projectId}`, { signal }),
    refetchInterval: sample ? false : 30000,
  });
  const section = useMatch('/projects/:projectId/:section/*')?.params.section;
  const previousSection = useRef(section);
  const { refetch } = query;
  useEffect(() => {
    if (previousSection.current !== section && !sample) void refetch();
    previousSection.current = section;
  }, [section, sample, refetch]);
  useProjectAccess(projectId ?? '', sample ? null : query.error);
  if (
    !query.data ||
    (query.error instanceof ApiError &&
      [401, 403, 404].includes(query.error.status))
  )
    return (
      <main className="content">
        {query.isPending ? (
          <LoadingState />
        ) : (
          <ErrorState
            error={query.error ?? new Error('Unable to load the project.')}
            retry={() => void query.refetch()}
          />
        )}
      </main>
    );
  const project = 'project' in query.data ? query.data.project : query.data;
  return (
    <ProjectWorkspace
      key={project.id}
      project={project}
      sampleBoard={'project' in query.data ? query.data : null}
    />
  );
}

type ProjectControls = {
  sampleBoard: SampleBoardSnapshot | null;
  sampleTasks: Task[] | null;
  setSampleTasks: Dispatch<SetStateAction<Task[] | null>>;
  openCreate: (status: TaskStatus) => void;
  moving: boolean;
  setMoving: Dispatch<SetStateAction<boolean>>;
};
export const useProjectControls = () => useOutletContext<ProjectControls>();

function ProjectWorkspace({
  project,
  sampleBoard,
}: {
  project: Project;
  sampleBoard: SampleBoardSnapshot | null;
}) {
  const sample = !!sampleBoard;
  const sampleActivity = !!useMatch('/demo/activity');
  const { user } = useSession();
  const location = useLocation();
  const returnTo = new URLSearchParams(location.search).get('returnTo') ?? '';
  const workspaceUrl = /^\/(projects|notifications)(?:[/?#]|$)/.test(returnTo)
    ? returnTo
    : '/projects';
  const online = useOnline();
  const [creating, setCreating] = useState<TaskStatus | null>(null);
  const [sampleTasks, setSampleTasks] = useState<Task[] | null>(null);
  const [moving, setMoving] = useState(false);
  const section = useMatch('/projects/:projectId/:section/*')?.params.section;
  const activeTab = section === 'tasks' ? 'board' : section;
  const members = useQuery({
    queryKey: ['members', project.id, user?.id],
    queryFn: ({ signal }) =>
      api<MemberSnapshot>(`/projects/${project.id}/members`, { signal }),
    enabled: !!creating && !sample,
  });
  const canCreate =
    !sample &&
    projectCapabilities(project.role, project.status, false, online)
      .canCreateTask;
  return (
    <main className={`content board-content ${sample ? 'sample-content' : ''}`}>
      {!sample && !online && (
        <Notice>
          You are offline. New changes are paused until your connection returns.
        </Notice>
      )}
      {!sample && project.status !== 'active' && (
        <Notice>
          This project is archived and read only.{' '}
          {project.role === 'Owner' && (
            <Link className="text-link" to={`/projects/${project.id}/settings`}>
              Open project settings to restore it
            </Link>
          )}
        </Notice>
      )}
      {sample && user && (
        <Link className="text-link" to={workspaceUrl}>
          ← Back to workspace
        </Link>
      )}
      <div className="page-heading project-heading">
        <span className="project-symbol">
          <Layers size={24} />
        </span>
        <div className="grow">
          <div className="title-row">
            <h1>{project.name}</h1>
            <span className="badge">
              {sample ? 'Interactive sample' : project.role}
            </span>
          </div>
          {sample ? (
            <p>
              Explore and move the sample tasks. Refresh to reset the board.
            </p>
          ) : (
            project.description && <p>{project.description}</p>
          )}
        </div>
        {sample && (
          <div className="avatar-group">
            <Avatar name="Alex Morgan" />
            <Avatar name="Jamie Lee" />
            <Avatar name="Sam Kim" />
          </div>
        )}
        {canCreate && (
          <button
            className="button primary"
            onClick={() => setCreating('todo')}
            disabled={moving}
          >
            <Plus size={18} />
            New task
          </button>
        )}
      </div>
      <nav className="project-tabs" aria-label="Project navigation">
        {sample ? (
          <>
            <Link
              to={{ pathname: '/demo', search: location.search }}
              aria-current={!sampleActivity ? 'page' : undefined}
            >
              <Columns3 size={17} />
              Board
            </Link>
            <Link
              to={{ pathname: '/demo/activity', search: location.search }}
              aria-current={sampleActivity ? 'page' : undefined}
            >
              <Activity size={17} />
              Activity
            </Link>
          </>
        ) : (
          tabs
            .filter(
              (tab) => tab.path !== 'settings' || project.role === 'Owner',
            )
            .map(({ path, label, icon: Icon }) => (
              <Link
                key={path}
                to={`/projects/${project.id}/${path}`}
                aria-current={path === activeTab ? 'page' : undefined}
              >
                <Icon size={17} aria-hidden="true" />
                {label}
              </Link>
            ))
        )}
      </nav>
      <Outlet
        context={
          {
            sampleBoard,
            sampleTasks,
            setSampleTasks,
            openCreate: setCreating,
            moving,
            setMoving,
          } satisfies ProjectControls
        }
      />
      {creating && (
        <CreateTaskDialog
          status={creating}
          projectId={project.id}
          members={members.data?.members}
          membersFailed={members.isError}
          canWrite={canCreate}
          onClose={() => setCreating(null)}
        />
      )}
    </main>
  );
}
