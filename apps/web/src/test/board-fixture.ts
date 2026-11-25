import type { Project, Task } from '@collabboard/contracts';
export const project: Project = {
  id: 'launch',
  name: 'Launch',
  description: '',
  status: 'active',
  role: 'Editor',
  boardRevision: 1,
  createdAt: '2026-01-01T00:00:00Z',
};
export const task: Task = {
  id: 'copy',
  projectId: project.id,
  title: 'Review launch copy',
  description: '',
  status: 'todo',
  priority: 'high',
  position: 0,
  version: 1,
  dueDate: null,
  assigneeName: null,
  assigneeId: null,
  commentCount: 0,
  attachmentCount: 0,
  archivedAt: null,
};
