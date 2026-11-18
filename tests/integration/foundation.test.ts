import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import type { CreateProject, CreateTask } from '@collabboard/contracts';
import { ProjectsService } from '../../apps/api/src/modules/projects/projects.service';
import type { Database } from '../../apps/api/src/platform/database/database';
import { localIdentities } from '../../apps/api/src/adapters/identity/local-identities';

type Sql = {
  query: (
    sql: string,
    parameters?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
  end?: () => Promise<void>;
  close?: () => Promise<void>;
  exec?: (sql: string) => Promise<unknown>;
};
let sql: Sql;
let service: ProjectsService;
const owner = localIdentities[0]!.id;
const other = localIdentities[1]!.id;
const createProject = (): CreateProject => ({
  name: 'Launch',
  description: 'A focused launch.',
  requestId: randomUUID(),
});
const createTask = (): CreateTask => ({
  title: 'First task',
  description: '',
  status: 'todo',
  priority: 'medium',
  dueDate: null,
  requestId: randomUUID(),
});

beforeAll(async () => {
  sql = process.env.TEST_DATABASE_URL
    ? (new pg.Client({
        connectionString: process.env.TEST_DATABASE_URL,
      }) as unknown as Sql)
    : (new PGlite() as unknown as Sql);
  if (sql instanceof pg.Client) await sql.connect();
  const migration = await readFile(
    new URL('../../apps/api/migrations/0001_foundation.sql', import.meta.url),
    'utf8',
  );
  if (sql.exec) await sql.exec(migration);
  else await sql.query(migration);
  service = new ProjectsService({
    pool: sql,
    transaction: async (work: (client: Sql) => Promise<unknown>) => {
      await sql.query('BEGIN');
      try {
        const result = await work(sql);
        await sql.query('COMMIT');
        return result;
      } catch (error) {
        await sql.query('ROLLBACK');
        throw error;
      }
    },
  } as unknown as Database);
});
beforeEach(async () => {
  await sql.query('TRUNCATE users CASCADE');
  for (const user of localIdentities)
    await sql.query(
      'INSERT INTO users (id, identity_subject, email, display_name) VALUES ($1, $2, $3, $4)',
      [user.id, `local:${user.id}`, user.email, user.displayName],
    );
});
afterAll(async () => {
  await sql?.end?.();
  await sql?.close?.();
});

describe('transactional foundation', () => {
  it('creates a project, exactly one Owner, activity, and an outbox event together', async () => {
    const project = await service.create(owner, createProject());
    expect(project.role).toBe('Owner');
    for (const table of [
      'projects',
      'project_members',
      'activity',
      'outbox_events',
    ])
      expect(
        (await sql.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0]
          ?.count,
      ).toBe(1);
    expect((await service.list(other)).items).toEqual([]);
  });
  it('replays an identical project request and rejects reuse with different content', async () => {
    const input = createProject();
    const first = await service.create(owner, input);
    expect(await service.create(owner, input)).toEqual(first);
    await expect(
      service.create(owner, { ...input, name: 'Changed' }),
    ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    expect((await service.list(owner)).items).toHaveLength(1);
  });
  it('hides a project and its tasks from a non-member', async () => {
    const project = await service.create(owner, createProject());
    await expect(service.board(other, project.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.createTask(other, project.id, createTask()),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('denies Viewer writes even when directly invoking the business service', async () => {
    const project = await service.create(owner, createProject());
    await sql.query(
      "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'Viewer')",
      [project.id, other],
    );
    await expect(
      service.createTask(other, project.id, createTask()),
    ).rejects.toMatchObject({ status: 403 });
    expect((await service.board(other, project.id)).tasks).toEqual([]);
  });
  it("allows an Editor to read a second account's project and create a task", async () => {
    const project = await service.create(owner, createProject());
    await sql.query(
      "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'Editor')",
      [project.id, other],
    );
    const result = await service.createTask(other, project.id, createTask());
    expect(result.task.title).toBe('First task');
    expect((await service.board(owner, project.id)).tasks).toHaveLength(1);
  });
  it('increments the revision once, appends tasks, and replays creation without duplicates', async () => {
    const project = await service.create(owner, createProject());
    const input = createTask();
    const first = await service.createTask(owner, project.id, input);
    expect(await service.createTask(owner, project.id, input)).toEqual(first);
    const second = await service.createTask(owner, project.id, createTask());
    expect(second.task.position).toBe(1);
    expect(second.boardRevision).toBe(2);
    const board = await service.board(owner, project.id);
    expect(board.project.boardRevision).toBe(2);
    expect(board.tasks).toHaveLength(2);
  });
  it('rechecks membership before replaying an earlier successful operation', async () => {
    const project = await service.create(owner, createProject());
    await sql.query(
      "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'Editor')",
      [project.id, other],
    );
    const input = createTask();
    await service.createTask(other, project.id, input);
    await sql.query(
      'DELETE FROM project_members WHERE project_id = $1 AND user_id = $2',
      [project.id, other],
    );
    await expect(
      service.createTask(other, project.id, input),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('enforces active project quotas and archived-project write restrictions', async () => {
    const project = await service.create(owner, createProject());
    await service.create(owner, createProject());
    await service.create(owner, createProject());
    await expect(service.create(owner, createProject())).rejects.toMatchObject({
      response: { code: 'PROJECT_LIMIT_REACHED' },
    });
    await sql.query("UPDATE projects SET status = 'archived' WHERE id = $1", [
      project.id,
    ]);
    await expect(
      service.createTask(owner, project.id, createTask()),
    ).rejects.toMatchObject({ response: { code: 'PROJECT_ARCHIVED' } });
  });
  it('rejects a project without its matching Owner at commit', async () => {
    await expect(
      sql.query(
        'INSERT INTO projects (id, owner_id, name) VALUES ($1, $2, $3)',
        [randomUUID(), owner, 'Invalid ownership'],
      ),
    ).rejects.toThrow('Project ownership');
  });
  it('rolls back business data when the transactional outbox write fails', async () => {
    const project = await service.create(owner, createProject());
    await sql.query(
      "ALTER TABLE outbox_events ADD CONSTRAINT reject_task_event CHECK (event_type <> 'task.created')",
    );
    try {
      await expect(
        service.createTask(owner, project.id, createTask()),
      ).rejects.toThrow();
    } finally {
      await sql.query(
        'ALTER TABLE outbox_events DROP CONSTRAINT reject_task_event',
      );
    }
    const board = await service.board(owner, project.id);
    expect(board.tasks).toEqual([]);
    expect(board.project.boardRevision).toBe(0);
    expect(
      (
        await sql.query(
          'SELECT count(*)::int AS count FROM idempotency_records',
        )
      ).rows[0]?.count,
    ).toBe(1);
  });
});
