import type { QueryClient, QueryFilters } from '@tanstack/react-query';

export async function refreshFromHint(client: QueryClient, projectId?: string) {
  const affected: QueryFilters['predicate'] = ({ queryKey }) =>
    !projectId ||
    queryKey[1] === projectId ||
    ['projects', 'notifications'].includes(String(queryKey[0]));

  // invalidateQueries reuses the initial request while there is no cached data.
  // That request may have read its snapshot before the event was committed.
  await client.cancelQueries({
    type: 'active',
    fetchStatus: 'fetching',
    predicate: (query) => query.state.data === undefined && affected(query),
  });
  await client.invalidateQueries({ predicate: affected });
}
