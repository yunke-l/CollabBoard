import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  sql,
  service,
  owner,
  other,
  createTask,
  joinedProject,
  editInput,
} from './database-fixture';

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
