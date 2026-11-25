import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  sql,
  service,
  database,
  owner,
  other,
  createProject,
  createTask,
  inviteInput,
  joinedProject,
} from './database-fixture';
import { localIdentities } from '../../apps/api/src/adapters/identity/local-identities';

describe('transactional foundation', () => {
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'rolls back a successful statement on application error and reuses the released connection',
    async () => {
      let failedConnection: number | undefined;
      const failure = new Error('Transaction cancelled');
      await expect(
        database.transaction(async (client) => {
          const result = await client.query<{ pid: number }>(
            'UPDATE users SET display_name = $1 WHERE id = $2 RETURNING pg_backend_pid() AS pid',
            ['Uncommitted name', owner],
          );
          failedConnection = result.rows[0]!.pid;
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(database.pool.idleCount).toBe(database.pool.totalCount);
      const result = await database.transaction((client) =>
        client.query(
          'SELECT display_name, pg_backend_pid() AS pid FROM users WHERE id = $1',
          [owner],
        ),
      );
      expect(result.rows).toEqual([
        {
          display_name: localIdentities[0]!.displayName,
          pid: failedConnection,
        },
      ]);
    },
  );
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
