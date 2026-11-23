import { useQuery } from '@tanstack/react-query';
import type { NotificationSummary } from '@collabboard/contracts';
import { useSession } from '../../app/providers/session';
import { api } from '../../shared/api/client';

export function useNotificationSummary() {
  const { user } = useSession();
  return useQuery({
    queryKey: ['notifications', 'unread', user?.id],
    queryFn: ({ signal }) =>
      api<NotificationSummary>('/notifications/unread-count', { signal }),
    enabled: !!user,
    refetchInterval: 30000,
    refetchOnMount: 'always',
    refetchOnReconnect: 'always',
  });
}
