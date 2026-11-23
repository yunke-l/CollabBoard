import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export async function recordChange(
  client: pg.PoolClient,
  change: {
    actorId: string;
    projectId: string;
    taskId: string | null;
    entityId: string;
    action: string;
    version: number;
    revision: number;
    summary?: Record<string, unknown>;
  },
) {
  const eventId = randomUUID();
  await client.query(
    'INSERT INTO activity (id, project_id, task_id, actor_id, action, change_summary) VALUES ($1, $2, $3, $4, $5, $6)',
    [
      randomUUID(),
      change.projectId,
      change.taskId,
      change.actorId,
      change.action,
      JSON.stringify(change.summary ?? {}),
    ],
  );
  await client.query(
    'INSERT INTO outbox_events (event_id, project_id, entity_id, event_type, entity_version, board_revision) VALUES ($1, $2, $3, $4, $5, $6)',
    [
      eventId,
      change.projectId,
      change.entityId,
      change.action,
      change.version,
      change.revision,
    ],
  );
  return eventId;
}
