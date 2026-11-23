import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ApiError } from '../../shared/api/client';

const scopedQuery =
  (projectId: string) => (query: { queryKey: readonly unknown[] }) =>
    [
      'board',
      'members',
      'invitations',
      'task',
      'project',
      'archived-tasks',
      'comments',
      'activity',
      'attachments',
    ].includes(String(query.queryKey[0])) && query.queryKey[1] === projectId;

export async function refreshProject(client: QueryClient, projectId: string) {
  await Promise.all([
    client.invalidateQueries({ predicate: scopedQuery(projectId) }),
    client.invalidateQueries({ queryKey: ['projects'] }),
    client.invalidateQueries({ queryKey: ['notifications'] }),
  ]);
}

export async function clearProject(client: QueryClient, projectId: string) {
  const predicate = scopedQuery(projectId);
  await client.cancelQueries({ predicate });
  client.removeQueries({ predicate });
  client.removeQueries({ queryKey: ['notifications', 'list'] });
  await client.invalidateQueries({ queryKey: ['projects'] });
}

export function useProjectAccess(projectId: string, error: Error | null) {
  const navigate = useNavigate();
  const client = useQueryClient();
  useEffect(() => {
    if (!(error instanceof ApiError) || error.status !== 404) return;
    void clearProject(client, projectId).then(() =>
      navigate('/projects', {
        replace: true,
        state: {
          notice: 'This project is missing or your access has been removed.',
        },
      }),
    );
  }, [client, error, navigate, projectId]);
}
