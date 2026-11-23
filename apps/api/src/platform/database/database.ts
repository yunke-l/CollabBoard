import { Injectable, BeforeApplicationShutdown } from '@nestjs/common';
import pg from 'pg';
import { readEnvironment } from '../../config/environment.js';

@Injectable()
export class Database implements BeforeApplicationShutdown {
  readonly pool = new pg.Pool({
    connectionString: readEnvironment().databaseUrl,
    connectionTimeoutMillis: 3000,
    max: 10,
  });

  async transaction<T>(
    work: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async beforeApplicationShutdown() {
    await this.pool.end();
  }
}
