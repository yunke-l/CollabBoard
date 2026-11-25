import { randomBytes } from 'node:crypto';
import pg from 'pg';

// Every connection in a suite (including service pools and lock probes) must
// see the same tables, even while other Vitest workers reset their fixtures.
export async function createTestSchema(connectionString: string) {
  const name = 'suite_' + randomBytes(12).toString('hex');
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA "${name}"`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  const url = new URL(connectionString);
  url.searchParams.set(
    'options',
    [url.searchParams.get('options'), '-c search_path=' + name]
      .filter(Boolean)
      .join(' '),
  );
  url.searchParams.set('application_name', name);
  return {
    url: url.href,
    async close() {
      try {
        await admin.query(`DROP SCHEMA "${name}" CASCADE`);
      } finally {
        await admin.end();
      }
    },
  };
}
