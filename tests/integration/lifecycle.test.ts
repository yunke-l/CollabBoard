import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  sql,
  service,
  owner,
  other,
  createProject,
  createTask,
  inviteInput,
  joinedProject,
  editInput,
  projectAction,
  taskAction,
  fillTasks,
  actionForRevision,
} from './database-fixture';
import { localIdentities } from '../../apps/api/src/adapters/identity/local-identities';

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
