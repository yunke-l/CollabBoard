import pg from 'pg';
import { localIdentities } from '../../adapters/identity/local-identities.js';
import { readEnvironment } from '../../config/environment.js';

const pool = new pg.Pool({ connectionString: readEnvironment().databaseUrl });
try {
  for (const user of localIdentities) {
    await pool.query(
      'INSERT INTO users (id, identity_subject, email, display_name) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
      [user.id, `local:${user.id}`, user.email, user.displayName],
    );
  }
  console.info(
    'Seeded two synthetic local identities. No passwords or shared project access were created.',
  );
} finally {
  await pool.end();
}
