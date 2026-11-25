import { randomUUID, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  sql,
  service,
  database,
  files,
  storage,
  owner,
  other,
  createProject,
  createTask,
  inviteInput,
  joinedProject,
  projectAction,
  taskAction,
  fillTasks,
} from './database-fixture';
import { consumeRate } from '../../apps/api/src/platform/http/rate-limit';
import { MaintenanceService } from '../../apps/api/src/platform/jobs/maintenance.service';

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
