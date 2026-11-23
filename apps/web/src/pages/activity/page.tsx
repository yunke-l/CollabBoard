import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { Project } from '@collabboard/contracts';
import { useSession } from '../../app/providers/session';
import { api } from '../../shared/api/client';
import { ErrorState, LoadingState } from '../../shared/ui/common';
import { useProjectAccess } from '../../features/projects/use-project-access';
import { ActivityFeed } from '../../features/activity/activity-feed';

export function ActivityPage() {
  const { projectId = '' } = useParams();
  const { user } = useSession();
  const query = useQuery({
    queryKey: ['project', projectId, user?.id],
    queryFn: ({ signal }) => api<Project>(`/projects/${projectId}`, { signal }),
    refetchInterval: 30000,
  });
  useProjectAccess(projectId, query.error);
  return (
    <main className="content activity-content">
      <Link className="back-link" to={`/projects/${projectId}/board`}>
        ← Back to board
      </Link>
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <div className="page-heading">
            <div>
              <h1>Project activity</h1>
              <p>{query.data.name}</p>
            </div>
          </div>
          <ActivityFeed projectId={projectId} />
        </>
      )}
    </main>
  );
}
