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
  members: 10,
  activeTasks: 500,
  totalTasks: 2000,
  attachmentsPerTask: 5,
  attachmentBytes: 10 * 1024 * 1024,
  projectStorageBytes: 100 * 1024 * 1024,
} as const;

export const pagination = { defaultLimit: 20, maxLimit: 100 } as const;
export const paginationQuerySchema = z.object({
  cursor: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  limit: z
    .union([
      z.number(),
      z
        .string()
        .regex(/^[1-9][0-9]*$/)
        .transform(Number),
    ])
    .pipe(z.number().int().min(1).max(pagination.maxLimit))
    .default(pagination.defaultLimit),
});

export const quotaSchema = z.object({
  resource: z.enum([
    'activeProjects',
    'totalProjects',
    'members',
    'activeTasks',
    'totalTasks',
    'attachmentsPerTask',
    'projectStorageBytes',
  ]),
  used: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});
export type Quota = z.infer<typeof quotaSchema>;
export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.string(),
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  quota: quotaSchema.optional(),
  retryAfterSeconds: z.number().int().positive().optional(),
});
export const quotaLabels: Record<Quota['resource'], string> = {
  activeProjects: 'active owned projects',
  totalProjects: 'total owned projects',
  members: 'project members',
  activeTasks: 'active tasks',
  totalTasks: 'total tasks',
  attachmentsPerTask: 'attachment slots',
  projectStorageBytes: 'bytes of project storage',
};

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

export const emailSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
});
const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(128, 'Use at most 128 characters.');
export const signUpSchema = emailSchema.extend({
  displayName: text(limits.displayName, 'Display name', true),
  password: passwordSchema,
});
export const signInSchema = emailSchema.extend({
  password: z.string().min(1).max(128),
});
export const verifyEmailSchema = emailSchema.extend({
  code: z.string().regex(/^[0-9]{6}$/, 'Enter the six-digit code.'),
});
export const resetPasswordSchema = verifyEmailSchema.extend({
  password: passwordSchema,
});
export interface AuthSession {
  user: User;
  accessToken: string;
  expiresAt: string;
}

