import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { readEnvironment } from '../../config/environment.js';

const pool = new pg.Pool({ connectionString: readEnvironment().databaseUrl });
const client = await pool.connect();
try {
  await client.query(
    "SELECT pg_advisory_lock(hashtext('collabboard:migrations'))",
  );
  await client.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const directory = new URL('../../../migrations/', import.meta.url);
  for (const name of (await readdir(directory))
    .filter((file) => file.endsWith('.sql'))
    .sort()) {
    const sql = await readFile(new URL(name, directory), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query(
      'SELECT checksum FROM schema_migrations WHERE name = $1',
      [name],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== checksum)
        throw new Error(
          `Applied migration changed: ${name}. Add a new migration instead.`,
        );
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)',
        [name, checksum],
      );
      await client.query('COMMIT');
      console.info(`Applied ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.query(
    "SELECT pg_advisory_unlock(hashtext('collabboard:migrations'))",
  );
  client.release();
  await pool.end();
}
