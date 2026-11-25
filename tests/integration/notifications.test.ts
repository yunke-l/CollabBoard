import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  sql,
  service,
  notifications,
  owner,
  other,
  createProject,
  createTask,
  joinedProject,
  editInput,
  projectAction,
  taskAction,
  withConcurrentService,
} from './database-fixture';
import { localIdentities } from '../../apps/api/src/adapters/identity/local-identities';

describe('persisted recipient notifications', () => {
  it('notifies a new assignee once and skips self-assignment, unchanged assignment, clearing, and unrelated task actions', async () => {
    const { project } = await joinedProject();
    const input = { ...createTask(), assigneeId: other };
    const created = await service.createTask(owner, project.id, input);
    await service.createTask(owner, project.id, input);
    let task = (
      await service.updateTask(owner, created.task.id, {
        ...editInput(created.task),
        title: 'Renamed task',
      })
    ).task;
    task = (
      await service.updateTask(other, task.id, {
        ...editInput(task),
        assigneeId: null,
      })
    ).task;
    task = (
      await service.updateTask(other, task.id, {
        ...editInput(task),
        assigneeId: other,
      })
    ).task;
    expect(await notifications.summary(other)).toEqual({ unreadCount: 1 });
    task = (
      await service.updateTask(owner, task.id, {
        ...editInput(task),
        assigneeId: null,
      })
    ).task;
    const assign = { ...editInput(task), assigneeId: other };
    task = (await service.updateTask(owner, task.id, assign)).task;
    await service.updateTask(owner, task.id, assign);
    task = (
      await service.setTaskArchived(owner, task.id, true, taskAction(task))
    ).task;
    await service.setTaskArchived(owner, task.id, false, taskAction(task));
    await service.createTask(owner, project.id, {
      ...createTask(),
      assigneeId: owner,
    });
    expect(await notifications.summary(other)).toEqual({ unreadCount: 2 });
    expect(await notifications.summary(owner)).toEqual({ unreadCount: 0 });
    const received = (await notifications.list(other)).items;
    expect(received).toHaveLength(2);
    expect(received[0]!.target).toMatchObject({
      taskId: task.id,
      actorName: localIdentities[0]!.displayName,
      taskTitle: 'Renamed task',
    });
    const sources = await sql.query(
      'SELECT o.event_type FROM notifications n JOIN outbox_events o ON o.event_id = n.source_event_id ORDER BY o.event_type',
    );
    expect(sources.rows.map((row) => row.event_type)).toEqual([
      'task.created',
      'task.updated',
    ]);
  });

  it('rolls back task data, activity, outbox, revision, and idempotency when notification persistence fails', async () => {
    const { project } = await joinedProject();
    const created = await service.createTask(owner, project.id, createTask());
    const before = await service.board(owner, project.id);
    const events = (
      await sql.query('SELECT count(*)::int AS count FROM outbox_events')
    ).rows[0]!.count;
    await sql.query(
      'ALTER TABLE notifications ADD CONSTRAINT reject_notification CHECK (false)',
    );
    try {
      await expect(
        service.createTask(owner, project.id, {
          ...createTask(),
          assigneeId: other,
        }),
      ).rejects.toThrow();
      await expect(
        service.updateTask(owner, created.task.id, {
          ...editInput(created.task),
          assigneeId: other,
        }),
      ).rejects.toThrow();
    } finally {
      await sql.query(
        'ALTER TABLE notifications DROP CONSTRAINT reject_notification',
      );
    }
    expect(await service.board(owner, project.id)).toEqual(before);
    expect(
      (await sql.query('SELECT count(*)::int AS count FROM outbox_events'))
        .rows[0]!.count,
    ).toBe(events);
    expect(
      (await sql.query('SELECT count(*)::int AS count FROM activity')).rows[0]!
        .count,
    ).toBe(events);
    expect(await notifications.summary(other)).toEqual({ unreadCount: 0 });
    expect(
      (
        await sql.query(
          "SELECT count(*)::int AS count FROM idempotency_records WHERE operation LIKE 'update-task:%'",
        )
      ).rows[0]!.count,
    ).toBe(0);
  });

  it('enforces source deduplication and a consistent task/project pair in the database', async () => {
    const { project } = await joinedProject();
    await service.createTask(owner, project.id, {
      ...createTask(),
      assigneeId: other,
    });
    await expect(
      sql.query(
        'INSERT INTO notifications(id, recipient_id, actor_id, project_id, task_id, type, source_event_id) SELECT $1, recipient_id, actor_id, project_id, task_id, type, source_event_id FROM notifications LIMIT 1',
        [randomUUID()],
      ),
    ).rejects.toThrow();
    const separate = await service.create(owner, createProject());
    await expect(
      sql.query(
        'INSERT INTO notifications(id, recipient_id, actor_id, project_id, task_id, type, source_event_id) SELECT $1, recipient_id, actor_id, $2, task_id, type, $3 FROM notifications LIMIT 1',
        [randomUUID(), separate.id, randomUUID()],
      ),
    ).rejects.toThrow();
    expect((await notifications.list(other)).items).toHaveLength(1);
  });

  it('scopes reads and counts to the recipient and hides content after access revocation', async () => {
    const { project } = await joinedProject();
    let task = (
      await service.createTask(owner, project.id, {
        ...createTask(),
        title: 'Private notification task',
        assigneeId: other,
      })
    ).task;
    const item = (await notifications.list(other)).items[0]!;
    expect((await notifications.list(owner)).items).toEqual([]);
    expect(await notifications.summary(owner)).toEqual({ unreadCount: 0 });
    await expect(
      notifications.read(owner, item.id, { requestId: randomUUID() }),
    ).rejects.toMatchObject({ status: 404 });
    await service.changeMember(owner, project.id, other, {
      role: 'Viewer',
      requestId: randomUUID(),
    });
    expect((await notifications.list(other)).items[0]!.target?.taskTitle).toBe(
      'Private notification task',
    );
    task = await service.task(owner, task.id);
    await service.setTaskArchived(owner, task.id, true, taskAction(task));
    expect(
      (await notifications.list(other)).items[0]!.target?.taskArchived,
    ).toBe(true);
    await service.setProjectArchived(
      owner,
      project.id,
      true,
      await projectAction(project.id),
    );
    expect((await notifications.list(other)).items[0]!.target).not.toBeNull();
    await service.leaveProject(other, project.id, { requestId: randomUUID() });
    const redacted = (await notifications.list(other)).items[0]!;
    expect(redacted).toMatchObject({ id: item.id, target: null });
    expect(JSON.stringify(redacted)).not.toContain('Private notification task');
    expect(JSON.stringify(redacted)).not.toContain(project.name);
    expect(JSON.stringify(redacted)).not.toContain(task.id);
    expect(await notifications.summary(other)).toEqual({ unreadCount: 1 });
    await notifications.read(other, item.id, { requestId: randomUUID() });
    expect(await notifications.summary(other)).toEqual({ unreadCount: 0 });
    await expect(service.task(other, task.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('marks individual notifications idempotently without changing read time or another recipient', async () => {
    const { project } = await joinedProject();
    await service.createTask(owner, project.id, {
      ...createTask(),
      assigneeId: other,
    });
    await service.createTask(other, project.id, {
      ...createTask(),
      assigneeId: owner,
    });
    const item = (await notifications.list(other)).items[0]!;
    const request = { requestId: randomUUID() };
    const read = await notifications.read(other, item.id, request);
    expect(await notifications.read(other, item.id, request)).toEqual(read);
    expect(
      await notifications.read(other, item.id, { requestId: randomUUID() }),
    ).toEqual(read);
    expect(await notifications.summary(other)).toEqual({ unreadCount: 0 });
    expect(await notifications.summary(owner)).toEqual({ unreadCount: 1 });
    expect(
      await notifications.readAll(other, { requestId: randomUUID() }),
    ).toMatchObject({ updated: 0 });
    expect(await notifications.summary(owner)).toEqual({ unreadCount: 1 });
  });

  it('keeps read-all retries behind the original operation and excludes future timestamps', async () => {
    const { project } = await joinedProject();
    await service.createTask(owner, project.id, {
      ...createTask(),
      assigneeId: other,
    });
    const input = { requestId: randomUUID() };
    const first = await notifications.readAll(other, input);
    expect(first).toMatchObject({ updated: 1 });
    expect(first.readThrough).toMatch(/^\d{4}-.*\.\d{6}Z$/);
    await service.createTask(owner, project.id, {
      ...createTask(),
      assigneeId: other,
    });
    expect(await notifications.readAll(other, input)).toEqual(first);
    expect(await notifications.summary(other)).toEqual({ unreadCount: 1 });
    const recent = (await notifications.list(other)).items.find(
      (item) => item.readAt === null,
    )!;
    await sql.query(
      "UPDATE notifications SET created_at = now() + interval '1 hour' WHERE id = $1",
      [recent.id],
    );
    expect(
      await notifications.readAll(other, { requestId: randomUUID() }),
    ).toMatchObject({ updated: 0 });
    expect(await notifications.summary(other)).toEqual({ unreadCount: 1 });
  });

  it('paginates equal microsecond timestamps, supports 100-item pages, and scopes cursors to the recipient', async () => {
    const { project } = await joinedProject();
    const { task } = await service.createTask(owner, project.id, createTask());
    const rows = Array.from({ length: 105 }, () => ({
      id: randomUUID(),
      eventId: randomUUID(),
    }));
    await sql.query(
      `INSERT INTO notifications(id, recipient_id, actor_id, project_id, task_id, type, source_event_id, created_at) SELECT item.id, $1, $2, $3, $4, 'task_assigned', item."eventId", date_trunc('day', now()) - interval '1 day' + interval '0.123456 seconds' FROM jsonb_to_recordset($5::jsonb) AS item(id uuid, "eventId" uuid)`,
      [other, owner, project.id, task.id, JSON.stringify(rows)],
    );
    const first = await notifications.list(other);
    expect(first.items).toHaveLength(20);
    await service.createTask(owner, project.id, {
      ...createTask(),
      assigneeId: other,
    });
    const next = await notifications.list(other, first.nextCursor!, 100);
    expect(next.items).toHaveLength(85);
    expect(next.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...next.items].map((item) => item.id)).size,
    ).toBe(105);
    const hundred = await notifications.list(other, undefined, 100);
    expect(hundred.items).toHaveLength(100);
    expect(
      (await notifications.list(other, hundred.nextCursor!, 100)).items,
    ).toHaveLength(6);
    await expect(
      notifications.list(owner, first.nextCursor!),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CURSOR' } });
    await expect(
      notifications.list(other, undefined, 101),
    ).rejects.toMatchObject({ status: 400 });
    await expect(notifications.list(other, 'invalid')).rejects.toMatchObject({
      status: 400,
    });
    await sql.query("UPDATE projects SET status = 'expired' WHERE id = $1", [
      project.id,
    ]);
    expect(
      (await notifications.list(other)).items.every(
        (item) => item.target === null,
      ),
    ).toBe(true);
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'deduplicates concurrent assignment retries',
    async () => {
      const { project } = await joinedProject();
      const input = { ...createTask(), assigneeId: other };
      await withConcurrentService(async (concurrent) => {
        const results = await Promise.all([
          concurrent.createTask(owner, project.id, input),
          concurrent.createTask(owner, project.id, input),
        ]);
        expect(results[0]).toEqual(results[1]);
      });
      expect(await notifications.summary(other)).toEqual({ unreadCount: 1 });
    },
  );

  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'preserves a late commit even when its timestamp precedes the read-all boundary',
    async () => {
      const { project } = await joinedProject();
      const { task } = await service.createTask(owner, project.id, {
        ...createTask(),
        assigneeId: other,
      });
      const writer = new pg.Client({
        connectionString: process.env.DATABASE_URL,
      });
      await writer.connect();
      try {
        await writer.query('BEGIN');
        await writer.query(
          "INSERT INTO notifications(id, recipient_id, actor_id, project_id, task_id, type, source_event_id) VALUES ($1, $2, $3, $4, $5, 'task_assigned', $6)",
          [randomUUID(), other, owner, project.id, task.id, randomUUID()],
        );
        const input = { requestId: randomUUID() };
        await withConcurrentService(
          async (_concurrent, concurrentNotifications) => {
            const result = await concurrentNotifications.readAll(other, input);
            expect(result.updated).toBe(1);
            await writer.query('COMMIT');
            expect(await concurrentNotifications.readAll(other, input)).toEqual(
              result,
            );
            expect(await concurrentNotifications.summary(other)).toEqual({
              unreadCount: 1,
            });
          },
        );
      } finally {
        await writer.query('ROLLBACK');
        await writer.end();
      }
    },
  );
});
