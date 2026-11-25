import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type EventHint } from '@collabboard/contracts';
import {
  sql,
  service,
  database,
  owner,
  other,
  createProject,
  createTask,
  joinedProject,
} from './database-fixture';
import { DispatcherService } from '../../apps/api/src/modules/events/dispatcher.service';

describe('recipient-aware event delivery', () => {
  it('publishes only identifier hints to current members and acknowledges each recipient once', async () => {
    const { project } = await joinedProject();
    await service.createTask(owner, project.id, createTask());
    const hints: { userId: string; hint: EventHint }[] = [];
    const dispatcher = new DispatcherService(database, {
      async publish(userId, hint) {
        hints.push({ userId, hint });
      },
    });
    await dispatcher.tick();
    expect(new Set(hints.map((item) => item.userId))).toEqual(
      new Set([owner, other]),
    );
    expect(hints).toHaveLength(8);
    expect(Object.keys(hints[0]!.hint).sort()).toEqual(
      [
        'eventId',
        'eventType',
        'projectId',
        'entityId',
        'entityVersion',
        'boardRevision',
        'occurredAt',
      ].sort(),
    );
    expect(
      (
        await sql.query(
          "SELECT 1 FROM event_deliveries WHERE state <> 'delivered'",
        )
      ).rows,
    ).toEqual([]);
    await dispatcher.tick();
    expect(hints).toHaveLength(8);
  });

  it('preserves partial success and retries only failed recipients', async () => {
    await joinedProject();
    const published: { recipientId: string; eventId: string }[] = [];
    let fail = true;
    const dispatcher = new DispatcherService(database, {
      async publish(recipientId, hint) {
        if (fail && recipientId === other)
          throw new Error('Transport unavailable');
        published.push({ recipientId, eventId: hint.eventId });
      },
    });
    await dispatcher.tick();
    expect(new Set(published.map((item) => item.recipientId))).toEqual(
      new Set([owner]),
    );
    const pending = await sql.query(
      'SELECT recipient_id AS "recipientId", event_id AS "eventId" FROM event_deliveries WHERE state = \'pending\'',
    );
    expect(new Set(pending.rows.map((row) => row.recipientId))).toEqual(
      new Set([other]),
    );
    published.length = 0;
    fail = false;
    await sql.query(
      "UPDATE event_deliveries SET next_attempt_at = now() - interval '1 second'",
    );
    await dispatcher.tick();
    expect(published).toHaveLength(pending.rows.length);
    expect(published).toEqual(expect.arrayContaining(pending.rows));
    expect(
      (
        await sql.query(
          "SELECT 1 FROM outbox_events WHERE state <> 'delivered'",
        )
      ).rows,
    ).toEqual([]);
  });

  it('rechecks membership after a failed delivery and preserves failed events for manual retry', async () => {
    const { project } = await joinedProject();
    const attempts: string[] = [];
    const dispatcher = new DispatcherService(database, {
      async publish(userId) {
        attempts.push(userId);
        if (userId === other) throw new Error('Unavailable');
      },
    });
    await dispatcher.tick();
    expect(attempts).toContain(other);
    attempts.length = 0;
    await service.changeMember(owner, project.id, other, {
      requestId: randomUUID(),
    });
    await sql.query(
      "UPDATE event_deliveries SET next_attempt_at = now() - interval '1 second'",
    );
    await dispatcher.tick();
    expect(attempts).toContain(owner);
    expect(attempts).not.toContain(other);
    expect(
      (
        await sql.query(
          "SELECT 1 FROM event_deliveries WHERE recipient_id = $1 AND state = 'pending'",
          [other],
        )
      ).rows,
    ).toEqual([]);
    const failing = new DispatcherService(database, {
      async publish() {
        throw new Error('Unavailable');
      },
    });
    await service.createTask(owner, project.id, createTask());
    await failing.tick();
    await sql.query(
      "UPDATE event_deliveries SET first_failure_at = now() - interval '25 hours', next_attempt_at = now() - interval '1 second' WHERE state = 'pending'",
    );
    await failing.tick();
    expect(
      (await sql.query("SELECT 1 FROM event_deliveries WHERE state = 'failed'"))
        .rows.length,
    ).toBeGreaterThan(0);
    expect(
      (await sql.query("SELECT 1 FROM outbox_events WHERE state = 'failed'"))
        .rows.length,
    ).toBeGreaterThan(0);
  });

  it('recovers an expired lease and leaves an active lease to its current worker', async () => {
    await service.create(owner, createProject());
    const dispatcher = new DispatcherService(database, {
      async publish() {
        throw new Error('Retry later');
      },
    });
    await dispatcher.tick();
    await sql.query(
      "UPDATE event_deliveries SET next_attempt_at = now() - interval '1 second', lease_until = now() + interval '30 seconds', lease_token = $1",
      [randomUUID()],
    );
    let calls = 0;
    const recovered = new DispatcherService(database, {
      async publish() {
        calls++;
      },
    });
    await recovered.tick();
    expect(calls).toBe(0);
    await sql.query(
      "UPDATE event_deliveries SET lease_until = now() - interval '1 second'",
    );
    await recovered.tick();
    expect(calls).toBe(1);
  });
});
