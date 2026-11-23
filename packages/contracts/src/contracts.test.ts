import { describe, expect, it } from 'vitest';
import {
  createProjectSchema,
  createTaskSchema,
  createInvitationSchema,
  moveTaskSchema,
  projectCapabilities,
  roles,
  projectActionSchema,
  transferOwnershipSchema,
  taskActionSchema,
  paginationQuerySchema,
  apiErrorSchema,
  createCommentSchema,
  updateCommentSchema,
  commentCapabilities,
} from './index';

const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
describe('transport validation', () => {
  it('validates comment Unicode limits, blank text, and expected versions', () => {
    expect(
      createCommentSchema.parse({ body: '  Discussion  ', requestId }).body,
    ).toBe('Discussion');
    expect(
      createCommentSchema.safeParse({ body: '🚀'.repeat(2000), requestId })
        .success,
    ).toBe(true);
    for (const body of ['', ' \n ', '🚀'.repeat(2001)])
      expect(createCommentSchema.safeParse({ body, requestId }).success).toBe(
        false,
      );
    expect(
      updateCommentSchema.safeParse({ body: 'Changed', requestId }).success,
    ).toBe(false);
    expect(
      updateCommentSchema.safeParse({
        body: 'Changed',
        requestId,
        expectedVersion: 0,
      }).success,
    ).toBe(false);
  });
  it('defaults list sizes, accepts explicit sizes, and rejects ambiguous or excessive query values', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(paginationQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    expect(paginationQuerySchema.parse({ limit: '1' }).limit).toBe(1);
    for (const limit of [
      '',
      '0',
      '-1',
      '101',
      '1.5',
      '1e2',
      '0x10',
      ' 20',
      '020',
      ['20', '30'],
      {},
      null,
      true,
    ])
      expect(paginationQuerySchema.safeParse({ limit }).success).toBe(false);
    for (const cursor of ['', 'x'.repeat(513), 'invalid!', ['one', 'two'], {}])
      expect(paginationQuerySchema.safeParse({ cursor }).success).toBe(false);
  });
  it('requires known quota resources and nonnegative integral usage', () => {
    const error = {
      code: 'TASK_LIMIT_REACHED',
      message: 'Archive a task first.',
      requestId,
      quota: { resource: 'activeTasks', used: 500, limit: 500 },
    };
    expect(apiErrorSchema.safeParse(error).success).toBe(true);
    for (const quota of [
      { ...error.quota, resource: 'unknown' },
      { ...error.quota, used: -1 },
      { ...error.quota, used: 0.5 },
      { ...error.quota, limit: 0 },
    ])
      expect(apiErrorSchema.safeParse({ ...error, quota }).success).toBe(false);
  });
  it('requires project revisions, task versions, and a valid ownership target', () => {
    expect(projectActionSchema.safeParse({ requestId }).success).toBe(false);
    expect(
      projectActionSchema.safeParse({ requestId, expectedBoardRevision: -1 })
        .success,
    ).toBe(false);
    expect(
      projectActionSchema.safeParse({ requestId, expectedBoardRevision: 0 })
        .success,
    ).toBe(true);
    expect(
      taskActionSchema.safeParse({ requestId, expectedVersion: 0 }).success,
    ).toBe(false);
    expect(
      transferOwnershipSchema.safeParse({
        requestId,
        expectedBoardRevision: 0,
        memberId: 'invalid',
      }).success,
    ).toBe(false);
  });
  it('counts Unicode code points rather than UTF-16 units', () => {
    expect(
      createProjectSchema.safeParse({ name: '🚀'.repeat(80), requestId })
        .success,
    ).toBe(true);
    expect(
      createProjectSchema.safeParse({ name: '🚀'.repeat(81), requestId })
        .success,
    ).toBe(false);
  });
  it('rejects blank titles, invalid dates, unknown priorities, and missing request IDs', () => {
    for (const values of [
      { title: ' ' },
      { title: 'Launch', dueDate: '2026-02-30' },
      { title: 'Launch', priority: 'urgent' },
    ]) {
      expect(createTaskSchema.safeParse({ ...values, requestId }).success).toBe(
        false,
      );
    }
    expect(createTaskSchema.safeParse({ title: 'Launch' }).success).toBe(false);
  });
  it('normalizes text and applies the agreed defaults', () => {
    expect(
      createTaskSchema.parse({ title: '  Launch  ', requestId }),
    ).toMatchObject({
      title: 'Launch',
      status: 'todo',
      priority: 'medium',
      dueDate: null,
    });
  });
  it('validates invitation credentials and roles and requires movement versions', () => {
    const invitation = {
      email: 'JAMIE@example.com',
      role: 'Editor',
      token: 'a'.repeat(64),
      requestId,
    };
    expect(createInvitationSchema.parse(invitation).email).toBe(
      'jamie@example.com',
    );
    expect(
      createInvitationSchema.safeParse({ ...invitation, role: 'Owner' })
        .success,
    ).toBe(false);
    expect(
      createInvitationSchema.safeParse({ ...invitation, token: 'short' })
        .success,
    ).toBe(false);
    expect(
      moveTaskSchema.safeParse({ requestId, status: 'done' }).success,
    ).toBe(false);
    expect(
      moveTaskSchema.safeParse({
        requestId,
        status: 'done',
        expectedVersion: 1,
        expectedBoardRevision: 0,
      }).success,
    ).toBe(true);
  });
});
describe('resource capabilities', () => {
  it('permits deletion on archived tasks while enforcing authorship, Owner moderation, and project state', () => {
    expect(commentCapabilities('Editor', 'active', false, true, false)).toEqual(
      { canEdit: true, canDelete: true },
    );
    expect(commentCapabilities('Owner', 'active', false, false, false)).toEqual(
      { canEdit: false, canDelete: true },
    );
    expect(
      commentCapabilities('Editor', 'active', false, false, false),
    ).toEqual({ canEdit: false, canDelete: false });
    expect(commentCapabilities('Editor', 'active', true, true, false)).toEqual({
      canEdit: false,
      canDelete: true,
    });
    for (const args of [
      ['Viewer', 'active', false, true, false, true],
      ['Owner', 'archived', false, true, false, true],
      ['Owner', 'expired', false, true, false, true],
      ['Owner', 'active', false, true, true, true],
      ['Owner', 'active', false, true, false, false],
    ] as const)
      expect(
        commentCapabilities(
          args[0],
          args[1],
          args[2],
          args[3],
          args[4],
          args[5],
        ),
      ).toEqual({
        canEdit: false,
        canDelete: false,
      });
  });
  it('reserves project management for active Owners and permits non-Owner departure while archived', () => {
    expect(projectCapabilities('Owner', 'active').canManageProject).toBe(true);
    expect(projectCapabilities('Owner', 'active').canLeaveProject).toBe(false);
    for (const role of roles) {
      expect(projectCapabilities(role, 'archived').canManageProject).toBe(
        false,
      );
      expect(projectCapabilities(role, 'expired').canLeaveProject).toBe(false);
      expect(
        projectCapabilities(role, 'active', false, false).canManageProject,
      ).toBe(false);
    }
    for (const role of ['Editor', 'Viewer'] as const) {
      expect(projectCapabilities(role, 'active').canManageProject).toBe(false);
      expect(projectCapabilities(role, 'archived').canLeaveProject).toBe(true);
      expect(
        projectCapabilities(role, 'archived', false, false).canLeaveProject,
      ).toBe(false);
    }
  });
  it('prevents Viewer, non-member, archived, expired, and offline task writes', () => {
    expect(projectCapabilities('Viewer', 'active').canCreateTask).toBe(false);
    expect(projectCapabilities(null, 'active').canRead).toBe(false);
    for (const role of roles) {
      expect(projectCapabilities(role, 'archived').canEditTask).toBe(false);
      expect(projectCapabilities(role, 'expired').canRead).toBe(false);
      expect(
        projectCapabilities(role, 'active', false, false).canCreateTask,
      ).toBe(false);
    }
  });
  it('permits restoring archived tasks and projects under the correct roles', () => {
    expect(projectCapabilities('Editor', 'active', true)).toMatchObject({
      canEditTask: false,
      canRestoreTask: true,
      canAddComment: false,
      canUploadAttachment: false,
    });
    expect(projectCapabilities('Owner', 'archived').canRestoreProject).toBe(
      true,
    );
    expect(projectCapabilities('Editor', 'archived').canRestoreProject).toBe(
      false,
    );
  });
});
