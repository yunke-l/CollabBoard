import { useEffect } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import type { CursorPage, Invitation } from '@collabboard/contracts';
import { useSession } from '../../app/providers/session';
import { api, ApiError } from '../../shared/api/client';
import { ErrorState, LoadingState } from '../../shared/ui/common';
import { useProjectAccess } from './use-project-access';

export function PendingInvitations({
  projectId,
  canManage,
  onRevoke,
}: {
  projectId: string;
  canManage: boolean;
  onRevoke: (invitation: Invitation) => void;
}) {
  const { user } = useSession();
  const client = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: ['invitations', projectId, user?.id],
    queryFn: ({ signal, pageParam }) =>
      api<CursorPage<Invitation>>(
        `/projects/${projectId}/invitations${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: 30000,
    refetchOnMount: 'always',
  });
  useProjectAccess(projectId, query.error);
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 403)
      void client.invalidateQueries({ queryKey: ['members', projectId] });
  }, [client, projectId, query.error]);
  const invitations = [
    ...new Map(
      query.data?.pages
        .flatMap((page) => page.items)
        .map((item) => [item.id, item]),
    ).values(),
  ];
  const retry = () => {
    if (query.isFetchNextPageError) void query.fetchNextPage();
    else void query.refetch();
  };
  return (
    <section className="task-section">
      <h2>Pending invitations</h2>
      {query.isPending ? (
        <LoadingState />
      ) : query.isError &&
        (!query.data ||
          (query.error instanceof ApiError &&
            [401, 403, 404].includes(query.error.status))) ? (
        <ErrorState error={query.error} retry={retry} />
      ) : (
        <>
          {query.isError && <ErrorState error={query.error} retry={retry} />}
          {invitations.length ? (
            invitations.map((invitation) => (
              <article className="member-row" key={invitation.id}>
                <Users size={20} />
                <div className="grow">
                  <strong>{invitation.email}</strong>
                  <small>
                    {invitation.role} · Expires{' '}
                    {new Date(invitation.expiresAt).toLocaleString('en')}
                  </small>
                </div>
                {canManage && (
                  <button
                    className="button"
                    onClick={() => onRevoke(invitation)}
                  >
                    Revoke
                  </button>
                )}
              </article>
            ))
          ) : !query.isError ? (
            <p>No pending invitations.</p>
          ) : null}
          {query.hasNextPage && (
            <div className="dialog-actions">
              <button
                className="button"
                disabled={query.isFetching}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage
                  ? 'Loading…'
                  : 'Load more invitations'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