export const mutationSchema = z.object({ requestId: z.uuid() });
export const createProjectSchema = mutationSchema.extend({
  fromSample: z.boolean().optional(),
  name: text(limits.projectName, 'Project name', true),
  description: text(limits.projectDescription, 'Description').default(''),
});
export const createTaskSchema = mutationSchema.extend({
  title: text(limits.taskTitle, 'Task title', true),
  description: text(limits.taskDescription, 'Description').default(''),
  status: z.enum(taskStatuses).default('todo'),
  priority: z.enum(priorities).default('medium'),
  dueDate: z.iso.date().nullable().default(null),
  assigneeId: z.uuid().nullable().default(null),
});
export const updateTaskSchema = mutationSchema.extend({
  expectedVersion: z.number().int().positive(),
  title: text(limits.taskTitle, 'Task title', true),
  description: text(limits.taskDescription, 'Description'),
  priority: z.enum(priorities),
  dueDate: z.iso.date().nullable(),
  assigneeId: z.uuid().nullable(),
});
export const invitationTokenSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'This invitation link is invalid.');
export const createInvitationSchema = mutationSchema.extend({
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  role: z.enum(['Editor', 'Viewer']),
  token: invitationTokenSchema,
});
export const invitationCredentialSchema = z.object({
  token: invitationTokenSchema,
});
export const acceptInvitationSchema = mutationSchema.extend({
  token: invitationTokenSchema,
});
export const changeRoleSchema = mutationSchema.extend({
  role: z.enum(['Editor', 'Viewer']),
});
export const projectActionSchema = mutationSchema.extend({
  expectedBoardRevision: z.number().int().nonnegative(),
});
export const updateProjectSchema = projectActionSchema.extend({
  name: text(limits.projectName, 'Project name', true),
  description: text(limits.projectDescription, 'Description'),
});
export const transferOwnershipSchema = projectActionSchema.extend({
  memberId: z.uuid(),
});
export const taskActionSchema = mutationSchema.extend({
  expectedVersion: z.number().int().positive(),
});
export const createCommentSchema = mutationSchema.extend({
  body: text(limits.comment, 'Comment', true),
});
export const updateCommentSchema = createCommentSchema.extend({
  expectedVersion: z.number().int().positive(),
});
export const commentActionSchema = taskActionSchema;
export const activityQuerySchema = paginationQuerySchema.extend({
  taskId: z.uuid().optional(),
});
export type CreateComment = z.infer<typeof createCommentSchema>;
export type UpdateComment = z.infer<typeof updateCommentSchema>;
export const mediaTypes = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'text/plain',
] as const;
export const initializeAttachmentSchema = mutationSchema.extend({
  originalName: text(limits.filename, 'Filename', true).refine(
    (value) => !/[\u0000-\u001f\u007f/\\]/u.test(value),
    'Use a filename without paths or control characters.',
  ),
  sizeBytes: z.number().int().min(1).max(limits.attachmentBytes),
  mediaType: z.enum(mediaTypes),
});
export type InitializeAttachment = z.infer<typeof initializeAttachmentSchema>;
export interface Attachment {
  id: string;
  projectId: string;
  taskId: string;
  uploaderId: string;
  uploaderName: string;
  uploaderActive: boolean;
  originalName: string;
  sizeBytes: number;
  mediaType: string;
  version: number;
  createdAt: string;
}
export interface UploadReservation {
  attachment: Attachment;
  upload: { path: string; token: string; expiresAt: string };
}
export const moveTaskSchema = mutationSchema.extend({
  expectedVersion: z.number().int().positive(),
  expectedBoardRevision: z.number().int().nonnegative(),
  status: z.enum(taskStatuses),
  beforeTaskId: z.uuid().nullable().default(null),
});
export type CreateProject = z.infer<typeof createProjectSchema>;
export type CreateTask = z.infer<typeof createTaskSchema>;
export type UpdateTask = z.infer<typeof updateTaskSchema>;
export type MoveTask = z.infer<typeof moveTaskSchema>;
export type CreateInvitation = z.infer<typeof createInvitationSchema>;
export type AcceptInvitation = z.infer<typeof acceptInvitationSchema>;
export type ChangeRole = z.infer<typeof changeRoleSchema>;
export type ProjectAction = z.infer<typeof projectActionSchema>;
export type UpdateProject = z.infer<typeof updateProjectSchema>;
export type TransferOwnership = z.infer<typeof transferOwnershipSchema>;
export type TaskAction = z.infer<typeof taskActionSchema>;

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
  assigneeId: string | null;
  commentCount: number;
  attachmentCount: number;
  archivedAt: string | null;
}
export interface ProjectMember {
  id: string;
  displayName: string;
  email: string;
  role: Role;
  joinedAt: string;
}
export interface Invitation {
  id: string;
  projectId: string;
  email: string;
  role: 'Editor' | 'Viewer';
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string;
}
export interface InvitationPreview {
  projectName: string;
  role: 'Editor' | 'Viewer';
  status: Invitation['status'];
  expiresAt: string;
  projectStatus: Project['status'];
}
export interface MemberSnapshot {
  project: Project;
  members: ProjectMember[];
}
export interface TaskResult {
  task: Task;
  boardRevision: number;
}
export interface TaskComment {
  id: string;
  projectId: string;
  taskId: string;
  authorId: string;
  authorName: string;
  authorActive: boolean;
  body: string | null;
  version: number;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}
export interface CommentResult {
  commentId: string;
  taskId: string;
  projectId: string;
  version: number;
  boardRevision: number;
}
export interface ActivityEntry {
  id: string;
  projectId: string;
  taskId: string | null;
  taskTitle: string | null;
  actorId: string;
  actorName: string;
  actorActive: boolean;
  action: string;
  changes: Record<string, unknown>;
  people: Record<string, string>;
  createdAt: string;
}
export interface BoardSnapshot {
  project: Project;
  tasks: Task[];
}
export interface SampleBoardSnapshot extends BoardSnapshot {
  comments: TaskComment[];
  activity: ActivityEntry[];
  attachments: { taskId: string; name: string; summary: string }[];
}
export interface ArchivedTaskSnapshot extends CursorPage<Task> {
  project: Project;
}
export interface AssignmentNotification {
  id: string;
  type: 'task_assigned';
  createdAt: string;
  readAt: string | null;
  target: {
    projectId: string;
    taskId: string;
    projectName: string;
    taskTitle: string;
    actorName: string;
    taskArchived: boolean;
  } | null;
}
export interface NotificationSummary {
  unreadCount: number;
}
export interface NotificationReadResult {
  id: string;
  readAt: string;
}
export interface NotificationsReadAllResult {
  updated: number;
  readThrough: string;
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
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
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
    canArchiveTask: write && !taskArchived,
    canManageProject: online && active && role === 'Owner',
    canLeaveProject:
      online && role !== null && role !== 'Owner' && state !== 'expired',
  };
}

export function commentCapabilities(
  role: Role,
  projectStatus: Project['status'],
  taskArchived: boolean,
  own: boolean,
  deleted: boolean,
  online = true,
) {
  const write = online && projectStatus === 'active' && role !== 'Viewer';
  return {
    canEdit: write && own && !deleted && !taskArchived,
    canDelete: write && !deleted && (own || role === 'Owner'),
  };
}
