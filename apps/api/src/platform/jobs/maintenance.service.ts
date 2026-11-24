import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Database } from '../database/database.js';
import { FilesService } from '../../modules/files/files.service.js';
import { LocalPrivateStorage } from '../storage/private-storage.js';

@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private active: Promise<void> | undefined;
  private readonly logger = new Logger(MaintenanceService.name);
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(LocalPrivateStorage) private readonly storage: LocalPrivateStorage,
  ) {}
  onModuleInit() {
    if (process.env.BACKGROUND_JOBS === 'false') return;
    const run = () => {
      if (!this.active)
        this.active = this.tick()
          .catch(() => {
            this.logger.error('Maintenance failed; cleanup will retry.');
          })
          .finally(() => {
            this.active = undefined;
          });
    };
    this.timer = setInterval(run, 60000);
    this.timer.unref();
    run();
  }
  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.active;
  }
  async tick() {
    await this.files.cleanup();
    await this.storage.cleanupOrphans(
      async (key) =>
        (
          await this.database.pool.query(
            'SELECT 1 FROM attachments WHERE object_key = $1',
            [key],
          )
        ).rows.length > 0,
    );
    const objects = await this.database.pool.query<{ key: string }>(
      'SELECT object_key AS key FROM object_cleanup WHERE next_attempt_at <= now() LIMIT 100',
    );
    for (const object of objects.rows) {
      try {
        await this.storage.remove(object.key);
        await this.database.pool.query(
          'DELETE FROM object_cleanup WHERE object_key = $1',
          [object.key],
        );
      } catch {
        await this.database.pool.query(
          "UPDATE object_cleanup SET attempts = attempts + 1, next_attempt_at = now() + interval '1 minute' WHERE object_key = $1",
          [object.key],
        );
      }
    }
    await this.database.pool.query(
      "DELETE FROM notifications WHERE created_at < now() - interval '30 days'",
    );
    await this.database.pool.query(
      "DELETE FROM activity WHERE created_at < now() - interval '90 days'",
    );
    await this.database.pool.query(
      'DELETE FROM idempotency_records WHERE expires_at <= now()',
    );
    await this.database.pool.query(
      "DELETE FROM outbox_events WHERE state = 'delivered' AND created_at < now() - interval '7 days'",
    );
    await this.database.pool.query(
      "DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'",
    );
  }
}
