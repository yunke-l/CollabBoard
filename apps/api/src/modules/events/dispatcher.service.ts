import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { EventHint } from '@collabboard/contracts';
import { Database } from '../../platform/database/database.js';
import { HINT_TRANSPORT, type HintTransport } from './hint-transport.js';

@Injectable()
export class DispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DispatcherService.name);
  private timer?: ReturnType<typeof setInterval>;
  private active: Promise<void> | undefined;
  private lastWarning = 0;
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(HINT_TRANSPORT) private readonly transport: HintTransport,
  ) {}

  onModuleInit() {
    if (process.env.BACKGROUND_JOBS === 'false') return;
    const run = () => {
      if (!this.active)
        this.active = this.tick()
          .catch(() => {
            this.logger.error(
              'Event delivery is delayed; the next dispatch will retry.',
            );
          })
          .finally(() => {
            this.active = undefined;
          });
    };
    this.timer = setInterval(run, 500);
    this.timer.unref();
    run();
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.active;
  }

  async tick() {
    await this.database.transaction(async (client) => {
      const events = await client.query<{ id: string; projectId: string }>(
        `SELECT event_id AS id, project_id AS "projectId" FROM outbox_events WHERE state = 'pending' AND NOT recipients_initialized ORDER BY created_at, event_id LIMIT 100 FOR UPDATE SKIP LOCKED`,
      );
      for (const event of events.rows) {
        await client.query(
          `INSERT INTO event_deliveries(event_id, recipient_id) SELECT $1, m.user_id FROM project_members m JOIN projects p ON p.id = m.project_id WHERE p.id = $2 AND p.status <> 'expired' AND (p.expires_at IS NULL OR p.expires_at > now()) ON CONFLICT DO NOTHING`,
          [event.id, event.projectId],
        );
        await client.query(
          'UPDATE outbox_events SET recipients_initialized = true WHERE event_id = $1',
          [event.id],
        );
      }
    });
    const lease = randomUUID();
    const deliveries = (
      await this.database.pool.query<{
        eventId: string;
        recipientId: string;
      }>(
        `UPDATE event_deliveries SET lease_until = now() + interval '30 seconds', lease_token = $1, attempts = attempts + 1 WHERE (event_id, recipient_id) IN (SELECT event_id, recipient_id FROM event_deliveries WHERE state = 'pending' AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until <= now()) ORDER BY next_attempt_at LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING event_id AS "eventId", recipient_id AS "recipientId"`,
        [lease],
      )
    ).rows;
    const delivered: { eventId: string; recipientId: string }[] = [];
    for (const row of deliveries) {
      try {
        // Resolve recipients again immediately before publishing, not from the
        // membership snapshot at event creation or the initial fan-out.
        const event = await this.database.pool.query<
          EventHint & { recipientId: string }
        >(
          `SELECT e.event_id AS "eventId", e.event_type AS "eventType", e.project_id AS "projectId", e.entity_id AS "entityId", e.entity_version AS "entityVersion", e.board_revision AS "boardRevision", e.created_at AS "occurredAt" FROM outbox_events e JOIN projects p ON p.id = e.project_id JOIN project_members m ON m.project_id = p.id AND m.user_id = $2 WHERE e.event_id = $1 AND p.status <> 'expired' AND (p.expires_at IS NULL OR p.expires_at > now())`,
          [row.eventId, row.recipientId],
        );
        const hint = event.rows[0];
        if (hint)
          await this.transport.publish(row.recipientId, {
            ...hint,
            occurredAt: new Date(hint.occurredAt).toISOString(),
          });
        delivered.push(row);
      } catch {
        await this.database.pool.query(
          `UPDATE event_deliveries SET first_failure_at = COALESCE(first_failure_at, now()), state = CASE WHEN first_failure_at <= now() - interval '24 hours' THEN 'failed' ELSE 'pending' END, next_attempt_at = now() + LEAST(300, power(2, LEAST(attempts, 8))) * interval '1 second', lease_until = NULL, lease_token = NULL WHERE event_id = $1 AND recipient_id = $2 AND lease_token = $3`,
          [row.eventId, row.recipientId, lease],
        );
      }
    }
    // Commit successful acknowledgements together to avoid one durable disk
    // flush per recipient. A crash before this write causes safe redelivery.
    if (delivered.length)
      await this.database.pool.query(
        `UPDATE event_deliveries d SET state = 'delivered', delivered_at = now(), lease_until = NULL, lease_token = NULL FROM jsonb_to_recordset($1::jsonb) AS r("eventId" uuid, "recipientId" uuid) WHERE d.event_id = r."eventId" AND d.recipient_id = r."recipientId" AND d.lease_token = $2`,
        [JSON.stringify(delivered), lease],
      );
    await this.database.pool.query(
      `UPDATE outbox_events e SET state = CASE WHEN EXISTS (SELECT 1 FROM event_deliveries d WHERE d.event_id = e.event_id AND d.state = 'failed') THEN 'failed' ELSE 'delivered' END WHERE e.state = 'pending' AND recipients_initialized AND NOT EXISTS (SELECT 1 FROM event_deliveries d WHERE d.event_id = e.event_id AND d.state = 'pending')`,
    );
    if (Date.now() - this.lastWarning > 60000) {
      const overdue = await this.database.pool.query(
        `SELECT 1 FROM outbox_events WHERE state = 'failed' OR (state = 'pending' AND created_at < now() - interval '60 seconds') LIMIT 1`,
      );
      if (overdue.rows.length) {
        this.lastWarning = Date.now();
        this.logger.warn(
          'Event delivery needs attention: pending age exceeds 60 seconds or failed deliveries await manual retry.',
        );
      }
    }
  }
}
