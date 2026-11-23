import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  pagination,
  type AssignmentNotification,
} from '@collabboard/contracts';
import { Database } from '../../platform/database/database.js';
import { idempotent } from '../../platform/database/idempotency.js';
import { readPage, nextCursor } from '../../platform/http/pagination.js';

@Injectable()
export class NotificationsService {
  constructor(@Inject(Database) private readonly database: Database) {}

  async list(
    userId: string,
    cursor?: string,
    limit: number = pagination.defaultLimit,
  ) {
    const scope = `notifications:${userId}`;
    const { boundary } = readPage(cursor, limit, scope);
    // Resolve content through current membership in the same SQL snapshot.
    // No task/project titles are copied into notifications or idempotency results.
    const result = await this.database.pool.query<
      Omit<AssignmentNotification, 'createdAt' | 'readAt'> & {
        createdAt: Date;
        readAt: Date | null;
      }
    >(
      `SELECT n.id, n.type, n.created_at AS "createdAt", n.read_at AS "readAt", CASE WHEN m.user_id IS NOT NULL AND p.status <> 'expired' AND (p.expires_at IS NULL OR p.expires_at > now()) THEN json_build_object('projectId', p.id, 'taskId', t.id, 'projectName', p.name, 'taskTitle', t.title, 'actorName', u.display_name, 'taskArchived', t.archived_at IS NOT NULL) ELSE NULL END AS target FROM notifications n JOIN projects p ON p.id = n.project_id JOIN tasks t ON t.project_id = n.project_id AND t.id = n.task_id JOIN users u ON u.id = n.actor_id LEFT JOIN project_members m ON m.project_id = n.project_id AND m.user_id = $1 WHERE n.recipient_id = $1 AND ($2::timestamptz IS NULL OR (date_trunc('milliseconds', n.created_at), n.id) < ($2::timestamptz, $3::uuid)) ORDER BY date_trunc('milliseconds', n.created_at) DESC, n.id DESC LIMIT $4`,
      [userId, boundary?.at ?? null, boundary?.id ?? null, limit + 1],
    );
    const items: AssignmentNotification[] = result.rows
      .slice(0, limit)
      .map((row) => ({
        ...row,
        createdAt: new Date(row.createdAt).toISOString(),
        readAt: row.readAt ? new Date(row.readAt).toISOString() : null,
      }));
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        result.rows.length > limit && last
          ? nextCursor(scope, last.createdAt, last.id)
          : null,
    };
  }

  async summary(userId: string) {
    const result = await this.database.pool.query<{ unreadCount: number }>(
      'SELECT count(*)::int AS "unreadCount" FROM notifications WHERE recipient_id = $1 AND read_at IS NULL',
      [userId],
    );
    return result.rows[0]!;
  }

  async read(
    userId: string,
    notificationId: string,
    input: { requestId: string },
  ) {
    return this.database.transaction((client) =>
      idempotent(
        client,
        userId,
        `notification-read:${notificationId}`,
        input,
        async () => {
          const result = await client.query<{ id: string; readAt: Date }>(
            'UPDATE notifications SET read_at = COALESCE(read_at, clock_timestamp()) WHERE id = $1 AND recipient_id = $2 RETURNING id, read_at AS "readAt"',
            [notificationId, userId],
          );
          const row = result.rows[0];
          if (!row) throw new NotFoundException('Notification not found.');
          return { id: row.id, readAt: new Date(row.readAt).toISOString() };
        },
      ),
    );
  }

  async readAll(userId: string, input: { requestId: string }) {
    return this.database.transaction((client) =>
      idempotent(client, userId, 'notifications-read-all', input, async () => {
        // Preserve PostgreSQL microseconds so a committed notification in this
        // millisecond is included rather than lost to JavaScript Date truncation.
        const time = await client.query<{ at: string }>(
          `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
        );
        const at = time.rows[0]!.at;
        const result = await client.query<{ updated: number }>(
          'WITH updated AS (UPDATE notifications SET read_at = $2 WHERE recipient_id = $1 AND read_at IS NULL AND created_at <= $2 RETURNING id) SELECT count(*)::int AS updated FROM updated',
          [userId, at],
        );
        return { updated: result.rows[0]!.updated, readThrough: at };
      }),
    );
  }
}
