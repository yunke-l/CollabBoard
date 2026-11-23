import { NavLink } from 'react-router';
import { Bell } from 'lucide-react';
import { useNotificationSummary } from './queries';

export function NotificationLink() {
  const query = useNotificationSummary();
  const count = query.data?.unreadCount;
  return (
    <NavLink
      to="/notifications"
      className="notification-link icon-button"
      aria-label="Notifications"
      title={
        query.isError
          ? 'Notifications: unread count unavailable'
          : 'Notifications'
      }
    >
      <Bell size={20} />
      {query.isError ? (
        <span className="unread-badge" aria-label="Unread count unavailable">
          ?
        </span>
      ) : count !== undefined && count > 0 ? (
        <span
          className="unread-badge"
          aria-label={`${count} unread ${count === 1 ? 'notification' : 'notifications'}`}
        >
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </NavLink>
  );
}
