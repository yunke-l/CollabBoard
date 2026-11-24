import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import type { CreateProject, CreateTask } from '@collabboard/contracts';
import { ProjectsService } from '../../apps/api/src/modules/projects/projects.service';
import { NotificationsService } from '../../apps/api/src/modules/notifications/notifications.service';
import { DiscussionService } from '../../apps/api/src/modules/discussion/discussion.service';
import { DispatcherService } from '../../apps/api/src/modules/events/dispatcher.service';
import type { EventHint } from '@collabboard/contracts';
import { FilesService } from '../../apps/api/src/modules/files/files.service';
import { LocalPrivateStorage } from '../../apps/api/src/platform/storage/private-storage';
import { consumeRate } from '../../apps/api/src/platform/http/rate-limit';
import { MaintenanceService } from '../../apps/api/src/platform/jobs/maintenance.service';
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
let notifications: NotificationsService;
let discussion: DiscussionService;
let database: Database;
let files: FilesService;
let storage: LocalPrivateStorage;
let storageRoot: string;
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
  assigneeId: null,
  requestId: randomUUID(),
});

beforeAll(async () => {
  sql = process.env.TEST_DATABASE_URL
    ? (new pg.Client({
        connectionString: process.env.TEST_DATABASE_URL,
      }) as unknown as Sql)
    : (new PGlite() as unknown as Sql);
  if (sql instanceof pg.Client) await sql.connect();
  const migrations = new URL('../../apps/api/migrations/', import.meta.url);
  for (const name of (await readdir(migrations))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const migration = await readFile(new URL(name, migrations), 'utf8');
    if (sql.exec) await sql.exec(migration);
    else await sql.query(migration);
  }
  database = {
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
  } as unknown as Database;
  service = new ProjectsService(database);
  notifications = new NotificationsService(database);
  discussion = new DiscussionService(database);
  storageRoot = await mkdtemp(join(tmpdir(), 'collabboard-files-'));
  storage = new LocalPrivateStorage(storageRoot);
  files = new FilesService(database, storage);
});
beforeEach(async () => {
  await sql.query('TRUNCATE users CASCADE');
  await sql.query('TRUNCATE rate_limits, object_cleanup');
  for (const user of localIdentities)
    await sql.query(
      'INSERT INTO users (id, identity_subject, email, display_name) VALUES ($1, $2, $3, $4)',
      [user.id, `local:${user.id}`, user.email, user.displayName],
    );
});
afterAll(async () => {
  await sql?.end?.();
  await sql?.close?.();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
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
      response: {
        code: 'PROJECT_LIMIT_REACHED',
        quota: { resource: 'activeProjects', used: 3, limit: 3 },
      },
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

const inviteInput = (role: 'Editor' | 'Viewer' = 'Editor') => ({
  email: localIdentities[1]!.email,
  role,
  token: randomBytes(32).toString('hex'),
  requestId: randomUUID(),
});
async function joinedProject(role: 'Editor' | 'Viewer' = 'Editor') {
  const project = await service.create(owner, createProject());
  const invitation = inviteInput(role);
  await service.createInvitation(owner, project.id, invitation);
  await service.acceptInvitation(localIdentities[1]!, {
    token: invitation.token,
    requestId: randomUUID(),
  });
  return { project, invitation };
}
const editInput = (task: Awaited<ReturnType<ProjectsService['task']>>) => ({
  title: task.title,
  description: task.description,
  priority: task.priority,
  dueDate: task.dueDate,
  assigneeId: task.assigneeId,
  expectedVersion: task.version,
  requestId: randomUUID(),
});

describe('invitations and current membership', () => {
  it('paginates incoming project memberships without duplicates at equal timestamps', async () => {
    for (let index = 0; index < 25; index++) {
      const id = randomUUID();
      const author = randomUUID();
      await sql.query(
        'INSERT INTO users(id, identity_subject, email, display_name) VALUES ($1, $2, $3, $4)',
        [
          author,
          `local:${author}`,
          `owner${index}@example.com`,
          'Project Owner',
        ],
      );
      await sql.query('BEGIN');
      await sql.query(
        "INSERT INTO projects(id, owner_id, name, created_at) VALUES ($1, $2, $3, '2026-11-19T12:00:00.123456Z')",
        [id, author, `Project ${index}`],
      );
      await sql.query(
        "INSERT INTO project_members(project_id, user_id, role) VALUES ($1, $2, 'Owner'), ($1, $3, 'Viewer')",
        [id, author, owner],
      );
      await sql.query('COMMIT');
    }
    const first = await service.list(owner);
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBeTruthy();
    const second = await service.list(owner, first.nextCursor!);
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((project) => project.id))
        .size,
    ).toBe(25);
    expect((await service.list(owner, undefined, 100)).items).toHaveLength(25);
    const small = await service.list(owner, undefined, 1);
    expect(small.items).toHaveLength(1);
    expect(
      (await service.list(owner, small.nextCursor!, 100)).items,
    ).toHaveLength(24);
    await expect(service.list(other, first.nextCursor!)).rejects.toMatchObject({
      response: { code: 'INVALID_CURSOR' },
    });
    await expect(service.list(owner, 'invalid')).rejects.toMatchObject({
      status: 400,
    });
  });
  it('joins the matching verified account once, keeps only credential hashes, and never overwrites an existing role', async () => {
    const project = await service.create(owner, createProject());
    const input = inviteInput();
    const invitation = await service.createInvitation(owner, project.id, input);
    expect(await service.createInvitation(owner, project.id, input)).toEqual(
      invitation,
    );
    const stored = await sql.query('SELECT * FROM invitations');
    expect(stored.rows[0]?.token_hash).toHaveLength(64);
    expect(JSON.stringify(stored.rows)).not.toContain(input.token);
    expect(
      JSON.stringify(
        (await sql.query('SELECT * FROM idempotency_records')).rows,
      ),
    ).not.toContain(input.token);
    const accept = { token: input.token, requestId: randomUUID() };
    expect(
      (await service.acceptInvitation(localIdentities[1]!, accept))
        .alreadyJoined,
    ).toBe(false);
    expect(await service.acceptInvitation(localIdentities[1]!, accept)).toEqual(
      { projectId: project.id, alreadyJoined: false },
    );
    await service.changeMember(owner, project.id, other, {
      role: 'Viewer',
      requestId: randomUUID(),
    });
    expect(
      (
        await service.acceptInvitation(localIdentities[1]!, {
          ...accept,
          requestId: randomUUID(),
        })
      ).alreadyJoined,
    ).toBe(true);
    expect((await service.board(other, project.id)).project.role).toBe(
      'Viewer',
    );
    expect((await service.members(owner, project.id)).members).toHaveLength(2);
    expect(await service.members(other, project.id)).not.toHaveProperty(
      'invitations',
    );
    await expect(service.invitations(other, project.id)).rejects.toMatchObject({
      status: 403,
    });
  });
  it('rejects mismatched and unverified identities, expired links, revoked links, and archived projects', async () => {
    const project = await service.create(owner, createProject());
    const input = inviteInput();
    const invitation = await service.createInvitation(owner, project.id, input);
    const accept = { token: input.token, requestId: randomUUID() };
    await expect(
      service.acceptInvitation(localIdentities[0]!, accept),
    ).rejects.toMatchObject({ response: { code: 'INVITE_EMAIL_MISMATCH' } });
    await expect(
      service.acceptInvitation(
        { ...localIdentities[1]!, emailVerified: false },
        accept,
      ),
    ).rejects.toMatchObject({ response: { code: 'EMAIL_UNVERIFIED' } });
    await sql.query("UPDATE projects SET status = 'archived' WHERE id = $1", [
      project.id,
    ]);
    await expect(
      service.acceptInvitation(localIdentities[1]!, accept),
    ).rejects.toMatchObject({ response: { code: 'PROJECT_ARCHIVED' } });
    await sql.query("UPDATE projects SET status = 'active' WHERE id = $1", [
      project.id,
    ]);
    await sql.query(
      "UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [invitation.id],
    );
    expect((await service.previewInvitation(input.token)).status).toBe(
      'expired',
    );
    await expect(
      service.acceptInvitation(localIdentities[1]!, accept),
    ).rejects.toMatchObject({ response: { code: 'INVITE_EXPIRED' } });
    const replacement = inviteInput();
    const next = await service.createInvitation(owner, project.id, replacement);
    await service.revokeInvitation(owner, project.id, next.id, {
      requestId: randomUUID(),
    });
    await expect(
      service.acceptInvitation(localIdentities[1]!, {
        token: replacement.token,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'INVITE_REVOKED' } });
    expect((await service.members(owner, project.id)).members).toHaveLength(1);
  });
  it('invalidates the old link when regenerating and prevents replay after membership removal', async () => {
    const project = await service.create(owner, createProject());
    const old = inviteInput();
    await service.createInvitation(owner, project.id, old);
    const next = inviteInput();
    await service.createInvitation(owner, project.id, next);
    await expect(
      service.acceptInvitation(localIdentities[1]!, {
        token: old.token,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'INVITE_REVOKED' } });
    const accept = { token: next.token, requestId: randomUUID() };
    await service.acceptInvitation(localIdentities[1]!, accept);
    await service.changeMember(owner, project.id, other, {
      requestId: randomUUID(),
    });
    await expect(
      service.acceptInvitation(localIdentities[1]!, accept),
    ).rejects.toMatchObject({ response: { code: 'INVITE_ALREADY_ACCEPTED' } });
    await expect(service.members(other, project.id)).rejects.toMatchObject({
      status: 404,
    });
  });
  it('denies Editor management actions and protects the sole Owner', async () => {
    const { project } = await joinedProject();
    await expect(
      service.createInvitation(other, project.id, inviteInput()),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.changeMember(other, project.id, owner, {
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.changeMember(owner, project.id, owner, {
        role: 'Viewer',
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'OWNER_TRANSFER_REQUIRED' } });
    const different = await service.create(other, createProject());
    await expect(
      service.revokeInvitation(owner, different.id, randomUUID(), {
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('rechecks the member quota at acceptance without consuming the invitation', async () => {
    const project = await service.create(owner, createProject());
    const input = inviteInput();
    await service.createInvitation(owner, project.id, input);
    for (let index = 0; index < 9; index++) {
      const id = randomUUID();
      await sql.query(
        'INSERT INTO users(id, identity_subject, email, display_name) VALUES ($1, $2, $3, $4)',
        [id, `local:${id}`, `member${index}@example.com`, 'Member'],
      );
      await sql.query(
        "INSERT INTO project_members(project_id, user_id, role) VALUES ($1, $2, 'Viewer')",
        [project.id, id],
      );
    }
    await expect(
      service.acceptInvitation(localIdentities[1]!, {
        token: input.token,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'MEMBER_LIMIT_REACHED',
        quota: { resource: 'members', used: 10, limit: 10 },
      },
    });
    await expect(
      service.createInvitation(owner, project.id, {
        ...inviteInput(),
        email: 'another@example.com',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'MEMBER_LIMIT_REACHED',
        quota: { resource: 'members', used: 10, limit: 10 },
      },
    });
    expect((await service.previewInvitation(input.token)).status).toBe(
      'pending',
    );
  });
});

describe('task editing, assignment, movement, and conflicts', () => {
  it('edits and assigns as an Editor, detects stale edits, and returns the original result on retry', async () => {
    const { project } = await joinedProject();
    const { task } = await service.createTask(owner, project.id, createTask());
    const input = {
      ...editInput(task),
      title: 'Ready to launch',
      assigneeId: other,
    };
    const result = await service.updateTask(other, task.id, input);
    expect(result.task).toMatchObject({
      title: 'Ready to launch',
      assigneeId: other,
      assigneeName: 'Jamie Lee',
      version: 2,
    });
    expect(await service.updateTask(other, task.id, input)).toEqual(result);
    await expect(
      service.updateTask(owner, task.id, {
        ...input,
        title: 'Stale edit',
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'VERSION_CONFLICT' } });
    expect((await service.task(owner, task.id)).title).toBe('Ready to launch');
    await expect(
      service.updateTask(other, task.id, { ...input, title: 'Reused request' }),
    ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REUSED' } });
  });
  it('rejects ineligible assignees and direct Viewer and non-member task operations', async () => {
    const { project } = await joinedProject('Viewer');
    const { task } = await service.createTask(owner, project.id, createTask());
    await expect(
      service.updateTask(owner, task.id, {
        ...editInput(task),
        assigneeId: other,
      }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_ASSIGNEE' } });
    await expect(
      service.createTask(owner, project.id, {
        ...createTask(),
        assigneeId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_ASSIGNEE' } });
    await expect(
      service.updateTask(other, task.id, editInput(task)),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.moveTask(other, task.id, {
        requestId: randomUUID(),
        expectedVersion: task.version,
        expectedBoardRevision: 2,
        status: 'done',
        beforeTaskId: null,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await service.changeMember(owner, project.id, other, {
      requestId: randomUUID(),
    });
    await expect(service.task(other, task.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.updateTask(other, task.id, editInput(task)),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('clears active assignments atomically on downgrade and removal, invalidating older drafts', async () => {
    const { project } = await joinedProject();
    const { task } = await service.createTask(owner, project.id, {
      ...createTask(),
      assigneeId: other,
    });
    await service.changeMember(owner, project.id, other, {
      role: 'Viewer',
      requestId: randomUUID(),
    });
    expect(await service.task(owner, task.id)).toMatchObject({
      assigneeId: null,
      version: 2,
    });
    await expect(
      service.updateTask(owner, task.id, editInput(task)),
    ).rejects.toMatchObject({ response: { code: 'VERSION_CONFLICT' } });
    await service.changeMember(owner, project.id, other, {
      role: 'Editor',
      requestId: randomUUID(),
    });
    const assigned = await service.updateTask(owner, task.id, {
      ...editInput(await service.task(owner, task.id)),
      assigneeId: other,
    });
    await service.changeMember(owner, project.id, other, {
      requestId: randomUUID(),
    });
    expect(await service.task(owner, task.id)).toMatchObject({
      assigneeId: null,
      version: assigned.task.version + 1,
    });
    await expect(
      service.updateTask(other, task.id, editInput(assigned.task)),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('reorders within a column, moves between columns, appends, and rejects stale board revisions', async () => {
    const { project } = await joinedProject();
    const first = await service.createTask(owner, project.id, {
      ...createTask(),
      title: 'First',
    });
    const second = await service.createTask(owner, project.id, {
      ...createTask(),
      title: 'Second',
    });
    const third = await service.createTask(owner, project.id, {
      ...createTask(),
      title: 'Third',
    });
    const input = {
      expectedVersion: third.task.version,
      expectedBoardRevision: third.boardRevision,
      status: 'todo' as const,
      beforeTaskId: first.task.id,
      requestId: randomUUID(),
    };
    const reordered = await service.moveTask(other, third.task.id, input);
    expect(
      (await service.board(owner, project.id)).tasks.map((task) => task.title),
    ).toEqual(['Third', 'First', 'Second']);
    expect(await service.moveTask(other, third.task.id, input)).toEqual(
      reordered,
    );
    await expect(
      service.moveTask(owner, second.task.id, {
        ...input,
        expectedVersion: second.task.version,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'VERSION_CONFLICT' } });
    const moved = await service.moveTask(owner, first.task.id, {
      expectedVersion: first.task.version,
      expectedBoardRevision: reordered.boardRevision,
      status: 'in_progress',
      beforeTaskId: null,
      requestId: randomUUID(),
    });
    expect(moved.task).toMatchObject({
      status: 'in_progress',
      position: 0,
      version: 2,
    });
    const appended = await service.moveTask(other, third.task.id, {
      expectedVersion: reordered.task.version,
      expectedBoardRevision: moved.boardRevision,
      status: 'in_progress',
      beforeTaskId: null,
      requestId: randomUUID(),
    });
    const board = await service.board(owner, project.id);
    expect(board.tasks).toHaveLength(3);
    expect(
      board.tasks
        .filter((task) => task.status === 'in_progress')
        .map((task) => task.title),
    ).toEqual(['First', 'Third']);
    expect(appended.task.position).toBe(1);
    await expect(
      service.moveTask(owner, second.task.id, {
        expectedVersion: 1,
        expectedBoardRevision: board.project.boardRevision,
        status: 'done',
        beforeTaskId: first.task.id,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_POSITION' } });
  });
  it('rolls back reordered positions, versions, and revisions when the outbox fails', async () => {
    const { project } = await joinedProject();
    const first = await service.createTask(owner, project.id, createTask());
    const second = await service.createTask(owner, project.id, createTask());
    const before = await service.board(owner, project.id);
    await sql.query(
      "ALTER TABLE outbox_events ADD CONSTRAINT reject_move CHECK (event_type <> 'task.moved')",
    );
    try {
      await expect(
        service.moveTask(other, second.task.id, {
          expectedVersion: 1,
          expectedBoardRevision: second.boardRevision,
          status: 'todo',
          beforeTaskId: first.task.id,
          requestId: randomUUID(),
        }),
      ).rejects.toThrow();
    } finally {
      await sql.query('ALTER TABLE outbox_events DROP CONSTRAINT reject_move');
    }
    expect(await service.board(owner, project.id)).toEqual(before);
  });
});

const projectAction = async (projectId: string, userId = owner) => ({
  expectedBoardRevision: (await service.details(userId, projectId))
    .boardRevision,
  requestId: randomUUID(),
});
const taskAction = (task: { version: number }) => ({
  expectedVersion: task.version,
  requestId: randomUUID(),
});

async function fillTasks(projectId: string, count: number, archived = false) {
  const values = Array.from({ length: count }, (_, position) => ({
    id: randomUUID(),
    position,
  }));
  await sql.query(
    `INSERT INTO tasks(id, project_id, creator_id, title, position, archived_at) SELECT item.id, $1, $2, 'Quota task', item.position, CASE WHEN $4 THEN now() ELSE NULL END FROM jsonb_to_recordset($3::jsonb) AS item(id uuid, position int)`,
    [projectId, owner, JSON.stringify(values), archived],
  );
}

describe('project and task lifecycle', () => {
  it('edits project details only for the current Owner, checks revisions, and replays without duplicate events', async () => {
    const { project } = await joinedProject();
    const input = {
      ...(await projectAction(project.id)),
      name: 'Updated launch',
      description: 'Revised scope.',
    };
    await expect(
      service.details(randomUUID(), project.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.updateProject(other, project.id, input),
    ).rejects.toMatchObject({ status: 403 });
    const updated = await service.updateProject(owner, project.id, input);
    expect(updated).toMatchObject({
      name: input.name,
      description: input.description,
      boardRevision: input.expectedBoardRevision + 1,
    });
    expect(await service.updateProject(owner, project.id, input)).toEqual(
      updated,
    );
    await expect(
      service.updateProject(owner, project.id, {
        ...input,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'VERSION_CONFLICT' } });
    expect(
      (
        await sql.query(
          "SELECT count(*)::int AS count FROM activity WHERE action = 'project.updated'",
        )
      ).rows[0]?.count,
    ).toBe(1);
  });
  it('keeps archived projects readable, rejects content writes and invitation consumption, then resumes after restore', async () => {
    const project = await service.create(owner, createProject());
    const invitation = inviteInput();
    await service.createInvitation(owner, project.id, invitation);
    await sql.query(
      "INSERT INTO project_members(project_id, user_id, role) VALUES ($1, $2, 'Editor')",
      [project.id, other],
    );
    const { task } = await service.createTask(owner, project.id, createTask());
    const input = await projectAction(project.id);
    await expect(
      service.setProjectArchived(other, project.id, true, input),
    ).rejects.toMatchObject({ status: 403 });
    const archived = await service.setProjectArchived(
      owner,
      project.id,
      true,
      input,
    );
    expect(archived.status).toBe('archived');
    expect(
      await service.setProjectArchived(owner, project.id, true, input),
    ).toEqual(archived);
    expect((await service.board(other, project.id)).tasks).toHaveLength(1);
    expect(await service.task(other, task.id)).toMatchObject({
      title: task.title,
    });
    for (const write of [
      () =>
        service.updateProject(owner, project.id, {
          ...createProject(),
          ...input,
        }),
      () => service.createTask(other, project.id, createTask()),
      () => service.updateTask(other, task.id, editInput(task)),
      () =>
        service.moveTask(owner, task.id, {
          ...taskAction(task),
          expectedBoardRevision: archived.boardRevision,
          status: 'done',
          beforeTaskId: null,
        }),
      () => service.setTaskArchived(owner, task.id, true, taskAction(task)),
      () => service.setTaskArchived(owner, task.id, false, taskAction(task)),
      () =>
        service.changeMember(owner, project.id, other, {
          role: 'Viewer',
          requestId: randomUUID(),
        }),
      () => service.createInvitation(owner, project.id, inviteInput()),
      () =>
        service.acceptInvitation(localIdentities[1]!, {
          token: invitation.token,
          requestId: randomUUID(),
        }),
      () =>
        service.transferOwnership(owner, project.id, {
          ...actionForRevision(archived.boardRevision),
          memberId: other,
        }),
    ])
      await expect(write()).rejects.toMatchObject({
        response: { code: 'PROJECT_ARCHIVED' },
      });
    expect((await service.previewInvitation(invitation.token)).status).toBe(
      'pending',
    );
    const restored = await service.setProjectArchived(
      owner,
      project.id,
      false,
      await projectAction(project.id),
    );
    expect(restored.status).toBe('active');
    expect(
      (
        await service.updateTask(other, task.id, {
          ...editInput(task),
          title: 'Resumed',
        })
      ).task.title,
    ).toBe('Resumed');
  });
  it('rechecks active project quotas on restoration and leaves failed requests retryable', async () => {
    const first = await service.create(owner, createProject());
    await service.setProjectArchived(
      owner,
      first.id,
      true,
      await projectAction(first.id),
    );
    const second = await service.create(owner, createProject());
    await service.create(owner, createProject());
    await service.create(owner, createProject());
    const input = await projectAction(first.id);
    await expect(
      service.setProjectArchived(owner, first.id, false, input),
    ).rejects.toMatchObject({
      response: {
        code: 'PROJECT_LIMIT_REACHED',
        quota: { resource: 'activeProjects', used: 3, limit: 3 },
      },
    });
    expect((await service.details(owner, first.id)).status).toBe('archived');
    await service.setProjectArchived(
      owner,
      second.id,
      true,
      await projectAction(second.id),
    );
    expect(
      (await service.setProjectArchived(owner, first.id, false, input)).status,
    ).toBe('active');
  });
  it('transfers to an existing Viewer as the sole Owner, demotes the original Owner, and allows only their identical retry', async () => {
    const { project } = await joinedProject('Viewer');
    const input = { ...(await projectAction(project.id)), memberId: other };
    await expect(
      service.transferOwnership(owner, project.id, {
        ...input,
        memberId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_OWNER' } });
    await expect(
      service.transferOwnership(owner, project.id, {
        ...input,
        memberId: owner,
      }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_OWNER' } });
    const result = await service.transferOwnership(owner, project.id, input);
    expect(result.role).toBe('Editor');
    expect(await service.transferOwnership(owner, project.id, input)).toEqual(
      result,
    );
    await expect(
      service.transferOwnership(owner, project.id, {
        ...input,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (await service.members(other, project.id)).members
        .filter((member) => member.role === 'Owner')
        .map((member) => member.id),
    ).toEqual([other]);
    expect(
      (
        await sql.query('SELECT owner_id FROM projects WHERE id = $1', [
          project.id,
        ])
      ).rows[0]?.owner_id,
    ).toBe(other);
    expect(
      (
        await sql.query(
          "SELECT count(*)::int AS count FROM activity WHERE action = 'project.ownership_transferred'",
        )
      ).rows[0]?.count,
    ).toBe(1);
  });
  it('rejects transfer at target active or total quotas without changing ownership', async () => {
    const { project } = await joinedProject();
    for (let index = 0; index < 10; index++) {
      const added = await service.create(other, createProject());
      if (index < 7)
        await service.setProjectArchived(
          other,
          added.id,
          true,
          await projectAction(added.id, other),
        );
    }
    const input = { ...(await projectAction(project.id)), memberId: other };
    await expect(
      service.transferOwnership(owner, project.id, input),
    ).rejects.toMatchObject({ response: { code: 'PROJECT_LIMIT_REACHED' } });
    const active = (await service.list(other)).items.find(
      (item) => item.role === 'Owner' && item.status === 'active',
    )!;
    await service.setProjectArchived(
      other,
      active.id,
      true,
      await projectAction(active.id, other),
    );
    await expect(
      service.transferOwnership(owner, project.id, input),
    ).rejects.toMatchObject({ response: { code: 'PROJECT_LIMIT_REACHED' } });
    expect((await service.details(owner, project.id)).role).toBe('Owner');
  });
  it('rolls back ownership, project state, task versions, and departure when the outbox fails', async () => {
    const { project } = await joinedProject();
    const { task } = await service.createTask(owner, project.id, {
      ...createTask(),
      assigneeId: other,
    });
    const before = await service.board(owner, project.id);
    await sql.query(
      "ALTER TABLE outbox_events ADD CONSTRAINT reject_lifecycle CHECK (event_type NOT IN ('project.ownership_transferred', 'project.archived', 'task.archived', 'member.left'))",
    );
    try {
      for (const write of [
        () =>
          service.transferOwnership(owner, project.id, {
            ...actionForRevision(before.project.boardRevision),
            memberId: other,
          }),
        () =>
          service.setProjectArchived(
            owner,
            project.id,
            true,
            actionForRevision(before.project.boardRevision),
          ),
        () => service.setTaskArchived(owner, task.id, true, taskAction(task)),
        () =>
          service.leaveProject(other, project.id, { requestId: randomUUID() }),
      ])
        await expect(write()).rejects.toThrow();
    } finally {
      await sql.query(
        'ALTER TABLE outbox_events DROP CONSTRAINT reject_lifecycle',
      );
    }
    expect(await service.board(owner, project.id)).toEqual(before);
    expect((await service.members(owner, project.id)).members).toHaveLength(2);
    expect((await service.details(owner, project.id)).role).toBe('Owner');
  });
  it('blocks Owner departure, clears active assignments on departure, preserves archived history, and revokes reads', async () => {
    const { project } = await joinedProject();
    const active = await service.createTask(owner, project.id, {
      ...createTask(),
      assigneeId: other,
    });
    const historical = await service.createTask(owner, project.id, {
      ...createTask(),
      assigneeId: other,
    });
    const archived = await service.setTaskArchived(
      owner,
      historical.task.id,
      true,
      taskAction(historical.task),
    );
    await expect(
      service.leaveProject(owner, project.id, { requestId: randomUUID() }),
    ).rejects.toMatchObject({ response: { code: 'OWNER_TRANSFER_REQUIRED' } });
    const input = { requestId: randomUUID() };
    expect(await service.leaveProject(other, project.id, input)).toEqual({
      projectId: project.id,
      left: true,
    });
    expect(await service.leaveProject(other, project.id, input)).toEqual({
      projectId: project.id,
      left: true,
    });
    await expect(
      service.leaveProject(other, project.id, { requestId: randomUUID() }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await service.task(owner, active.task.id)).toMatchObject({
      assigneeId: null,
      version: 2,
    });
    expect(await service.task(owner, historical.task.id)).toMatchObject({
      assigneeId: other,
      version: archived.task.version,
    });
    for (const read of [
      () => service.details(other, project.id),
      () => service.board(other, project.id),
      () => service.archivedTasks(other, project.id),
      () => service.task(other, historical.task.id),
    ])
      await expect(read()).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await service.setTaskArchived(
          owner,
          historical.task.id,
          false,
          taskAction(archived.task),
        )
      ).task.assigneeId,
    ).toBeNull();
    expect(
      (
        await sql.query(
          "SELECT count(*)::int AS count FROM activity WHERE action = 'member.left'",
        )
      ).rows[0]?.count,
    ).toBe(1);
  });
  it('allows a member to withdraw their own access from an archived project while content remains frozen', async () => {
    const { project } = await joinedProject();
    const { task } = await service.createTask(owner, project.id, {
      ...createTask(),
      assigneeId: other,
    });
    await service.setProjectArchived(
      owner,
      project.id,
      true,
      await projectAction(project.id),
    );
    await service.leaveProject(other, project.id, { requestId: randomUUID() });
    expect((await service.details(owner, project.id)).status).toBe('archived');
    expect(await service.task(owner, task.id)).toMatchObject({
      assigneeId: null,
      version: 2,
    });
    await expect(service.board(other, project.id)).rejects.toMatchObject({
      status: 404,
    });
  });
  it('archives with optimistic versions, restores at the end of the previous column, and revalidates historical assignees', async () => {
    const { project } = await joinedProject();
    const first = await service.createTask(owner, project.id, {
      ...createTask(),
      assigneeId: other,
      status: 'in_progress',
    });
    const second = await service.createTask(owner, project.id, {
      ...createTask(),
      status: 'in_progress',
    });
    const input = taskAction(first.task);
    const archived = await service.setTaskArchived(
      other,
      first.task.id,
      true,
      input,
    );
    expect(archived.task).toMatchObject({
      archivedAt: expect.any(String),
      status: 'in_progress',
      version: 2,
      assigneeId: other,
    });
    expect(
      await service.setTaskArchived(other, first.task.id, true, input),
    ).toEqual(archived);
    expect(
      (await service.board(owner, project.id)).tasks.map((task) => task.id),
    ).toEqual([second.task.id]);
    await expect(
      service.updateTask(owner, first.task.id, editInput(archived.task)),
    ).rejects.toMatchObject({ response: { code: 'TASK_ARCHIVED' } });
    await expect(
      service.setTaskArchived(
        owner,
        first.task.id,
        false,
        taskAction(first.task),
      ),
    ).rejects.toMatchObject({ response: { code: 'VERSION_CONFLICT' } });
    await service.changeMember(owner, project.id, other, {
      role: 'Viewer',
      requestId: randomUUID(),
    });
    await expect(
      service.setTaskArchived(
        other,
        first.task.id,
        false,
        taskAction(archived.task),
      ),
    ).rejects.toMatchObject({ status: 403 });
    const restored = await service.setTaskArchived(
      owner,
      first.task.id,
      false,
      taskAction(archived.task),
    );
    expect(restored.task).toMatchObject({
      archivedAt: null,
      version: 3,
      position: 2,
      status: 'in_progress',
      assigneeId: null,
    });
    expect(
      (await service.board(owner, project.id)).tasks.map((task) => task.id),
    ).toEqual([second.task.id, first.task.id]);
  });
  it('keeps eligible assignees on restoration and rejects restoration at the active task quota', async () => {
    const { project } = await joinedProject();
    await fillTasks(project.id, 500);
    await fillTasks(project.id, 1, true);
    const archived = (await service.archivedTasks(other, project.id)).items[0]!;
    await sql.query('UPDATE tasks SET assignee_id = $2 WHERE id = $1', [
      archived.id,
      other,
    ]);
    const input = taskAction(archived);
    await expect(
      service.setTaskArchived(other, archived.id, false, input),
    ).rejects.toMatchObject({
      response: {
        code: 'TASK_LIMIT_REACHED',
        quota: { resource: 'activeTasks', used: 500, limit: 500 },
      },
    });
    const active = (await service.board(owner, project.id)).tasks[0]!;
    await service.setTaskArchived(owner, active.id, true, taskAction(active));
    expect(
      (await service.setTaskArchived(other, archived.id, false, input)).task,
    ).toMatchObject({ archivedAt: null, assigneeId: other, position: 500 });
    expect((await service.board(other, project.id)).tasks).toHaveLength(500);
  });
  it('paginates archived tasks deterministically across equal microsecond timestamps and validates cursors', async () => {
    const { project } = await joinedProject('Viewer');
    await fillTasks(project.id, 25, true);
    await sql.query(
      "UPDATE tasks SET archived_at = '2026-11-19T12:00:00.123456Z' WHERE project_id = $1",
      [project.id],
    );
    const first = await service.archivedTasks(other, project.id);
    const second = await service.archivedTasks(
      other,
      project.id,
      first.nextCursor!,
    );
    expect(first.items).toHaveLength(20);
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((task) => task.id)).size,
    ).toBe(25);
    expect(
      (await service.archivedTasks(other, project.id, undefined, 100)).items,
    ).toHaveLength(25);
    const small = await service.archivedTasks(other, project.id, undefined, 1);
    expect(small.items).toHaveLength(1);
    expect(
      (await service.archivedTasks(other, project.id, small.nextCursor!, 100))
        .items,
    ).toHaveLength(24);
    for (const cursor of [
      'invalid',
      Buffer.from(JSON.stringify({ at: '0', id: first.items[0]!.id })).toString(
        'base64url',
      ),
    ])
      await expect(
        service.archivedTasks(other, project.id, cursor),
      ).rejects.toMatchObject({ status: 400 });
  });
});

describe('bounded lists and quota feedback', () => {
  it('paginates only unexpired pending invitations with stable millisecond ordering and rechecks ownership on each page', async () => {
    const { project } = await joinedProject();
    const secondProject = await service.create(owner, createProject());
    const rows = Array.from({ length: 105 }, (_, index) => ({
      id: randomUUID(),
      email: `invite${index}@example.com`,
      hash: randomBytes(32).toString('hex'),
    }));
    await sql.query(
      `INSERT INTO invitations(id, project_id, email, role, token_hash, expires_at, created_at) SELECT item.id, $1, item.email, 'Viewer', item.hash, now() + interval '1 day', '2026-11-19T12:00:00.123456Z' FROM jsonb_to_recordset($2::jsonb) AS item(id uuid, email text, hash text)`,
      [project.id, JSON.stringify(rows)],
    );
    await sql.query("UPDATE invitations SET status = 'revoked' WHERE id = $1", [
      rows[0]!.id,
    ]);
    await sql.query(
      "UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = $1",
      [rows[1]!.id],
    );
    const first = await service.invitations(owner, project.id);
    expect(first.items).toHaveLength(20);
    expect(first.items[0]).not.toHaveProperty('createdAt');
    expect(first.items[0]).not.toHaveProperty('token_hash');
    // A concurrent new invitation belongs on a first-page refresh, not behind the boundary.
    const recent = await service.createInvitation(owner, project.id, {
      ...inviteInput(),
      email: 'recent@example.com',
    });
    await service.revokeInvitation(owner, project.id, first.items[0]!.id, {
      requestId: randomUUID(),
    });
    const rest = await service.invitations(
      owner,
      project.id,
      first.nextCursor!,
      100,
    );
    expect(rest.items).toHaveLength(83);
    expect(rest.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...rest.items].map((item) => item.id)).size,
    ).toBe(103);
    expect(rest.items.some((item) => item.id === recent.id)).toBe(false);
    expect(
      (await service.invitations(owner, project.id, undefined, 100)).items,
    ).toHaveLength(100);
    const single = await service.invitations(owner, project.id, undefined, 1);
    expect(single.items).toHaveLength(1);
    await expect(
      service.invitations(owner, secondProject.id, first.nextCursor!),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CURSOR' } });
    await expect(
      service.archivedTasks(owner, project.id, first.nextCursor!),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CURSOR' } });
    await expect(
      service.invitations(other, project.id, first.nextCursor!),
    ).rejects.toMatchObject({ status: 403 });
    await service.setProjectArchived(
      owner,
      project.id,
      true,
      await projectAction(project.id),
    );
    expect((await service.invitations(owner, project.id)).items).toHaveLength(
      20,
    );
    await service.setProjectArchived(
      owner,
      project.id,
      false,
      await projectAction(project.id),
    );
    await service.transferOwnership(owner, project.id, {
      ...(await projectAction(project.id)),
      memberId: other,
    });
    await expect(
      service.invitations(owner, project.id, first.nextCursor!),
    ).rejects.toMatchObject({ status: 403 });
    await service.leaveProject(owner, project.id, { requestId: randomUUID() });
    await expect(
      service.invitations(owner, project.id, first.nextCursor!),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rejects invalid sizes and cursor dates before they can reach SQL', async () => {
    const project = await service.create(owner, createProject());
    for (const limit of [0, -1, 101, 1.5, NaN, Infinity]) {
      await expect(service.list(owner, undefined, limit)).rejects.toMatchObject(
        { status: 400 },
      );
      await expect(
        service.archivedTasks(owner, project.id, undefined, limit),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        service.invitations(owner, project.id, undefined, limit),
      ).rejects.toMatchObject({ status: 400 });
    }
    for (const at of [
      '0',
      '0000-01-01T00:00:00.000Z',
      '2026-02-30T00:00:00.000Z',
      '2026-11-19T12:00:00Z',
      '2026-11-19T12:00:00.123456Z',
    ]) {
      const cursor = Buffer.from(
        JSON.stringify({ scope: `projects:${owner}`, at, id: project.id }),
      ).toString('base64url');
      await expect(service.list(owner, cursor)).rejects.toMatchObject({
        response: { code: 'INVALID_CURSOR' },
      });
    }
    await expect(service.list(owner, 'x'.repeat(513))).rejects.toMatchObject({
      status: 400,
    });
  });

  it('reports the total project limit even when active slots are available and preserves failed writes', async () => {
    for (let index = 0; index < 10; index++) {
      const project = await service.create(owner, createProject());
      await service.setProjectArchived(
        owner,
        project.id,
        true,
        await projectAction(project.id),
      );
    }
    const input = createProject();
    await expect(service.create(owner, input)).rejects.toMatchObject({
      response: {
        code: 'PROJECT_LIMIT_REACHED',
        quota: { resource: 'totalProjects', used: 10, limit: 10 },
        message: expect.stringContaining(
          'archiving does not release total quota',
        ),
      },
    });
    expect((await service.list(owner)).items).toHaveLength(10);
    expect(
      (
        await sql.query(
          'SELECT 1 FROM idempotency_records WHERE request_id = $1',
          [input.requestId],
        )
      ).rows,
    ).toHaveLength(0);
  });

  it('distinguishes active and total task quotas and permits restoration at the total limit', async () => {
    const project = await service.create(owner, createProject());
    await fillTasks(project.id, 500);
    const input = createTask();
    await expect(
      service.createTask(owner, project.id, input),
    ).rejects.toMatchObject({
      response: {
        code: 'TASK_LIMIT_REACHED',
        quota: { resource: 'activeTasks', used: 500, limit: 500 },
      },
    });
    await sql.query(
      'UPDATE tasks SET archived_at = now() WHERE project_id = $1',
      [project.id],
    );
    await fillTasks(project.id, 1500, true);
    await expect(
      service.createTask(owner, project.id, input),
    ).rejects.toMatchObject({
      response: {
        code: 'TASK_LIMIT_REACHED',
        quota: { resource: 'totalTasks', used: 2000, limit: 2000 },
        message: expect.stringContaining(
          'archiving does not release total quota',
        ),
      },
    });
    const archived = (await service.archivedTasks(owner, project.id)).items[0]!;
    expect(
      (
        await service.setTaskArchived(
          owner,
          archived.id,
          false,
          taskAction(archived),
        )
      ).task.archivedAt,
    ).toBeNull();
    expect(
      (
        await sql.query(
          'SELECT count(*)::int AS count FROM tasks WHERE project_id = $1',
          [project.id],
        )
      ).rows[0]?.count,
    ).toBe(2000);
    expect(
      (
        await sql.query(
          'SELECT 1 FROM idempotency_records WHERE request_id = $1',
          [input.requestId],
        )
      ).rows,
    ).toHaveLength(0);
  });
});

describe('persisted recipient notifications', () => {
  it('notifies a new assignee once and skips self-assignment, unchanged assignment, clearing, and unrelated task actions', async () => {
    const { project } = await joinedProject();
    const input = { ...createTask(), assigneeId: other };
    const created = await service.createTask(owner, project.id, input);
    await service.createTask(owner, project.id, input);
    let task = (
      await service.updateTask(owner, created.task.id, {
        ...editInput(created.task),
        title: 'Renamed task',
      })
    ).task;
    task = (
      await service.updateTask(other, task.id, {
        ...editInput(task),
        assigneeId: null,
      })
    ).task;
    task = (
      await service.updateTask(other, task.id, {
        ...editInput(task),
        assigneeId: other,
      })
    ).task;
    expect(await notifications.summary(other)).toEqual({ unreadCount: 1 });
    task = (
      await service.updateTask(owner, task.id, {
        ...editInput(task),
        assigneeId: null,
      })
    ).task;
    const assign = { ...editInput(task), assigneeId: other };
    task = (await service.updateTask(owner, task.id, assign)).task;
    await service.updateTask(owner, task.id, assign);
    task = (
      await service.setTaskArchived(owner, task.id, true, taskAction(task))
    ).task;
    await service.setTaskArchived(owner, task.id, false, taskAction(task));
    await service.createTask(owner, project.id, {
      ...createTask(),
      assigneeId: owner,
    });
    expect(await notifications.summary(other)).toEqual({ unreadCount: 2 });
    expect(await notifications.summary(owner)).toEqual({ unreadCount: 0 });
    const received = (await notifications.list(other)).items;
    expect(received).toHaveLength(2);
    expect(received[0]!.target).toMatchObject({
      taskId: task.id,
      actorName: localIdentities[0]!.displayName,
      taskTitle: 'Renamed task',
    });
    const sources = await sql.query(
      'SELECT o.event_type FROM notifications n JOIN outbox_events o ON o.event_id = n.source_event_id ORDER BY o.event_type',
    );
    expect(sources.rows.map((row) => row.event_type)).toEqual([
      'task.created',
      'task.updated',
    ]);
  });

  it('rolls back task data, activity, outbox, revision, and idempotency when notification persistence fails', async () => {
    const { project } = await joinedProject();
    const created = await service.createTask(owner, project.id, createTask());
    const before = await service.board(owner, project.id);
    const events = (
      await sql.query('SELECT count(*)::int AS count FROM outbox_events')
    ).rows[0]!.count;
    await sql.query(
      'ALTER TABLE notifications ADD CONSTRAINT reject_notification CHECK (false)',
    );
    try {
      await expect(
        service.createTask(owner, project.id, {
          ...createTask(),
          assigneeId: other,
        }),
      ).rejects.toThrow();
      await expect(
        service.updateTask(owner, created.task.id, {
          ...editInput(created.task),
          assigneeId: other,
        }),
      ).rejects.toThrow();
    } finally {
      await sql.query(
        'ALTER TABLE notifications DROP CONSTRAINT reject_notification',
      );
    }
    expect(await service.board(owner, project.id)).toEqual(before);
    expect(
      (await sql.query('SELECT count(*)::int AS count FROM outbox_events'))
        .rows[0]!.count,
    ).toBe(events);
    expect(
      (await sql.query('SELECT count(*)::int AS count FROM activity')).rows[0]!
        .count,
    ).toBe(events);
    expect(await notifications.summary(other)).toEqual({ unreadCount: 0 });
    expect(
      (
        await sql.query(
          "SELECT count(*)::int AS count FROM idempotency_records WHERE operation LIKE 'update-task:%'",
        )
      ).rows[0]!.count,
    ).toBe(0);
  });

  it('enforces source deduplication and a consistent task/project pair in the database', async () => {
    const { project } = await joinedProject();
    await service.createTask(owner, project.id, {
      ...createTask(),
      assigneeId: other,
    });
    await expect(
      sql.query(
        'INSERT INTO notifications(id, recipient_id, actor_id, project_id, task_id, type, source_event_id) SELECT $1, recipient_id, actor_id, project_id, task_id, type, source_event_id FROM notifications LIMIT 1',
        [randomUUID()],
      ),
    ).rejects.toThrow();
    const separate = await service.create(owner, createProject());
    await expect(
      sql.query(
        'INSERT INTO notifications(id, recipient_id, actor_id, project_id, task_id, type, source_event_id) SELECT $1, recipient_id, actor_id, $2, task_id, type, $3 FROM notifications LIMIT 1',
        [randomUUID(), separate.id, randomUUID()],
      ),
    ).rejects.toThrow();
    expect((await notifications.list(other)).items).toHaveLength(1);
  });

  it('scopes reads and counts to the recipient and hides content after access revocation', async () => {
    const { project } = await joinedProject();
    let task = (
      await service.createTask(owner, project.id, {
        ...createTask(),
        title: 'Private notification task',
        assigneeId: other,
      })
    ).task;
    const item = (await notifications.list(other)).items[0]!;
    expect((await notifications.list(owner)).items).toEqual([]);
    expect(await notifications.summary(owner)).toEqual({ unreadCount: 0 });
    await expect(
      notifications.read(owner, item.id, { requestId: randomUUID() }),
    ).rejects.toMatchObject({ status: 404 });
    await service.changeMember(owner, project.id, other, {
      role: 'Viewer',
      requestId: randomUUID(),
    });
    expect((await notifications.list(other)).items[0]!.target?.taskTitle).toBe(
      'Private notification task',
    );
    task = await service.task(owner, task.id);
    await service.setTaskArchived(owner, task.id, true, taskAction(task));
    expect(
      (await notifications.list(other)).items[0]!.target?.taskArchived,
    ).toBe(true);
    await service.setProjectArchived(
      owner,
      project.id,
      true,
      await projectAction(project.id),
    );
    expect((await notifications.list(other)).items[0]!.target).not.toBeNull();
    await service.leaveProject(other, project.id, { requestId: randomUUID() });
    const redacted = (await notifications.list(other)).items[0]!;
    expect(redacted).toMatchObject({ id: item.id, target: null });
    expect(JSON.stringify(redacted)).not.toContain('Private notification task');
    expect(JSON.stringify(redacted)).not.toContain(project.name);
    expect(JSON.stringify(redacted)).not.toContain(task.id);
    expect(await notifications.summary(other)).toEqual({ unreadCount: 1 });
    await notifications.read(other, item.id, { requestId: randomUUID() });
    expect(await notifications.summary(other)).toEqual({ unreadCount: 0 });
    await expect(service.task(other, task.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('marks individual notifications idempotently without changing read time or another recipient', async () => {
    const { project } = await joinedProject();
    await service.createTask(owner, project.id, {
      ...createTask(),
      assigneeId: other,
    });
    await service.createTask(other, project.id, {
      ...createTask(),
      assigneeId: owner,
    });
    const item = (await notifications.list(other)).items[0]!;
    const request = { requestId: randomUUID() };
    const read = await notifications.read(other, item.id, request);
    expect(await notifications.read(other, item.id, request)).toEqual(read);
    expect(
      await notifications.read(other, item.id, { requestId: randomUUID() }),
    ).toEqual(read);
    expect(await notifications.summary(other)).toEqual({ unreadCount: 0 });
    expect(await notifications.summary(owner)).toEqual({ unreadCount: 1 });
    expect(
      await notifications.readAll(other, { requestId: randomUUID() }),
    ).toMatchObject({ updated: 0 });
    expect(await notifications.summary(owner)).toEqual({ unreadCount: 1 });
  });

  it('keeps read-all retries behind the original operation and excludes future timestamps', async () => {
    const { project } = await joinedProject();
    await service.createTask(owner, project.id, {
      ...createTask(),
      assigneeId: other,
    });
    const input = { requestId: randomUUID() };
    const first = await notifications.readAll(other, input);
    expect(first).toMatchObject({ updated: 1 });
    expect(first.readThrough).toMatch(/^\d{4}-.*\.\d{6}Z$/);
    await service.createTask(owner, project.id, {
      ...createTask(),
      assigneeId: other,
    });
    expect(await notifications.readAll(other, input)).toEqual(first);
    expect(await notifications.summary(other)).toEqual({ unreadCount: 1 });
    const recent = (await notifications.list(other)).items.find(
      (item) => item.readAt === null,
    )!;
    await sql.query(
      "UPDATE notifications SET created_at = now() + interval '1 hour' WHERE id = $1",
      [recent.id],
    );
    expect(
      await notifications.readAll(other, { requestId: randomUUID() }),
    ).toMatchObject({ updated: 0 });
    expect(await notifications.summary(other)).toEqual({ unreadCount: 1 });
  });

  it('paginates equal microsecond timestamps, supports 100-item pages, and scopes cursors to the recipient', async () => {
    const { project } = await joinedProject();
    const { task } = await service.createTask(owner, project.id, createTask());
    const rows = Array.from({ length: 105 }, () => ({
      id: randomUUID(),
      eventId: randomUUID(),
    }));
    await sql.query(
      `INSERT INTO notifications(id, recipient_id, actor_id, project_id, task_id, type, source_event_id, created_at) SELECT item.id, $1, $2, $3, $4, 'task_assigned', item."eventId", date_trunc('day', now()) - interval '1 day' + interval '0.123456 seconds' FROM jsonb_to_recordset($5::jsonb) AS item(id uuid, "eventId" uuid)`,
      [other, owner, project.id, task.id, JSON.stringify(rows)],
    );
    const first = await notifications.list(other);
    expect(first.items).toHaveLength(20);
    await service.createTask(owner, project.id, {
      ...createTask(),
      assigneeId: other,
    });
    const next = await notifications.list(other, first.nextCursor!, 100);
    expect(next.items).toHaveLength(85);
    expect(next.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...next.items].map((item) => item.id)).size,
    ).toBe(105);
    const hundred = await notifications.list(other, undefined, 100);
    expect(hundred.items).toHaveLength(100);
    expect(
      (await notifications.list(other, hundred.nextCursor!, 100)).items,
    ).toHaveLength(6);
    await expect(
      notifications.list(owner, first.nextCursor!),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CURSOR' } });
    await expect(
      notifications.list(other, undefined, 101),
    ).rejects.toMatchObject({ status: 400 });
    await expect(notifications.list(other, 'invalid')).rejects.toMatchObject({
      status: 400,
    });
    await sql.query("UPDATE projects SET status = 'expired' WHERE id = $1", [
      project.id,
    ]);
    expect(
      (await notifications.list(other)).items.every(
        (item) => item.target === null,
      ),
    ).toBe(true);
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'deduplicates concurrent assignment retries',
    async () => {
      const { project } = await joinedProject();
      const input = { ...createTask(), assigneeId: other };
      await withConcurrentService(async (concurrent) => {
        const results = await Promise.all([
          concurrent.createTask(owner, project.id, input),
          concurrent.createTask(owner, project.id, input),
        ]);
        expect(results[0]).toEqual(results[1]);
      });
      expect(await notifications.summary(other)).toEqual({ unreadCount: 1 });
    },
  );

  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'preserves a late commit even when its timestamp precedes the read-all boundary',
    async () => {
      const { project } = await joinedProject();
      const { task } = await service.createTask(owner, project.id, {
        ...createTask(),
        assigneeId: other,
      });
      const writer = new pg.Client({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      await writer.connect();
      try {
        await writer.query('BEGIN');
        await writer.query(
          "INSERT INTO notifications(id, recipient_id, actor_id, project_id, task_id, type, source_event_id) VALUES ($1, $2, $3, $4, $5, 'task_assigned', $6)",
          [randomUUID(), other, owner, project.id, task.id, randomUUID()],
        );
        const input = { requestId: randomUUID() };
        await withConcurrentService(
          async (_concurrent, concurrentNotifications) => {
            const result = await concurrentNotifications.readAll(other, input);
            expect(result.updated).toBe(1);
            await writer.query('COMMIT');
            expect(await concurrentNotifications.readAll(other, input)).toEqual(
              result,
            );
            expect(await concurrentNotifications.summary(other)).toEqual({
              unreadCount: 1,
            });
          },
        );
      } finally {
        await writer.query('ROLLBACK');
        await writer.end();
      }
    },
  );
});

describe('versioned comments and immutable activity', () => {
  it('creates comments with real counts, a shared revision, activity, outbox, and a body-free idempotent acknowledgement', async () => {
    const { project } = await joinedProject();
    const { task } = await service.createTask(owner, project.id, createTask());
    const input = { body: 'Private discussion text', requestId: randomUUID() };
    const result = await discussion.create(other, task.id, input);
    expect(await discussion.create(other, task.id, input)).toEqual(result);
    expect(result).not.toHaveProperty('body');
    expect(result.boardRevision).toBe(3);
    expect(await discussion.comment(owner, result.commentId)).toMatchObject({
      body: input.body,
      authorId: other,
      authorName: localIdentities[1]!.displayName,
      version: 1,
    });
    expect(await service.task(owner, task.id)).toMatchObject({
      commentCount: 1,
      version: 1,
    });
    expect(
      (await service.board(other, project.id)).tasks[0]!.commentCount,
    ).toBe(1);
    for (const table of ['activity', 'outbox_events'])
      expect(
        (await sql.query(`SELECT count(*)::int AS count FROM ${table}`))
          .rows[0]!.count,
      ).toBe(5);
    expect(
      JSON.stringify(
        (await sql.query('SELECT result FROM idempotency_records')).rows,
      ),
    ).not.toContain(input.body);
    const feed = await discussion.activity(other, project.id, task.id);
    expect(feed.items.map((entry) => entry.action)).toContain(
      'comment.created',
    );
    expect(
      feed.items.find((entry) => entry.action === 'comment.created'),
    ).toMatchObject({
      actorId: other,
      changes: { commentId: result.commentId, version: 1 },
    });
  });

  it('enforces authorship and Owner moderation without letting Owners edit someone else comments', async () => {
    const { project } = await joinedProject();
    const { task } = await service.createTask(owner, project.id, createTask());
    const own = await discussion.create(owner, task.id, {
      body: 'Owner comment',
      requestId: randomUUID(),
    });
    const theirs = await discussion.create(other, task.id, {
      body: 'Editor comment',
      requestId: randomUUID(),
    });
    await expect(
      discussion.update(owner, theirs.commentId, {
        body: 'Replaced',
        expectedVersion: 1,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      discussion.update(other, own.commentId, {
        body: 'Replaced',
        expectedVersion: 1,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      discussion.delete(other, own.commentId, {
        expectedVersion: 1,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (
        await discussion.delete(owner, theirs.commentId, {
          expectedVersion: 1,
          requestId: randomUUID(),
        })
      ).version,
    ).toBe(2);
    expect((await discussion.comment(other, theirs.commentId)).body).toBeNull();
  });

  it('detects comment conflicts and never returns deleted bodies through reads, history, or replay', async () => {
    const project = await service.create(owner, createProject());
    const { task } = await service.createTask(owner, project.id, createTask());
    const input = { body: 'Original secret comment', requestId: randomUUID() };
    const created = await discussion.create(owner, task.id, input);
    const update = {
      body: 'Edited secret comment',
      expectedVersion: 1,
      requestId: randomUUID(),
    };
    const edited = await discussion.update(owner, created.commentId, update);
    expect(
      (await discussion.comment(owner, created.commentId)).editedAt,
    ).toBeTruthy();
    await expect(
      discussion.update(owner, created.commentId, {
        ...update,
        body: 'Stale draft',
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'VERSION_CONFLICT' } });
    const deletion = { expectedVersion: 2, requestId: randomUUID() };
    const removed = await discussion.delete(owner, created.commentId, deletion);
    expect(await discussion.delete(owner, created.commentId, deletion)).toEqual(
      removed,
    );
    expect(await discussion.create(owner, task.id, input)).toEqual(created);
    expect(await discussion.update(owner, created.commentId, update)).toEqual(
      edited,
    );
    const tombstone = await discussion.comment(owner, created.commentId);
    expect(tombstone).toMatchObject({ version: 3, body: null });
    expect(tombstone.deletedAt).toBeTruthy();
    expect((await discussion.comments(owner, task.id)).items).toEqual([
      tombstone,
    ]);
    expect((await service.task(owner, task.id)).commentCount).toBe(0);
    expect(
      (
        await sql.query('SELECT body FROM comments WHERE id = $1', [
          created.commentId,
        ])
      ).rows[0]!.body,
    ).toBeNull();
    const serialized = JSON.stringify([
      await discussion.activity(owner, project.id),
      (await sql.query('SELECT result FROM idempotency_records')).rows,
    ]);
    expect(serialized).not.toContain(input.body);
    expect(serialized).not.toContain(update.body);
    await expect(
      discussion.update(owner, created.commentId, {
        body: 'Revive',
        expectedVersion: 3,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'COMMENT_DELETED' } });
  });

  it('allows authorized deletion on archived tasks and freezes every mutation on archived projects', async () => {
    const { project } = await joinedProject();
    const { task } = await service.createTask(owner, project.id, createTask());
    const own = await discussion.create(owner, task.id, {
      body: 'Keep for moderation',
      requestId: randomUUID(),
    });
    const first = await discussion.create(other, task.id, {
      body: 'Editor one',
      requestId: randomUUID(),
    });
    const second = await discussion.create(other, task.id, {
      body: 'Editor two',
      requestId: randomUUID(),
    });
    await service.setTaskArchived(owner, task.id, true, taskAction(task));
    await expect(
      discussion.create(other, task.id, {
        body: 'Too late',
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'TASK_ARCHIVED' } });
    await expect(
      discussion.update(other, first.commentId, {
        body: 'Too late',
        expectedVersion: 1,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'TASK_ARCHIVED' } });
    await discussion.delete(other, first.commentId, {
      expectedVersion: 1,
      requestId: randomUUID(),
    });
    await discussion.delete(owner, second.commentId, {
      expectedVersion: 1,
      requestId: randomUUID(),
    });
    await service.setProjectArchived(
      owner,
      project.id,
      true,
      await projectAction(project.id),
    );
    for (const write of [
      () =>
        discussion.create(owner, task.id, {
          body: 'Blocked',
          requestId: randomUUID(),
        }),
      () =>
        discussion.update(owner, own.commentId, {
          body: 'Blocked',
          expectedVersion: 1,
          requestId: randomUUID(),
        }),
      () =>
        discussion.delete(owner, own.commentId, {
          expectedVersion: 1,
          requestId: randomUUID(),
        }),
    ])
      await expect(write()).rejects.toMatchObject({
        response: { code: 'PROJECT_ARCHIVED' },
      });
    expect((await discussion.comments(other, task.id)).items).toHaveLength(3);
    expect(
      (await discussion.activity(other, project.id, task.id)).items.length,
    ).toBeGreaterThan(0);
    await service.setProjectArchived(
      owner,
      project.id,
      false,
      await projectAction(project.id),
    );
    await discussion.delete(owner, own.commentId, {
      expectedVersion: 1,
      requestId: randomUUID(),
    });
    expect((await service.task(owner, task.id)).commentCount).toBe(0);
  });

  it('rechecks downgrades and removal before fresh writes and successful mutation replay', async () => {
    const { project } = await joinedProject();
    const { task } = await service.createTask(owner, project.id, createTask());
    const input = {
      body: 'Membership-sensitive comment',
      requestId: randomUUID(),
    };
    const created = await discussion.create(other, task.id, input);
    await service.changeMember(owner, project.id, other, {
      role: 'Viewer',
      requestId: randomUUID(),
    });
    expect((await discussion.comment(other, created.commentId)).body).toBe(
      input.body,
    );
    for (const write of [
      () => discussion.create(other, task.id, input),
      () =>
        discussion.update(other, created.commentId, {
          body: 'Forbidden',
          expectedVersion: 1,
          requestId: randomUUID(),
        }),
      () =>
        discussion.delete(other, created.commentId, {
          expectedVersion: 1,
          requestId: randomUUID(),
        }),
    ])
      await expect(write()).rejects.toMatchObject({ status: 403 });
    await service.changeMember(owner, project.id, other, {
      requestId: randomUUID(),
    });
    for (const read of [
      () => discussion.comments(other, task.id),
      () => discussion.comment(other, created.commentId),
      () => discussion.activity(other, project.id),
      () => discussion.create(other, task.id, input),
    ])
      await expect(read()).rejects.toMatchObject({ status: 404 });
  });

  it('rolls comment writes back when their outbox event fails', async () => {
    const project = await service.create(owner, createProject());
    const { task } = await service.createTask(owner, project.id, createTask());
    const created = await discussion.create(owner, task.id, {
      body: 'Preserved original',
      requestId: randomUUID(),
    });
    const before = await service.board(owner, project.id);
    const history = await discussion.activity(owner, project.id);
    await sql.query(
      "ALTER TABLE outbox_events ADD CONSTRAINT reject_comment_events CHECK (event_type NOT IN ('comment.created', 'comment.updated', 'comment.deleted')) NOT VALID",
    );
    try {
      for (const write of [
        () =>
          discussion.create(owner, task.id, {
            body: 'Rollback create',
            requestId: randomUUID(),
          }),
        () =>
          discussion.update(owner, created.commentId, {
            body: 'Rollback edit',
            expectedVersion: 1,
            requestId: randomUUID(),
          }),
        () =>
          discussion.delete(owner, created.commentId, {
            expectedVersion: 1,
            requestId: randomUUID(),
          }),
      ])
        await expect(write()).rejects.toThrow();
    } finally {
      await sql.query(
        'ALTER TABLE outbox_events DROP CONSTRAINT reject_comment_events',
      );
    }
    expect(await service.board(owner, project.id)).toEqual(before);
    expect(await discussion.activity(owner, project.id)).toEqual(history);
    expect(await discussion.comment(owner, created.commentId)).toMatchObject({
      version: 1,
      body: 'Preserved original',
      deletedAt: null,
      editedAt: null,
    });
    expect((await discussion.comments(owner, task.id)).items).toHaveLength(1);
  });

  it('paginates comments and activity at equal microseconds without mixing tasks or cursor scopes', async () => {
    const { project } = await joinedProject('Viewer');
    const { task } = await service.createTask(owner, project.id, createTask());
    for (let index = 0; index < 25; index++)
      await discussion.create(owner, task.id, {
        body: `Paged comment ${index}`,
        requestId: randomUUID(),
      });
    await sql.query(
      "UPDATE comments SET created_at = date_trunc('day', now()) - interval '1 day' + interval '0.123456 seconds' WHERE task_id = $1",
      [task.id],
    );
    await sql.query(
      "UPDATE activity SET created_at = date_trunc('day', now()) - interval '1 day' + interval '0.123456 seconds' WHERE task_id = $1",
      [task.id],
    );
    const first = await discussion.comments(other, task.id);
    const second = await discussion.comments(other, task.id, first.nextCursor!);
    expect(first.items).toHaveLength(20);
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)).size,
    ).toBe(25);
    expect(
      (await discussion.comments(other, task.id, undefined, 100)).items,
    ).toHaveLength(25);
    const feed = await discussion.activity(other, project.id, task.id);
    await discussion.create(owner, task.id, {
      body: 'Newer arrival',
      requestId: randomUUID(),
    });
    const rest = await discussion.activity(
      other,
      project.id,
      task.id,
      feed.nextCursor!,
    );
    expect(feed.items).toHaveLength(20);
    expect(rest.items).toHaveLength(6);
    expect(
      new Set([...feed.items, ...rest.items].map((entry) => entry.id)).size,
    ).toBe(26);
    expect(
      (await discussion.activity(other, project.id, task.id, undefined, 100))
        .items,
    ).toHaveLength(27);
    const different = await service.createTask(owner, project.id, createTask());
    await expect(
      discussion.comments(other, different.task.id, first.nextCursor!),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CURSOR' } });
    await expect(
      discussion.activity(other, project.id, undefined, feed.nextCursor!),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CURSOR' } });
    const separate = await service.create(owner, createProject());
    await expect(
      discussion.activity(owner, separate.id, task.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      discussion.comments(other, task.id, undefined, 101),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('presents task changes, historical member names, actor attribution, and no invitation credentials', async () => {
    const { project, invitation } = await joinedProject();
    const { task } = await service.createTask(owner, project.id, {
      ...createTask(),
      assigneeId: other,
    });
    await service.updateTask(owner, task.id, {
      ...editInput(task),
      title: 'Changed title',
      assigneeId: owner,
    });
    await service.changeMember(owner, project.id, other, {
      role: 'Viewer',
      requestId: randomUUID(),
    });
    await service.changeMember(owner, project.id, other, {
      requestId: randomUUID(),
    });
    const feed = await discussion.activity(owner, project.id);
    const update = feed.items.find((entry) => entry.action === 'task.updated')!;
    expect(update).toMatchObject({
      actorId: owner,
      changes: {
        before: { title: 'First task', assigneeId: other },
        after: { title: 'Changed title', assigneeId: owner },
      },
    });
    expect(update.people).toMatchObject({
      [other]: localIdentities[1]!.displayName,
      [owner]: localIdentities[0]!.displayName,
    });
    expect(
      feed.items.find((entry) => entry.action === 'member.removed')!.people[
        other
      ],
    ).toBe(localIdentities[1]!.displayName);
    expect(JSON.stringify(feed)).not.toContain(invitation.token);
    expect(JSON.stringify(feed)).not.toContain('token_hash');
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'deduplicates concurrent comment creation and rejects a competing stale edit',
    async () => {
      const { project } = await joinedProject();
      const { task } = await service.createTask(
        owner,
        project.id,
        createTask(),
      );
      const input = { body: 'Concurrent comment', requestId: randomUUID() };
      await withConcurrentService(
        async (_projects, _notifications, concurrent) => {
          const created = await Promise.all([
            concurrent.create(other, task.id, input),
            concurrent.create(other, task.id, input),
          ]);
          expect(created[0]).toEqual(created[1]);
          const results = await Promise.allSettled(
            ['One', 'Two'].map((body) =>
              concurrent.update(other, created[0]!.commentId, {
                body,
                expectedVersion: 1,
                requestId: randomUUID(),
              }),
            ),
          );
          expect(
            results.filter((result) => result.status === 'fulfilled'),
          ).toHaveLength(1);
          const rejected = results.find(
            (result) => result.status === 'rejected',
          );
          expect(
            rejected?.status === 'rejected' ? rejected.reason : null,
          ).toMatchObject({ response: { code: 'VERSION_CONFLICT' } });
        },
      );
      expect((await discussion.comments(owner, task.id)).items).toHaveLength(1);
      expect((await service.task(owner, task.id)).commentCount).toBe(1);
    },
  );

  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'serializes comment editing and deletion without resurrecting a deleted body',
    async () => {
      const project = await service.create(owner, createProject());
      const { task } = await service.createTask(
        owner,
        project.id,
        createTask(),
      );
      const comment = await discussion.create(owner, task.id, {
        body: 'Original',
        requestId: randomUUID(),
      });
      await withConcurrentService(
        async (_projects, _notifications, concurrent) => {
          const results = await Promise.allSettled([
            concurrent.update(owner, comment.commentId, {
              body: 'New version',
              expectedVersion: 1,
              requestId: randomUUID(),
            }),
            concurrent.delete(owner, comment.commentId, {
              expectedVersion: 1,
              requestId: randomUUID(),
            }),
          ]);
          expect(
            results.filter((result) => result.status === 'fulfilled'),
          ).toHaveLength(1);
          const final = await concurrent.comment(owner, comment.commentId);
          expect(final.version).toBe(2);
          expect(final.body).toBe(final.deletedAt ? null : 'New version');
          expect((await service.task(owner, task.id)).commentCount).toBe(
            final.deletedAt ? 0 : 1,
          );
        },
      );
    },
  );

  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'rechecks membership after waiting for the project lock',
    async () => {
      const { project } = await joinedProject();
      const { task } = await service.createTask(
        owner,
        project.id,
        createTask(),
      );
      const blocker = new pg.Client({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      await blocker.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT id FROM projects WHERE id = $1 FOR UPDATE',
          [project.id],
        );
        await withConcurrentService(
          async (_projects, _notifications, concurrent) => {
            const pending = concurrent
              .create(other, task.id, {
                body: 'Must not be committed',
                requestId: randomUUID(),
              })
              .then(
                (result) => result,
                (error: unknown) => error,
              );
            let waiting = false;
            for (let attempt = 0; attempt < 100; attempt++) {
              const state = await sql.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'SELECT id FROM projects WHERE id = %' LIMIT 1",
              );
              if (state.rows.length) {
                waiting = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            await blocker.query(
              "UPDATE project_members SET role = 'Viewer' WHERE project_id = $1 AND user_id = $2",
              [project.id, other],
            );
            await blocker.query('COMMIT');
            expect(waiting).toBe(true);
            expect(await pending).toMatchObject({ status: 403 });
          },
        );
      } finally {
        await blocker.query('ROLLBACK');
        await blocker.end();
      }
      expect((await discussion.comments(owner, task.id)).items).toEqual([]);
    },
  );
});

function actionForRevision(expectedBoardRevision: number) {
  return { expectedBoardRevision, requestId: randomUUID() };
}

async function withConcurrentService(
  work: (
    concurrent: ProjectsService,
    concurrentNotifications: NotificationsService,
    concurrentDiscussion: DiscussionService,
    concurrentFiles: FilesService,
    concurrentDatabase: Database,
  ) => Promise<void>,
) {
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 4,
  });
  const database = {
    pool,
    transaction: async (
      operation: (client: pg.PoolClient) => Promise<unknown>,
    ) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  } as unknown as Database;
  try {
    await work(
      new ProjectsService(database),
      new NotificationsService(database),
      new DiscussionService(database),
      new FilesService(database, storage),
      database,
    );
  } finally {
    await pool.end();
  }
}

describe('multi-connection PostgreSQL concurrency', () => {
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'serializes creation and project restoration at the last active slot',
    async () => {
      const project = await service.create(owner, createProject());
      await service.setProjectArchived(
        owner,
        project.id,
        true,
        await projectAction(project.id),
      );
      await service.create(owner, createProject());
      await service.create(owner, createProject());
      const input = await projectAction(project.id);
      await withConcurrentService(async (concurrent) => {
        const results = await Promise.allSettled([
          concurrent.create(owner, createProject()),
          concurrent.setProjectArchived(owner, project.id, false, input),
        ]);
        expect(
          results.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
        const rejected = results.find((result) => result.status === 'rejected');
        expect(
          rejected?.status === 'rejected' ? rejected.reason : null,
        ).toMatchObject({ response: { code: 'PROJECT_LIMIT_REACHED' } });
      });
      expect(
        (await service.list(owner)).items.filter(
          (project) => project.status === 'active',
        ),
      ).toHaveLength(3);
    },
  );
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'serializes transfer and creation against the new Owner quota without foreign-key deadlocks',
    async () => {
      const { project } = await joinedProject();
      await service.create(other, createProject());
      await service.create(other, createProject());
      const input = { ...(await projectAction(project.id)), memberId: other };
      await withConcurrentService(async (concurrent) => {
        const results = await Promise.allSettled([
          concurrent.transferOwnership(owner, project.id, input),
          concurrent.create(other, createProject()),
        ]);
        expect(
          results.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
        const rejected = results.find((result) => result.status === 'rejected');
        expect(
          rejected?.status === 'rejected' ? rejected.reason : null,
        ).toMatchObject({ response: { code: 'PROJECT_LIMIT_REACHED' } });
      });
      expect(
        (await service.list(other)).items.filter(
          (project) => project.status === 'active' && project.role === 'Owner',
        ),
      ).toHaveLength(3);
      expect(
        (await service.members(owner, project.id)).members.filter(
          (member) => member.role === 'Owner',
        ),
      ).toHaveLength(1);
    },
  );
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'allows only one concurrent task restoration into the 500th active slot',
    async () => {
      const { project } = await joinedProject();
      await fillTasks(project.id, 499);
      await fillTasks(project.id, 2, true);
      const archived = (await service.archivedTasks(owner, project.id)).items;
      await withConcurrentService(async (concurrent) => {
        const results = await Promise.allSettled(
          archived.map((task, index) =>
            concurrent.setTaskArchived(
              index ? other : owner,
              task.id,
              false,
              taskAction(task),
            ),
          ),
        );
        expect(
          results.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
        const rejected = results.find((result) => result.status === 'rejected');
        expect(
          rejected?.status === 'rejected' ? rejected.reason : null,
        ).toMatchObject({ response: { code: 'TASK_LIMIT_REACHED' } });
      });
      expect((await service.board(owner, project.id)).tasks).toHaveLength(500);
      expect(
        (await service.archivedTasks(other, project.id)).items,
      ).toHaveLength(1);
    },
  );
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'prevents duplicate ownership transfers while serializing content writes without deadlocks',
    async () => {
      const { project } = await joinedProject();
      const input = { ...(await projectAction(project.id)), memberId: other };
      await withConcurrentService(async (concurrent) => {
        const results = await Promise.allSettled([
          concurrent.transferOwnership(owner, project.id, input),
          concurrent.transferOwnership(owner, project.id, {
            ...input,
            requestId: randomUUID(),
          }),
          concurrent.createTask(other, project.id, {
            ...createTask(),
            assigneeId: owner,
          }),
        ]);
        expect(results[2]!.status).toBe('fulfilled');
        const transfers = results.slice(0, 2);
        // A task write may win the project lock, requiring an explicit transfer retry.
        const successes = transfers.filter(
          (result) => result.status === 'fulfilled',
        );
        expect(successes.length).toBeLessThanOrEqual(1);
        for (const result of transfers)
          if (result.status === 'rejected')
            expect([403, 409]).toContain(result.reason.status);
      });
      expect(
        (await service.members(owner, project.id)).members.filter(
          (member) => member.role === 'Owner',
        ),
      ).toHaveLength(1);
    },
  );
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'accepts one membership under simultaneous invitation requests',
    async () => {
      const project = await service.create(owner, createProject());
      const invitation = inviteInput();
      await service.createInvitation(owner, project.id, invitation);
      await withConcurrentService(async (concurrent) => {
        const results = await Promise.all([
          concurrent.acceptInvitation(localIdentities[1]!, {
            token: invitation.token,
            requestId: randomUUID(),
          }),
          concurrent.acceptInvitation(localIdentities[1]!, {
            token: invitation.token,
            requestId: randomUUID(),
          }),
        ]);
        expect(results.filter((result) => !result.alreadyJoined)).toHaveLength(
          1,
        );
      });
      expect((await service.members(owner, project.id)).members).toHaveLength(
        2,
      );
    },
  );
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'allows exactly one edit or move based on the same version',
    async () => {
      const { project } = await joinedProject();
      const { task } = await service.createTask(
        owner,
        project.id,
        createTask(),
      );
      await withConcurrentService(async (concurrent) => {
        const edited = await Promise.allSettled([
          concurrent.updateTask(owner, task.id, {
            ...editInput(task),
            title: 'Owner edit',
          }),
          concurrent.updateTask(other, task.id, {
            ...editInput(task),
            title: 'Editor edit',
          }),
        ]);
        expect(
          edited.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
        const rejected = edited.find((result) => result.status === 'rejected');
        expect(
          rejected?.status === 'rejected' ? rejected.reason : null,
        ).toMatchObject({ response: { code: 'VERSION_CONFLICT' } });
        const current = await service.task(owner, task.id);
        const board = await service.board(owner, project.id);
        const moved = await Promise.allSettled(
          ['in_progress', 'done'].map((status) =>
            concurrent.moveTask(owner, task.id, {
              expectedVersion: current.version,
              expectedBoardRevision: board.project.boardRevision,
              status: status as 'in_progress' | 'done',
              beforeTaskId: null,
              requestId: randomUUID(),
            }),
          ),
        );
        expect(
          moved.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
      });
      const board = await service.board(owner, project.id);
      expect(board.tasks).toHaveLength(1);
      expect(board.tasks[0]!.version).toBe(3);
    },
  );
});

describe('recipient-aware event delivery', () => {
  it('publishes only identifier hints to current members and acknowledges each recipient once', async () => {
    const { project } = await joinedProject();
    await service.createTask(owner, project.id, createTask());
    const hints: { userId: string; hint: EventHint }[] = [];
    const dispatcher = new DispatcherService(database, {
      async publish(userId, hint) {
        hints.push({ userId, hint });
      },
    });
    await dispatcher.tick();
    expect(new Set(hints.map((item) => item.userId))).toEqual(
      new Set([owner, other]),
    );
    expect(hints).toHaveLength(8);
    expect(Object.keys(hints[0]!.hint).sort()).toEqual(
      [
        'eventId',
        'eventType',
        'projectId',
        'entityId',
        'entityVersion',
        'boardRevision',
        'occurredAt',
      ].sort(),
    );
    expect(
      (
        await sql.query(
          "SELECT 1 FROM event_deliveries WHERE state <> 'delivered'",
        )
      ).rows,
    ).toEqual([]);
    await dispatcher.tick();
    expect(hints).toHaveLength(8);
  });

  it('preserves partial success and retries only failed recipients', async () => {
    await joinedProject();
    const published: string[] = [];
    let fail = true;
    const dispatcher = new DispatcherService(database, {
      async publish(userId) {
        if (fail && userId === other) throw new Error('Transport unavailable');
        published.push(userId);
      },
    });
    await dispatcher.tick();
    const delivered = published.length;
    expect(delivered).toBeGreaterThan(0);
    expect(
      (
        await sql.query(
          "SELECT 1 FROM event_deliveries WHERE state = 'pending'",
        )
      ).rows.length,
    ).toBeGreaterThan(0);
    fail = false;
    await sql.query(
      "UPDATE event_deliveries SET next_attempt_at = now() - interval '1 second'",
    );
    await dispatcher.tick();
    expect(published.slice(delivered).every((id) => id === other)).toBe(true);
    expect(
      (
        await sql.query(
          "SELECT 1 FROM outbox_events WHERE state <> 'delivered'",
        )
      ).rows,
    ).toEqual([]);
  });

  it('rechecks membership after a failed delivery and preserves failed events for manual retry', async () => {
    const { project } = await joinedProject();
    const published: string[] = [];
    const dispatcher = new DispatcherService(database, {
      async publish(userId) {
        if (userId === other) throw new Error('Unavailable');
        published.push(userId);
      },
    });
    await dispatcher.tick();
    await service.changeMember(owner, project.id, other, {
      requestId: randomUUID(),
    });
    await sql.query(
      "UPDATE event_deliveries SET next_attempt_at = now() - interval '1 second'",
    );
    await dispatcher.tick();
    expect(published).not.toContain(other);
    const failing = new DispatcherService(database, {
      async publish() {
        throw new Error('Unavailable');
      },
    });
    await service.createTask(owner, project.id, createTask());
    await failing.tick();
    await sql.query(
      "UPDATE event_deliveries SET first_failure_at = now() - interval '25 hours', next_attempt_at = now() - interval '1 second' WHERE state = 'pending'",
    );
    await failing.tick();
    expect(
      (await sql.query("SELECT 1 FROM event_deliveries WHERE state = 'failed'"))
        .rows.length,
    ).toBeGreaterThan(0);
    expect(
      (await sql.query("SELECT 1 FROM outbox_events WHERE state = 'failed'"))
        .rows.length,
    ).toBeGreaterThan(0);
  });

  it('recovers an expired lease and leaves an active lease to its current worker', async () => {
    await service.create(owner, createProject());
    const dispatcher = new DispatcherService(database, {
      async publish() {
        throw new Error('Retry later');
      },
    });
    await dispatcher.tick();
    await sql.query(
      "UPDATE event_deliveries SET next_attempt_at = now() - interval '1 second', lease_until = now() + interval '30 seconds', lease_token = $1",
      [randomUUID()],
    );
    let calls = 0;
    const recovered = new DispatcherService(database, {
      async publish() {
        calls++;
      },
    });
    await recovered.tick();
    expect(calls).toBe(0);
    await sql.query(
      "UPDATE event_deliveries SET lease_until = now() - interval '1 second'",
    );
    await recovered.tick();
    expect(calls).toBe(1);
  });
});

const fileInput = (
  originalName = 'notes.txt',
  sizeBytes = 5,
  mediaType: 'text/plain' | 'image/png' = 'text/plain',
) => ({ originalName, sizeBytes, mediaType, requestId: randomUUID() });
async function readyFile(userId: string, taskId: string, name = 'notes.txt') {
  const initialized = await files.initialize(userId, taskId, fileInput(name));
  await files.upload(
    userId,
    initialized.attachment.id,
    initialized.upload.token,
    Buffer.from('Hello'),
  );
  await files.complete(userId, initialized.attachment.id, {
    requestId: randomUUID(),
  });
  return initialized.attachment;
}
describe('private attachment lifecycle', () => {
  it('reserves once, validates uploaded bytes, serves authorized short-lived downloads, and counts ready files', async () => {
    const { project } = await joinedProject();
    const { task } = await service.createTask(owner, project.id, createTask());
    const input = fileInput('\u9879\u76ee.txt');
    const reservation = await files.initialize(other, task.id, input);
    const replay = await files.initialize(other, task.id, input);
    expect(replay.attachment.id).toBe(reservation.attachment.id);
    expect((await files.list(owner, task.id)).items).toEqual([]);
    expect((await service.task(owner, task.id)).attachmentCount).toBe(0);
    await expect(
      files.complete(other, reservation.attachment.id, {
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'UPLOAD_NOT_READY' } });
    await files.upload(
      other,
      reservation.attachment.id,
      reservation.upload.token,
      Buffer.from('Hello'),
    );
    const complete = { requestId: randomUUID() };
    expect(
      await files.complete(other, reservation.attachment.id, complete),
    ).toMatchObject({ state: 'ready' });
    await files.complete(other, reservation.attachment.id, complete);
    expect((await service.task(owner, task.id)).attachmentCount).toBe(1);
    expect((await files.list(owner, task.id)).items[0]).toMatchObject({
      originalName: '\u9879\u76ee.txt',
      uploaderId: other,
      uploaderActive: true,
    });
    const link = await files.download(owner, reservation.attachment.id);
    expect(new Date(link.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(
      60000,
    );
    expect(
      (await files.downloaded(link.url.split('/').at(-1)!)).body.toString(),
    ).toBe('Hello');
    const history = await discussion.activity(owner, project.id, task.id);
    expect(
      history.items
        .map((item) => item.action)
        .filter((action) => action === 'attachment.created'),
    ).toHaveLength(1);
    expect(JSON.stringify(history)).not.toContain(reservation.upload.token);
    expect(
      JSON.stringify(
        (await sql.query('SELECT result FROM idempotency_records')).rows,
      ),
    ).not.toContain(reservation.upload.token);
  });
  it('rejects oversized, mismatched, tampered, expired, and cross-upload authorizations', async () => {
    const project = await service.create(owner, createProject());
    const { task } = await service.createTask(owner, project.id, createTask());
    const first = await files.initialize(owner, task.id, fileInput());
    const second = await files.initialize(
      owner,
      task.id,
      fileInput('other.txt'),
    );
    await expect(
      files.upload(
        owner,
        first.attachment.id,
        first.upload.token,
        Buffer.from('Too long'),
      ),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      files.upload(
        owner,
        first.attachment.id,
        first.upload.token,
        Buffer.from('Hi'),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      files.upload(
        owner,
        second.attachment.id,
        first.upload.token,
        Buffer.from('Hello'),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      files.upload(
        owner,
        first.attachment.id,
        first.upload.token + 'x',
        Buffer.from('Hello'),
      ),
    ).rejects.toMatchObject({ status: 401 });
    const expired = await storage.sign({
      purpose: 'upload',
      id: first.attachment.id,
      userId: owner,
      expiresAt: Date.now() - 1,
    });
    await expect(
      files.upload(owner, first.attachment.id, expired, Buffer.from('Hello')),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      files.initialize(owner, task.id, fileInput('../secret.txt')),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      files.initialize(owner, task.id, fileInput('fake.pdf')),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('validates actual content, rejects disguised images, and releases rejected storage', async () => {
    const project = await service.create(owner, createProject());
    const { task } = await service.createTask(owner, project.id, createTask());
    const reservation = await files.initialize(
      owner,
      task.id,
      fileInput('fake.png', 5, 'image/png'),
    );
    await files.upload(
      owner,
      reservation.attachment.id,
      reservation.upload.token,
      Buffer.from('Hello'),
    );
    await expect(
      files.complete(owner, reservation.attachment.id, {
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_FILE' } });
    expect(
      (
        await sql.query('SELECT state FROM attachments WHERE id = $1', [
          reservation.attachment.id,
        ])
      ).rows[0]!.state,
    ).toBe('rejected');
    expect((await files.list(owner, task.id)).items).toEqual([]);
    await files.cleanup();
    expect(
      (
        await sql.query(
          'SELECT object_removed_at FROM attachments WHERE id = $1',
          [reservation.attachment.id],
        )
      ).rows[0]!.object_removed_at,
    ).not.toBeNull();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgZGL+DwABFAEG1rmmRQAAAABJRU5ErkJggg==',
      'base64',
    );
    const valid = await files.initialize(
      owner,
      task.id,
      fileInput('pixel.png', png.length, 'image/png'),
    );
    await files.upload(owner, valid.attachment.id, valid.upload.token, png);
    // The fixture's chunk checksums, not its filename, determine acceptance.
    const { validateFile } =
      await import('../../apps/api/src/modules/files/validate-file');
    expect(validateFile(Buffer.from('binary\0data'), 'text/plain')).toBe(false);
    expect(
      validateFile(
        Buffer.from('%PDF-1.7\n1 0 obj\nendobj\n%%EOF\n'),
        'application/pdf',
      ),
    ).toBe(true);
    expect(validateFile(png.subarray(0, 24), 'image/png')).toBe(false);
    expect(validateFile(png, 'image/png')).toBe(true);
    await files.complete(owner, valid.attachment.id, {
      requestId: randomUUID(),
    });
  });
  it('counts unexpired reservations against task slots and project bytes and releases expiry exactly once', async () => {
    const project = await service.create(owner, createProject());
    const { task } = await service.createTask(owner, project.id, createTask());
    for (let index = 0; index < 5; index++)
      await files.initialize(owner, task.id, fileInput());
    await expect(
      files.initialize(owner, task.id, fileInput()),
    ).rejects.toMatchObject({
      response: {
        code: 'ATTACHMENT_LIMIT_REACHED',
        quota: { used: 5, limit: 5 },
      },
    });
    await sql.query(
      "UPDATE attachments SET expires_at = now() - interval '1 second'",
    );
    await files.initialize(owner, task.id, fileInput());
    await files.cleanup();
    await files.cleanup();
    expect(
      (await sql.query("SELECT 1 FROM attachments WHERE state = 'expired'"))
        .rows,
    ).toHaveLength(5);
    await sql.query(
      "UPDATE attachments SET expires_at = now() - interval '1 second' WHERE state = 'pending'",
    );
    await files.cleanup();
    const tasks = [];
    for (let index = 0; index < 2; index++)
      tasks.push(
        (await service.createTask(owner, project.id, createTask())).task,
      );
    for (const target of tasks)
      for (let index = 0; index < 5; index++)
        await files.initialize(
          owner,
          target.id,
          fileInput('large.txt', 10 * 1024 * 1024),
        );
    await expect(
      files.initialize(owner, task.id, fileInput()),
    ).rejects.toMatchObject({ response: { code: 'STORAGE_LIMIT_REACHED' } });
  });
  it('enforces author and Owner deletion, current permissions at completion, and archived read access', async () => {
    const { project } = await joinedProject();
    const { task } = await service.createTask(owner, project.id, createTask());
    const owned = await readyFile(owner, task.id);
    await expect(
      files.delete(other, owned.id, { requestId: randomUUID() }),
    ).rejects.toMatchObject({ status: 403 });
    const theirs = await readyFile(other, task.id, 'editor.txt');
    const link = await files.download(other, theirs.id);
    await service.setTaskArchived(owner, task.id, true, {
      expectedVersion: 1,
      requestId: randomUUID(),
    });
    await expect(
      files.initialize(other, task.id, fileInput()),
    ).rejects.toMatchObject({ response: { code: 'TASK_ARCHIVED' } });
    expect((await files.list(other, task.id)).items).toHaveLength(2);
    await files.delete(owner, theirs.id, { requestId: randomUUID() });
    await expect(
      files.downloaded(link.url.split('/').at(-1)!),
    ).rejects.toMatchObject({ status: 404 });
    const board = await service.board(owner, project.id);
    await service.setProjectArchived(owner, project.id, true, {
      expectedBoardRevision: board.project.boardRevision,
      requestId: randomUUID(),
    });
    await expect(
      files.delete(owner, owned.id, { requestId: randomUUID() }),
    ).rejects.toMatchObject({ response: { code: 'PROJECT_ARCHIVED' } });
  });
  it('denies removed members and downgraded upload completion without trusting an old grant', async () => {
    const { project } = await joinedProject();
    const { task } = await service.createTask(owner, project.id, createTask());
    const pending = await files.initialize(other, task.id, fileInput());
    await files.upload(
      other,
      pending.attachment.id,
      pending.upload.token,
      Buffer.from('Hello'),
    );
    await service.changeMember(owner, project.id, other, {
      role: 'Viewer',
      requestId: randomUUID(),
    });
    await expect(
      files.complete(other, pending.attachment.id, { requestId: randomUUID() }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      files.upload(
        other,
        pending.attachment.id,
        pending.upload.token,
        Buffer.from('Hello'),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await service.changeMember(owner, project.id, other, {
      requestId: randomUUID(),
    });
    await expect(files.list(other, task.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      files.initialize(other, task.id, fileInput()),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('rolls back readiness and revision when attachment outbox persistence fails', async () => {
    const project = await service.create(owner, createProject());
    const { task } = await service.createTask(owner, project.id, createTask());
    const reservation = await files.initialize(owner, task.id, fileInput());
    await files.upload(
      owner,
      reservation.attachment.id,
      reservation.upload.token,
      Buffer.from('Hello'),
    );
    await sql.query(
      "ALTER TABLE outbox_events ADD CONSTRAINT reject_files CHECK (event_type NOT LIKE 'attachment.%') NOT VALID",
    );
    try {
      await expect(
        files.complete(owner, reservation.attachment.id, {
          requestId: randomUUID(),
        }),
      ).rejects.toThrow();
    } finally {
      await sql.query('ALTER TABLE outbox_events DROP CONSTRAINT reject_files');
    }
    expect((await service.task(owner, task.id)).attachmentCount).toBe(0);
    expect((await service.board(owner, project.id)).project.boardRevision).toBe(
      1,
    );
    expect(
      (
        await sql.query('SELECT state FROM attachments WHERE id = $1', [
          reservation.attachment.id,
        ])
      ).rows[0]!.state,
    ).toBe('pending');
  });
});

describe('sample projects and distributed rate limits', () => {
  it('creates a permanent private project from the sample with ordinary quotas and idempotent retries', async () => {
    const input = { ...createProject(), fromSample: true };
    const project = await service.create(owner, input);
    expect(await service.create(owner, input)).toEqual(project);
    expect((await service.invitations(owner, project.id)).items).toHaveLength(
      3,
    );
    const board = await service.board(owner, project.id);
    expect(board.tasks).toHaveLength(10);
    expect(
      board.tasks.every(
        (task) => task.projectId === project.id && task.attachmentCount === 0,
      ),
    ).toBe(true);
    expect(board.tasks.some((task) => task.commentCount > 0)).toBe(true);
    await expect(service.board(other, project.id)).rejects.toMatchObject({
      status: 404,
    });
    await sql.query(
      "UPDATE projects SET created_at = now() - interval '30 days' WHERE id = $1",
      [project.id],
    );
    await new MaintenanceService(database, files, storage).tick();
    expect((await service.board(owner, project.id)).tasks).toHaveLength(10);
    await service.create(owner, createProject());
    await service.create(owner, createProject());
    await expect(
      service.create(owner, { ...createProject(), fromSample: true }),
    ).rejects.toMatchObject({ response: { code: 'PROJECT_LIMIT_REACHED' } });
  });
  it('uses database counters across callers, separates users and buckets, and provides retry guidance', async () => {
    await consumeRate(database, owner, [{ name: 'test', limit: 2 }]);
    await consumeRate(database, owner, [{ name: 'test', limit: 2 }]);
    await expect(
      consumeRate(database, owner, [{ name: 'test', limit: 2 }]),
    ).rejects.toMatchObject({
      status: 429,
      response: { code: 'RATE_LIMITED', retryAfterSeconds: 60 },
    });
    await consumeRate(database, other, [{ name: 'test', limit: 2 }]);
    await consumeRate(database, owner, [{ name: 'uploads', limit: 1 }]);
    await expect(
      consumeRate(database, owner, [
        { name: 'writes', limit: 60 },
        { name: 'uploads', limit: 1 },
      ]),
    ).rejects.toMatchObject({ status: 429 });
    expect(
      (await sql.query("SELECT 1 FROM rate_limits WHERE bucket = 'writes'"))
        .rows,
    ).toEqual([]);
  });
});

describe('scheduled maintenance', () => {
  it('removes expired history and queued or orphaned files while retaining ready files and failed events', async () => {
    const { project } = await joinedProject();
    const firstInput = { ...createTask(), assigneeId: other };
    const { task } = await service.createTask(owner, project.id, firstInput);
    await service.createTask(owner, project.id, {
      ...createTask(),
      assigneeId: other,
    });
    const kept = await readyFile(owner, task.id, 'kept.txt');
    const deleted = await readyFile(owner, task.id, 'deleted.txt');
    const key = async (id: string) =>
      String(
        (
          await sql.query('SELECT object_key FROM attachments WHERE id = $1', [
            id,
          ])
        ).rows[0]!.object_key,
      );
    const keptKey = await key(kept.id);
    const deletedKey = await key(deleted.id);
    await files.delete(owner, deleted.id, { requestId: randomUUID() });
    const orphanKey = `${randomUUID()}/${randomUUID()}/${randomUUID()}`;
    const queuedKey = `${randomUUID()}/${randomUUID()}/${randomUUID()}`;
    await storage.put(orphanKey, Buffer.from('orphan'));
    await storage.put(queuedKey, Buffer.from('queued'));
    const old = new Date(Date.now() - 16 * 60000);
    await utimes(join(storageRoot, orphanKey), old, old);
    await utimes(join(storageRoot, keptKey), old, old);
    await sql.query('INSERT INTO object_cleanup(object_key) VALUES ($1)', [
      queuedKey,
    ]);
    await sql.query(
      "UPDATE notifications SET created_at = now() - interval '31 days' WHERE task_id = $1",
      [task.id],
    );
    await sql.query(
      "UPDATE activity SET created_at = now() - interval '91 days'",
    );
    await sql.query(
      'UPDATE activity SET created_at = now() WHERE id = (SELECT id FROM activity LIMIT 1)',
    );
    await sql.query(
      "UPDATE outbox_events SET state = 'delivered', created_at = now() - interval '8 days'",
    );
    await sql.query(
      "UPDATE outbox_events SET state = 'failed' WHERE event_id = (SELECT event_id FROM outbox_events LIMIT 1)",
    );
    await sql.query(
      "UPDATE idempotency_records SET expires_at = now() - interval '1 second' WHERE request_id = $1",
      [firstInput.requestId],
    );
    await consumeRate(database, owner, [{ name: 'current', limit: 60 }]);
    await sql.query(
      "INSERT INTO rate_limits(subject,bucket,window_start,used) VALUES ($1,'old',now() - interval '3 days',1)",
      [owner],
    );

    const maintenance = new MaintenanceService(database, files, storage);
    await maintenance.tick();
    await maintenance.tick();
    expect((await storage.get(keptKey)).toString()).toBe('Hello');
    for (const removed of [deletedKey, orphanKey, queuedKey])
      await expect(storage.get(removed)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    expect((await sql.query('SELECT 1 FROM object_cleanup')).rows).toEqual([]);
    expect((await notifications.list(other)).items).toHaveLength(1);
    expect((await sql.query('SELECT 1 FROM activity')).rows).toHaveLength(1);
    expect((await sql.query('SELECT state FROM outbox_events')).rows).toEqual([
      { state: 'failed' },
    ]);
    expect(
      (
        await sql.query(
          'SELECT 1 FROM idempotency_records WHERE request_id = $1',
          [firstInput.requestId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (await sql.query('SELECT 1 FROM idempotency_records')).rows.length,
    ).toBeGreaterThan(0);
    expect((await sql.query('SELECT bucket FROM rate_limits')).rows).toEqual([
      { bucket: 'current' },
    ]);
    expect(
      (await files.list(owner, task.id)).items.map((item) => item.id),
    ).toEqual([kept.id]);
  });
});

describe('concurrent resource limits and dispatch leases', () => {
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'reserves exactly five attachment slots under concurrent initialization',
    async () => {
      const project = await service.create(owner, createProject());
      const { task } = await service.createTask(
        owner,
        project.id,
        createTask(),
      );
      await withConcurrentService(async (_p, _n, _d, concurrentFiles) => {
        const result = await Promise.allSettled(
          Array.from({ length: 6 }, () =>
            concurrentFiles.initialize(owner, task.id, fileInput()),
          ),
        );
        expect(
          result.filter((item) => item.status === 'fulfilled'),
        ).toHaveLength(5);
        expect(result.find((item) => item.status === 'rejected')).toMatchObject(
          { reason: { response: { code: 'ATTACHMENT_LIMIT_REACHED' } } },
        );
      });
    },
  );
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'enforces a shared rate counter under competing connections',
    async () => {
      await withConcurrentService(
        async (_p, _n, _d, _f, concurrentDatabase) => {
          const results = await Promise.allSettled(
            Array.from({ length: 20 }, () =>
              consumeRate(concurrentDatabase, owner, [
                { name: 'shared', limit: 10 },
              ]),
            ),
          );
          expect(
            results.filter((result) => result.status === 'fulfilled'),
          ).toHaveLength(10);
          expect(
            (
              await sql.query(
                "SELECT used FROM rate_limits WHERE bucket = 'shared'",
              )
            ).rows[0]!.used,
          ).toBe(10);
        },
      );
    },
  );
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'prevents two workers from publishing the same recipient lease concurrently',
    async () => {
      await joinedProject();
      await withConcurrentService(
        async (_p, _n, _d, _f, concurrentDatabase) => {
          const published: string[] = [];
          const transport = {
            async publish(userId: string, hint: EventHint) {
              await new Promise((resolve) => setTimeout(resolve, 10));
              published.push(`${userId}:${hint.eventId}`);
            },
          };
          await Promise.all([
            new DispatcherService(concurrentDatabase, transport).tick(),
            new DispatcherService(concurrentDatabase, transport).tick(),
          ]);
          expect(published.length).toBeGreaterThan(0);
          expect(new Set(published).size).toBe(published.length);
          expect(
            (
              await sql.query(
                "SELECT 1 FROM event_deliveries WHERE state = 'pending'",
              )
            ).rows,
          ).toEqual([]);
        },
      );
    },
  );
});
