import pg from 'pg';
import { readEnvironment } from '../../config/environment.js';
import { runMigrations } from './run-migrations.js';

const client = new pg.Client({
  connectionString: readEnvironment().databaseUrl,
});
await client.connect();
try {
  await runMigrations(client);
} finally {
  await client.end();
}
