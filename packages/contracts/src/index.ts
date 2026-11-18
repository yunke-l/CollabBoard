import { z } from 'zod';

export const roles = ['Owner', 'Editor', 'Viewer'] as const;
export const taskStatuses = ['todo', 'in_progress', 'done'] as const;
export const priorities = ['low', 'medium', 'high'] as const;
export const statusLabels = {
  todo: 'To Do',
  in_progress: 'In Progress',
  done: 'Done',
} as const;
export type Role = (typeof roles)[number];
export type TaskStatus = (typeof taskStatuses)[number];
export type Priority = (typeof priorities)[number];

export const limits = {
  displayName: 40,
  projectName: 80,
  projectDescription: 1000,
  taskTitle: 120,
  taskDescription: 10000,
  comment: 2000,
  filename: 120,
  activeProjects: 3,
  totalProjects: 10,
  activeTrials: 1,
  members: 10,
  activeTasks: 500,
  totalTasks: 2000,
  attachmentsPerTask: 5,
  attachmentBytes: 10 * 1024 * 1024,
  projectStorageBytes: 100 * 1024 * 1024,
} as const;

const text = (maximum: number, label: string, required = false) =>
  z
    .string()
    .trim()
    .refine(
      (value) => !required || Array.from(value).length > 0,
      `${label} is required.`,
    )
    .refine(
      (value) => Array.from(value).length <= maximum,
      `${label} must contain at most ${maximum} characters.`,
    );

export const mutationSchema = z.object({ requestId: z.uuid() });
export const createProjectSchema = mutationSchema.extend({
  name: text(limits.projectName, 'Project name', true),
  description: text(limits.projectDescription, 'Description').default(''),
});
export const createTaskSchema = mutationSchema.extend({
  title: text(limits.taskTitle, 'Task title', true),
  description: text(limits.taskDescription, 'Description').default(''),
  status: z.enum(taskStatuses).default('todo'),
  priority: z.enum(priorities).default('medium'),
  dueDate: z.iso.date().nullable().default(null),
});
export const updateTaskSchema = mutationSchema.extend({
  expectedVersion: z.number().int().positive(),
  title: text(limits.taskTitle, 'Task title', true),
  description: text(limits.taskDescription, 'Description'),
  priority: z.enum(priorities),
  dueDate: z.iso.date().nullable(),
});
export const moveTaskSchema = mutationSchema.extend({
  expectedVersion: z.number().int().positive(),
  expectedBoardRevision: z.number().int().nonnegative(),
  status: z.enum(taskStatuses),
  beforeTaskId: z.uuid().nullable().default(null),
});
export type CreateProject = z.infer<typeof createProjectSchema>;
export type CreateTask = z.infer<typeof createTaskSchema>;

export interface User {
  id: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
}
export interface Project {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'archived' | 'expired';
  role: Role;
  boardRevision: number;
  createdAt: string;
}
export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  position: number;
  version: number;
  dueDate: string | null;
  assigneeName: string | null;
  commentCount: number;
  attachmentCount: number;
  archivedAt: string | null;
}
export interface BoardSnapshot {
  project: Project;
  tasks: Task[];
}
export interface EventHint {
  eventId: string;
  eventType: string;
  projectId: string;
  entityId: string;
  entityVersion: number;
  boardRevision: number;
  occurredAt: string;
}
export interface ApiErrorBody {
  code: string;
  message: string;
  requestId: string;
  fieldErrors?: Record<string, string[]>;
}
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export function projectCapabilities(
  role: Role | null,
  state: Project['status'],
  taskArchived = false,
  online = true,
) {
  const active = state === 'active';
  const write = online && active && (role === 'Owner' || role === 'Editor');
  return {
    canRead: role !== null && state !== 'expired',
    canCreateTask: write,
    canEditTask: write && !taskArchived,
    canMoveTask: write && !taskArchived,
    canRestoreTask: write && taskArchived,
    canAddComment: write && !taskArchived,
    canUploadAttachment: write && !taskArchived,
    canManageMembers: online && active && role === 'Owner',
    canRestoreProject: online && state === 'archived' && role === 'Owner',
  };
}
