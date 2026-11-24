import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';

const sampleInvitations = [
  { email: 'riley.chen@example.invalid', role: 'Editor' },
  { email: 'maya.patel@example.invalid', role: 'Viewer' },
  { email: 'theo.park@example.invalid', role: 'Editor' },
];

export async function seedSampleInvitations(
  client: pg.PoolClient,
  projectId: string,
) {
  for (const { email, role } of sampleInvitations) {
    await client.query(
      `INSERT INTO invitations(id, project_id, email, role, token_hash, expires_at)
       SELECT $1, p.id, $3, $4, $5, now() + interval '72 hours'
       FROM projects p
       WHERE p.id = $2
         AND NOT EXISTS (SELECT 1 FROM invitations WHERE project_id = p.id AND email = $3)
       ON CONFLICT DO NOTHING`,
      [randomUUID(), projectId, email, role, randomBytes(32).toString('hex')],
    );
  }
}
