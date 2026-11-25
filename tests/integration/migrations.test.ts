import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { expect, it } from 'vitest';
import { runMigrations } from '../../apps/api/src/platform/database/run-migrations';
import { createTestSchema } from './postgres-schema';

it.skipIf(!process.env.TEST_DATABASE_URL)(
  'upgrades a populated 0007 schema and replays the migration command without changing existing data',
  async () => {
    const migrations = new URL('../../apps/api/migrations/', import.meta.url);
    const legacy = await mkdtemp(join(tmpdir(), 'collabboard-migrations-'));
    const schema = await createTestSchema(process.env.TEST_DATABASE_URL!);
    const client = new pg.Client({ connectionString: schema.url });
    try {
      await client.connect();
      for (const name of (await readdir(migrations)).filter((name) =>
        /^000[1-7]_.*\.sql$/.test(name),
      )) {
        await copyFile(new URL(name, migrations), join(legacy, name));
      }
      await runMigrations(client, pathToFileURL(legacy + '/'));
      const owner = randomUUID(),
        editor = randomUUID(),
        project = randomUUID(),
        task = randomUUID();
      await client.query(
        "INSERT INTO users (id, identity_subject, email, display_name) VALUES ($1,'owner','owner@example.test','Owner'), ($2,'editor','editor@example.test','Editor')",
        [owner, editor],
      );
      await client.query('BEGIN');
      await client.query(
        "INSERT INTO projects (id, owner_id, name, description, is_trial, expires_at) VALUES ($1,$2,'Legacy','An isolated seven-day trial. All changes belong to this project.',true,now() + interval '1 day')",
        [project, owner],
      );
      await client.query(
        "INSERT INTO project_members(project_id,user_id,role) VALUES ($1,$2,'Owner'),($1,$3,'Editor')",
        [project, owner, editor],
      );
      await client.query(
        "INSERT INTO tasks(id,project_id,creator_id,title,position) VALUES ($1,$2,$3,'Original task',0)",
        [task, project, editor],
      );
      await client.query('COMMIT');

      const migrate = () =>
        promisify(execFile)(
          process.execPath,
          ['--import', 'tsx', 'src/platform/database/migrate.ts'],
          {
            cwd: new URL('../../apps/api/', import.meta.url),
            env: { ...process.env, DATABASE_URL: schema.url },
          },
        );
      await migrate();
      const history = () =>
        client
          .query(
            'SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name',
          )
          .then((result) => result.rows);
      const applied = await history();
      expect(applied.map((row) => row.name)).toEqual(
        (await readdir(migrations))
          .filter((name) => name.endsWith('.sql'))
          .sort(),
      );
      await migrate();
      expect(await history()).toEqual(applied);
      const record = (
        await client.query('SELECT * FROM projects WHERE id=$1', [project])
      ).rows[0];
      expect(record).toMatchObject({
        owner_id: owner,
        description: '',
        status: 'active',
      });
      expect(record).not.toHaveProperty('is_trial');
      expect(record).not.toHaveProperty('expires_at');
      expect(
        (
          await client.query(
            'SELECT user_id,role FROM project_members WHERE project_id=$1 ORDER BY role',
            [project],
          )
        ).rows,
      ).toEqual([
        { user_id: editor, role: 'Editor' },
        { user_id: owner, role: 'Owner' },
      ]);
      expect(
        (
          await client.query('SELECT id,title FROM tasks WHERE project_id=$1', [
            project,
          ])
        ).rows,
      ).toEqual([{ id: task, title: 'Original task' }]);
    } finally {
      await client.end();
      await schema.close();
      await rm(legacy, { recursive: true, force: true });
    }
  },
);
