import { describe, expect, it } from 'vitest';
import {
  createProjectSchema,
  createTaskSchema,
  projectCapabilities,
  roles,
} from './index';

const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
describe('transport validation', () => {
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
});
describe('resource capabilities', () => {
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
