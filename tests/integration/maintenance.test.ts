import { randomUUID } from 'node:crypto';
import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  sql,
  service,
  notifications,
  database,
  files,
  storage,
  storageRoot,
  owner,
  other,
  createTask,
  joinedProject,
  readyFile,
} from './database-fixture';
import { consumeRate } from '../../apps/api/src/platform/http/rate-limit';
import { MaintenanceService } from '../../apps/api/src/platform/jobs/maintenance.service';

describe('scheduled maintenance', () => {
  it('removes expired history and queued or orphaned files while retaining ready files and failed events', async () => {
    const { project } = await joinedProject();
    const firstInput = { ...createTask(), assigneeId: other };
    const { task } = await service.createTask(owner, project.id, firstInput);
    await service.createTask(owner, project.id, {
      ...createTask(),
      assigneeId: other,
    });
    const kept = await readyFile(owner, task.id, 'kept.txt');
    const deleted = await readyFile(owner, task.id, 'deleted.txt');
    const key = async (id: string) =>
      String(
        (
          await sql.query('SELECT object_key FROM attachments WHERE id = $1', [
            id,
          ])
        ).rows[0]!.object_key,
      );
    const keptKey = await key(kept.id);
    const deletedKey = await key(deleted.id);
    await files.delete(owner, deleted.id, { requestId: randomUUID() });
    const orphanKey = `${randomUUID()}/${randomUUID()}/${randomUUID()}`;
    const queuedKey = `${randomUUID()}/${randomUUID()}/${randomUUID()}`;
    await storage.put(orphanKey, Buffer.from('orphan'));
    await storage.put(queuedKey, Buffer.from('queued'));
    const old = new Date(Date.now() - 16 * 60000);
    await utimes(join(storageRoot, orphanKey), old, old);
    await utimes(join(storageRoot, keptKey), old, old);
    await sql.query('INSERT INTO object_cleanup(object_key) VALUES ($1)', [
      queuedKey,
    ]);
    await sql.query(
      "UPDATE notifications SET created_at = now() - interval '31 days' WHERE task_id = $1",
      [task.id],
    );
    await sql.query(
      "UPDATE activity SET created_at = now() - interval '91 days'",
    );
    await sql.query(
      'UPDATE activity SET created_at = now() WHERE id = (SELECT id FROM activity LIMIT 1)',
    );
    await sql.query(
      "UPDATE outbox_events SET state = 'delivered', created_at = now() - interval '8 days'",
    );
    await sql.query(
      "UPDATE outbox_events SET state = 'failed' WHERE event_id = (SELECT event_id FROM outbox_events LIMIT 1)",
    );
    await sql.query(
      "UPDATE idempotency_records SET expires_at = now() - interval '1 second' WHERE request_id = $1",
      [firstInput.requestId],
    );
    await consumeRate(database, owner, [{ name: 'current', limit: 60 }]);
    await sql.query(
      "INSERT INTO rate_limits(subject,bucket,window_start,used) VALUES ($1,'old',now() - interval '3 days',1)",
      [owner],
    );

    const maintenance = new MaintenanceService(database, files, storage);
    await maintenance.tick();
    await maintenance.tick();
    expect((await storage.get(keptKey)).toString()).toBe('Hello');
    for (const removed of [deletedKey, orphanKey, queuedKey])
      await expect(storage.get(removed)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    expect((await sql.query('SELECT 1 FROM object_cleanup')).rows).toEqual([]);
    expect((await notifications.list(other)).items).toHaveLength(1);
    expect((await sql.query('SELECT 1 FROM activity')).rows).toHaveLength(1);
    expect((await sql.query('SELECT state FROM outbox_events')).rows).toEqual([
      { state: 'failed' },
    ]);
    expect(
      (
        await sql.query(
          'SELECT 1 FROM idempotency_records WHERE request_id = $1',
          [firstInput.requestId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (await sql.query('SELECT 1 FROM idempotency_records')).rows.length,
    ).toBeGreaterThan(0);
    expect((await sql.query('SELECT bucket FROM rate_limits')).rows).toEqual([
      { bucket: 'current' },
    ]);
    expect(
      (await files.list(owner, task.id)).items.map((item) => item.id),
    ).toEqual([kept.id]);
  });
});
