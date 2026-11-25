import { createHash, randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type pg from 'pg';
import {
  limits,
  pagination,
  projectCapabilities,
  type CreateProject,
  type CreateTask,
  type Project,
  type Task,
  type UpdateTask,
  type MoveTask,
  type CreateInvitation,
  type AcceptInvitation,
  type ChangeRole,
  type User,
  type ProjectMember,
  type Invitation,
  type InvitationPreview,
  type ProjectAction,
  type UpdateProject,
  type TransferOwnership,
  type TaskAction,
} from '@collabboard/contracts';
import { Database } from '../../platform/database/database.js';
import { idempotent } from '../../platform/database/idempotency.js';
import { recordChange } from '../../platform/database/changes.js';
import { nextCursor, readPage } from '../../platform/http/pagination.js';
import { quotaConflict } from '../../platform/observability/quota.js';
import { populateSampleProject } from '../demo/populate-project.js';

type ProjectRow = Omit<Project, 'createdAt'> & {
  createdAt: Date;
};
const projectFields =
  'p.id, p.name, p.description, p.status, p.board_revision AS "boardRevision", p.created_at AS "createdAt", m.role';
const taskFields = `t.id, t.project_id AS "projectId", t.title, t.description, t.status, t.priority, t.position, t.version, t.due_date::text AS "dueDate", t.archived_at::text AS "archivedAt", t.assignee_id AS "assigneeId", (SELECT display_name FROM users WHERE id = t.assignee_id) AS "assigneeName", (SELECT count(*)::int FROM comments c WHERE c.task_id = t.id AND c.deleted_at IS NULL) AS "commentCount", (SELECT count(*)::int FROM attachments a WHERE a.task_id = t.id AND a.state = 'ready') AS "attachmentCount"`;
const invitationFields = `id, project_id AS "projectId", email, role, CASE WHEN status = 'pending' AND expires_at <= now() THEN 'expired' ELSE status END AS status, expires_at::text AS "expiresAt"`;
const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
const projectView = (row: ProjectRow): Project => ({
  ...row,
  createdAt: new Date(row.createdAt).toISOString(),
});
const conflict = (code: string, message: string) =>
  new HttpException({ code, message }, 409);

@Injectable()
export class ProjectsService {
  constructor(@Inject(Database) private readonly database: Database) {}

  async list(
    userId: string,
    cursor?: string,
    limit: number = pagination.defaultLimit,
  ) {
    const scope = `projects:${userId}`;
    const { boundary } = readPage(cursor, limit, scope);
    const result = await this.database.pool.query<ProjectRow>(
      `SELECT ${projectFields} FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = $1 AND p.status <> 'expired' AND ($2::timestamptz IS NULL OR (date_trunc('milliseconds', p.created_at), p.id) < ($2::timestamptz, $3::uuid)) ORDER BY date_trunc('milliseconds', p.created_at) DESC, p.id DESC LIMIT $4`,
      [userId, boundary?.at ?? null, boundary?.id ?? null, limit + 1],
    );
    const items = result.rows.slice(0, limit).map(projectView);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        result.rows.length > limit && last
          ? nextCursor(scope, last.createdAt, last.id)
          : null,
    };
  }

  async create(userId: string, input: CreateProject) {
    return this.database.transaction(async (client) => {
      await client.query(
        'SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE',
        [userId],
      );
      return idempotent(client, userId, 'create-project', input, async () => {
        const usage = await client.query<{ active: string; total: string }>(
          "SELECT count(*) FILTER (WHERE status = 'active') AS active, count(*) AS total FROM projects WHERE owner_id = $1 AND status <> 'expired'",
          [userId],
        );
        const count = usage.rows[0]!;
        if (Number(count.total) >= limits.totalProjects)
          throw quotaConflict(
            'PROJECT_LIMIT_REACHED',
            'totalProjects',
            Number(count.total),
            limits.totalProjects,
            'The Owner has reached the total project limit. Use an existing project; archiving does not release total quota.',
          );
        if (Number(count.active) >= limits.activeProjects) {
          throw quotaConflict(
            'PROJECT_LIMIT_REACHED',
            'activeProjects',
            Number(count.active),
            limits.activeProjects,
            'Archive an owned project before creating another one.',
          );
        }
        const id = randomUUID();
        await client.query(
          'INSERT INTO projects (id, owner_id, name, description, board_revision) VALUES ($1, $2, $3, $4, $5)',
          [id, userId, input.name, input.description, input.fromSample ? 1 : 0],
        );
        await client.query(
          "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'Owner')",
          [id, userId],
        );
        await this.recordChange(
          client,
          userId,
          id,
          null,
          'project.created',
          1,
          input.fromSample ? 1 : 0,
        );
        if (input.fromSample) await populateSampleProject(client, id, userId);
        return this.project(client, userId, id);
      });
    });
  }

  async board(userId: string, projectId: string) {
    return this.database.transaction(async (client) => {
      // A project lock keeps membership, revision, and task rows in one consistent snapshot.
      const project = await this.project(client, userId, projectId, true);
      const result = await client.query<Task>(
        `SELECT ${taskFields} FROM tasks t WHERE t.project_id = $1 AND t.archived_at IS NULL ORDER BY t.status, t.position, t.id`,
        [projectId],
      );
      return { project, tasks: result.rows };
    });
  }

  async createTask(userId: string, projectId: string, input: CreateTask) {
    return this.database.transaction(async (client) => {
      const project = await this.project(client, userId, projectId, true);
      if (project.status !== 'active')
        throw conflict(
          'PROJECT_ARCHIVED',
          'Restore this project before making changes.',
        );
      if (!projectCapabilities(project.role, project.status).canCreateTask)
        throw new ForbiddenException(
          'Your project role does not allow task creation.',
        );
      return idempotent(
        client,
        userId,
        `create-task:${projectId}`,
        input,
        async () => {
          await this.validateAssignee(client, projectId, input.assigneeId);
          const usage = await client.query<{ active: string; total: string }>(
            'SELECT count(*) FILTER (WHERE archived_at IS NULL) AS active, count(*) AS total FROM tasks WHERE project_id = $1',
            [projectId],
          );
          const count = usage.rows[0]!;
          if (Number(count.total) >= limits.totalTasks)
            throw quotaConflict(
              'TASK_LIMIT_REACHED',
              'totalTasks',
              Number(count.total),
              limits.totalTasks,
              'This project has reached its total task limit. Use an existing task or another project; archiving does not release total quota.',
            );
          if (Number(count.active) >= limits.activeTasks)
            throw quotaConflict(
              'TASK_LIMIT_REACHED',
              'activeTasks',
              Number(count.active),
              limits.activeTasks,
              'Archive a task before creating another one.',
            );
          const id = randomUUID();
          await client.query(
            'INSERT INTO tasks (id, project_id, creator_id, title, description, status, priority, due_date, assignee_id, position) SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE(max(position) + 1, 0) FROM tasks WHERE project_id = $2 AND status = $6 AND archived_at IS NULL',
            [
              id,
              projectId,
              userId,
              input.title,
              input.description,
              input.status,
              input.priority,
              input.dueDate,
              input.assigneeId,
            ],
          );
          const revision = project.boardRevision + 1;
          await client.query(
            'UPDATE projects SET board_revision = $2 WHERE id = $1',
            [projectId, revision],
          );
          const sourceEventId = await this.recordChange(
            client,
            userId,
            projectId,
            id,
            'task.created',
            1,
            revision,
          );
          await this.recordAssignment(
            client,
            userId,
            projectId,
            id,
            sourceEventId,
            null,
            input.assigneeId,
          );
          const result = await client.query<Task>(
            `SELECT ${taskFields} FROM tasks t WHERE t.id = $1`,
            [id],
          );
          return { task: result.rows[0]!, boardRevision: revision };
        },
      );
    });
  }

  async task(userId: string, taskId: string) {
    return this.database.transaction(async (client) => {
      const projectId = await this.taskProject(client, taskId);
      await this.project(client, userId, projectId, true);
      return this.readTask(client, taskId);
    });
  }

  async updateTask(userId: string, taskId: string, input: UpdateTask) {
    return this.database.transaction(async (client) => {
      const projectId = await this.taskProject(client, taskId);
      const project = await this.project(client, userId, projectId, true);
      this.requireWrite(project);
      return idempotent(
        client,
        userId,
        `update-task:${taskId}`,
        input,
        async () => {
          const previous = await this.readTask(client, taskId);
          this.requireTaskVersion(previous, input.expectedVersion);
          await this.validateAssignee(client, projectId, input.assigneeId);
          await client.query(
            'UPDATE tasks SET title = $2, description = $3, priority = $4, due_date = $5, assignee_id = $6, version = version + 1, updated_at = now() WHERE id = $1',
            [
              taskId,
              input.title,
              input.description,
              input.priority,
              input.dueDate,
              input.assigneeId,
            ],
          );
          const revision = await this.nextRevision(client, projectId);
          const task = await this.readTask(client, taskId);
          const sourceEventId = await this.recordChange(
            client,
            userId,
            projectId,
            taskId,
            'task.updated',
            task.version,
            revision,
            {
              before: {
                title: previous.title,
                description: previous.description,
                priority: previous.priority,
                dueDate: previous.dueDate,
                assigneeId: previous.assigneeId,
              },
              after: {
                title: task.title,
                description: task.description,
                priority: task.priority,
                dueDate: task.dueDate,
                assigneeId: task.assigneeId,
              },
            },
          );
          await this.recordAssignment(
            client,
            userId,
            projectId,
            taskId,
            sourceEventId,
            previous.assigneeId,
            task.assigneeId,
          );
          return { task, boardRevision: revision };
        },
      );
    });
  }

  async moveTask(userId: string, taskId: string, input: MoveTask) {
    return this.database.transaction(async (client) => {
      const projectId = await this.taskProject(client, taskId);
      const project = await this.project(client, userId, projectId, true);
      this.requireWrite(project);
      return idempotent(
        client,
        userId,
        `move-task:${taskId}`,
        input,
        async () => {
          const previous = await this.readTask(client, taskId);
          this.requireTaskVersion(previous, input.expectedVersion);
          if (project.boardRevision !== input.expectedBoardRevision)
            throw conflict(
              'VERSION_CONFLICT',
              'The board changed. Refresh it and choose the position again.',
            );
          const rows = await client.query<Task>(
            `SELECT ${taskFields} FROM tasks t WHERE t.project_id = $1 AND t.archived_at IS NULL AND t.status IN ($2, $3) ORDER BY t.position, t.id`,
            [projectId, previous.status, input.status],
          );
          const target = rows.rows.filter(
            (task) => task.status === input.status && task.id !== taskId,
          );
          const index =
            input.beforeTaskId === null
              ? target.length
              : target.findIndex((task) => task.id === input.beforeTaskId);
          if (index < 0)
            throw conflict(
              'INVALID_POSITION',
              'The target task is no longer in this column. Refresh the board.',
            );
          target.splice(index, 0, { ...previous, status: input.status });
          const source =
            previous.status === input.status
              ? []
              : rows.rows.filter(
                  (task) =>
                    task.status === previous.status && task.id !== taskId,
                );
          const positions = [
            ...source.map((task, position) => ({
              id: task.id,
              status: task.status,
              position,
            })),
            ...target.map((task, position) => ({
              id: task.id,
              status: input.status,
              position,
            })),
          ];
          const offset =
            Math.max(0, ...rows.rows.map((task) => task.position)) +
            rows.rows.length +
            1;
          await client.query(
            'UPDATE tasks SET position = position + $4 WHERE project_id = $1 AND archived_at IS NULL AND status IN ($2, $3)',
            [projectId, previous.status, input.status, offset],
          );
          await client.query(
            `UPDATE tasks t SET status = v.status, position = v.position, version = t.version + CASE WHEN t.id = $2 THEN 1 ELSE 0 END, updated_at = CASE WHEN t.id = $2 THEN now() ELSE t.updated_at END FROM jsonb_to_recordset($1::jsonb) AS v(id uuid, status text, position integer) WHERE t.id = v.id`,
            [JSON.stringify(positions), taskId],
          );
          const revision = await this.nextRevision(client, projectId);
          const task = await this.readTask(client, taskId);
          await this.recordChange(
            client,
            userId,
            projectId,
            taskId,
            'task.moved',
            task.version,
            revision,
            {
              before: { status: previous.status, position: previous.position },
              after: { status: task.status, position: task.position },
            },
          );
          return { task, boardRevision: revision };
        },
      );
    });
  }

  async members(userId: string, projectId: string) {
    return this.database.transaction(async (client) => {
      const project = await this.project(client, userId, projectId, true);
      const members = await client.query<ProjectMember>(
        `SELECT u.id, u.display_name AS "displayName", u.email, m.role, m.joined_at::text AS "joinedAt" FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = $1 ORDER BY CASE m.role WHEN 'Owner' THEN 0 WHEN 'Editor' THEN 1 ELSE 2 END, u.display_name, u.id`,
        [projectId],
      );
      return { project, members: members.rows };
    });
  }

  async invitations(
    userId: string,
    projectId: string,
    cursor?: string,
    limit: number = pagination.defaultLimit,
  ) {
    return this.database.transaction(async (client) => {
      const project = await this.project(client, userId, projectId, true);
      if (project.role !== 'Owner')
        throw new ForbiddenException(
          'Only the project Owner can read invitations.',
        );
      const scope = `invitations:${projectId}`;
      const { boundary } = readPage(cursor, limit, scope);
      const result = await client.query<Invitation & { createdAt: Date }>(
        `SELECT ${invitationFields}, created_at AS "createdAt" FROM invitations WHERE project_id = $1 AND status = 'pending' AND expires_at > now() AND ($2::timestamptz IS NULL OR (date_trunc('milliseconds', created_at), id) < ($2::timestamptz, $3::uuid)) ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC LIMIT $4`,
        [projectId, boundary?.at ?? null, boundary?.id ?? null, limit + 1],
      );
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      return {
        items: rows.map(
          ({ id, projectId, email, role, status, expiresAt }) => ({
            id,
            projectId,
            email,
            role,
            status,
            expiresAt,
          }),
        ),
        nextCursor:
          result.rows.length > limit && last
            ? nextCursor(scope, last.createdAt, last.id)
            : null,
      };
    });
  }

  async createInvitation(
    userId: string,
    projectId: string,
    input: CreateInvitation,
  ) {
    return this.database.transaction(async (client) => {
      const project = await this.project(client, userId, projectId, true);
      this.requireOwner(project);
      return idempotent(
        client,
        userId,
        `invite:${projectId}`,
        input,
        async () => {
          const member = await client.query(
            'SELECT 1 FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = $1 AND lower(u.email) = $2',
            [projectId, input.email],
          );
          if (member.rows.length)
            throw conflict(
              'ALREADY_MEMBER',
              'This person is already a project member.',
            );
          const count = await client.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM project_members WHERE project_id = $1',
            [projectId],
          );
          if (count.rows[0]!.count >= limits.members)
            throw quotaConflict(
              'MEMBER_LIMIT_REACHED',
              'members',
              count.rows[0]!.count,
              limits.members,
              'Remove a member before inviting another teammate.',
            );
          if (
            (
              await client.query(
                'SELECT 1 FROM invitations WHERE token_hash = $1',
                [tokenHash(input.token)],
              )
            ).rows.length
          )
            throw conflict(
              'INVITE_TOKEN_REUSED',
              'Generate a new invitation link.',
            );
          await client.query(
            "UPDATE invitations SET status = CASE WHEN expires_at <= now() THEN 'expired' ELSE 'revoked' END WHERE project_id = $1 AND email = $2 AND status = 'pending'",
            [projectId, input.email],
          );
          const result = await client.query<Invitation>(
            `INSERT INTO invitations(id, project_id, email, role, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '72 hours') RETURNING ${invitationFields}`,
            [
              randomUUID(),
              projectId,
              input.email,
              input.role,
              tokenHash(input.token),
            ],
          );
          await this.recordChange(
            client,
            userId,
            projectId,
            null,
            'invitation.created',
            1,
            project.boardRevision,
          );
          return result.rows[0]!;
        },
      );
    });
  }

  async previewInvitation(token: string) {
    const result = await this.database.pool.query<InvitationPreview>(
      `SELECT p.name AS "projectName", i.role, CASE WHEN i.status = 'pending' AND i.expires_at <= now() THEN 'expired' ELSE i.status END AS status, i.expires_at::text AS "expiresAt", p.status AS "projectStatus" FROM invitations i JOIN projects p ON p.id = i.project_id WHERE i.token_hash = $1`,
      [tokenHash(token)],
    );
    if (!result.rows[0])
      throw new NotFoundException('This invitation link is invalid.');
    return result.rows[0];
  }

  async acceptInvitation(user: User, input: AcceptInvitation) {
    return this.database.transaction(async (client) => {
      const lookup = await client.query<{ project_id: string }>(
        'SELECT project_id FROM invitations WHERE token_hash = $1',
        [tokenHash(input.token)],
      );
      if (!lookup.rows[0])
        throw new NotFoundException('This invitation link is invalid.');
      const projectId = lookup.rows[0].project_id;
      const projects = await client.query<{ status: string }>(
        `SELECT status FROM projects WHERE id = $1 FOR UPDATE`,
        [projectId],
      );
      const result = await client.query<
        Invitation & { acceptedBy: string | null }
      >(
        `SELECT ${invitationFields}, accepted_by AS "acceptedBy" FROM invitations WHERE token_hash = $1 FOR UPDATE`,
        [tokenHash(input.token)],
      );
      const invitation = result.rows[0];
      if (!invitation)
        throw new NotFoundException('This invitation link is invalid.');
      if (!user.emailVerified)
        throw new ForbiddenException({
          code: 'EMAIL_UNVERIFIED',
          message: 'Verify your email before accepting this invitation.',
        });
      if (user.email.toLowerCase() !== invitation.email)
        throw new ForbiddenException({
          code: 'INVITE_EMAIL_MISMATCH',
          message:
            'Sign in with the email address this invitation was sent to.',
        });
      if (projects.rows[0]?.status !== 'active')
        throw conflict(
          'PROJECT_ARCHIVED',
          'This project is archived or no longer available.',
        );
      const existing = await client.query(
        'SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2',
        [projectId, user.id],
      );
      if (
        invitation.status === 'accepted' &&
        (!existing.rows.length || invitation.acceptedBy !== user.id)
      )
        throw conflict(
          'INVITE_ALREADY_ACCEPTED',
          'This invitation has already been used. Ask the Owner for a new invitation.',
        );
      if (invitation.status === 'revoked' || invitation.status === 'expired')
        throw conflict(
          invitation.status === 'revoked' ? 'INVITE_REVOKED' : 'INVITE_EXPIRED',
          `This invitation has ${invitation.status === 'revoked' ? 'been revoked' : 'expired'}. Ask the Owner for a new link.`,
        );
      return idempotent(
        client,
        user.id,
        'accept-invitation',
        input,
        async () => {
          if (invitation.status === 'accepted')
            return { projectId, alreadyJoined: true };
          if (!existing.rows.length) {
            const count = await client.query<{ count: number }>(
              'SELECT count(*)::int AS count FROM project_members WHERE project_id = $1',
              [projectId],
            );
            if (count.rows[0]!.count >= limits.members)
              throw quotaConflict(
                'MEMBER_LIMIT_REACHED',
                'members',
                count.rows[0]!.count,
                limits.members,
                'Ask the Owner to remove a member before accepting this invitation.',
              );
            await client.query(
              'INSERT INTO project_members(project_id, user_id, role) VALUES ($1, $2, $3)',
              [projectId, user.id, invitation.role],
            );
          }
          await client.query(
            "UPDATE invitations SET status = 'accepted', accepted_by = $2 WHERE id = $1",
            [invitation.id, user.id],
          );
          const revision = await this.nextRevision(client, projectId);
          await this.recordChange(
            client,
            user.id,
            projectId,
            null,
            'member.joined',
            1,
            revision,
          );
          return { projectId, alreadyJoined: !!existing.rows.length };
        },
      );
    });
  }

  async revokeInvitation(
    userId: string,
    projectId: string,
    invitationId: string,
    input: { requestId: string },
  ) {
    return this.database.transaction(async (client) => {
      const project = await this.project(client, userId, projectId, true);
      this.requireOwner(project);
      return idempotent(
        client,
        userId,
        `revoke-invitation:${projectId}:${invitationId}`,
        input,
        async () => {
          const result = await client.query(
            "UPDATE invitations SET status = 'revoked' WHERE id = $1 AND project_id = $2 AND status = 'pending' RETURNING id",
            [invitationId, projectId],
          );
          if (!result.rows[0])
            throw new NotFoundException('Pending invitation not found.');
          await this.recordChange(
            client,
            userId,
            projectId,
            null,
            'invitation.revoked',
            1,
            project.boardRevision,
          );
          return { revoked: true };
        },
      );
    });
  }

  async changeMember(
    userId: string,
    projectId: string,
    memberId: string,
    input: ChangeRole | { requestId: string },
  ) {
    return this.database.transaction(async (client) => {
      const project = await this.project(client, userId, projectId, true);
      this.requireOwner(project);
      const role = 'role' in input ? input.role : null;
      return idempotent(
        client,
        userId,
        `member:${projectId}:${memberId}:${role ?? 'remove'}`,
        input,
        async () => {
          const target = await client.query<{ role: string }>(
            'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
            [projectId, memberId],
          );
          if (!target.rows[0]) throw new NotFoundException('Member not found.');
          if (target.rows[0].role === 'Owner')
            throw conflict(
              'OWNER_TRANSFER_REQUIRED',
              'Transfer ownership before changing or removing the Owner.',
            );
          if (role)
            await client.query(
              'UPDATE project_members SET role = $3 WHERE project_id = $1 AND user_id = $2',
              [projectId, memberId, role],
            );
          else
            await client.query(
              'DELETE FROM project_members WHERE project_id = $1 AND user_id = $2',
              [projectId, memberId],
            );
          const revision = await this.nextRevision(client, projectId);
          if (role !== 'Editor') {
            const cleared = await client.query<{ id: string; version: number }>(
              'UPDATE tasks SET assignee_id = NULL, version = version + 1, updated_at = now() WHERE project_id = $1 AND assignee_id = $2 AND archived_at IS NULL RETURNING id, version',
              [projectId, memberId],
            );
            for (const task of cleared.rows)
              await this.recordChange(
                client,
                userId,
                projectId,
                task.id,
                'task.unassigned',
                task.version,
                revision,
                {
                  before: { assigneeId: memberId },
                  after: { assigneeId: null },
                },
              );
          }
          await this.recordChange(
            client,
            userId,
            projectId,
            null,
            role ? 'member.role_changed' : 'member.removed',
            1,
            revision,
            { memberId, before: target.rows[0].role, after: role },
          );
          return { updated: true };
        },
      );
    });
  }

  async details(userId: string, projectId: string) {
    return this.database.transaction((client) =>
      this.project(client, userId, projectId, true),
    );
  }

  async updateProject(userId: string, projectId: string, input: UpdateProject) {
    return this.database.transaction(async (client) => {
      const project = await this.project(client, userId, projectId, true);
      this.requireOwner(project);
      return idempotent(
        client,
        userId,
        `update-project:${projectId}`,
        input,
        async () => {
          this.requireBoardVersion(project, input.expectedBoardRevision);
          await client.query(
            'UPDATE projects SET name = $2, description = $3 WHERE id = $1',
            [projectId, input.name, input.description],
          );
          const revision = await this.nextRevision(client, projectId);
          await this.recordChange(
            client,
            userId,
            projectId,
            null,
            'project.updated',
            revision,
            revision,
            {
              before: { name: project.name, description: project.description },
              after: { name: input.name, description: input.description },
            },
          );
          return this.project(client, userId, projectId);
        },
      );
    });
  }

  async setProjectArchived(
    userId: string,
    projectId: string,
    archived: boolean,
    input: ProjectAction,
  ) {
    return this.database.transaction(async (client) => {
      // Quota locks precede project locks and remain compatible with foreign-key checks.
      await client.query(
        'SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE',
        [userId],
      );
      const project = await this.project(client, userId, projectId, true);
      if (project.role !== 'Owner')
        throw new ForbiddenException(
          'Only the project Owner can archive or restore this project.',
        );
      return idempotent(
        client,
        userId,
        `project-${archived ? 'archive' : 'restore'}:${projectId}`,
        input,
        async () => {
          this.requireBoardVersion(project, input.expectedBoardRevision);
          const status = archived ? 'archived' : 'active';
          if (project.status === status) return project;
          if (!archived)
            await this.ownerQuota(client, userId, projectId, false);
          await client.query('UPDATE projects SET status = $2 WHERE id = $1', [
            projectId,
            status,
          ]);
          const revision = await this.nextRevision(client, projectId);
          await this.recordChange(
            client,
            userId,
            projectId,
            null,
            archived ? 'project.archived' : 'project.restored',
            revision,
            revision,
          );
          return this.project(client, userId, projectId);
        },
      );
    });
  }

  async transferOwnership(
    userId: string,
    projectId: string,
    input: TransferOwnership,
  ) {
    return this.database.transaction(async (client) => {
      await client.query(
        'SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE',
        [[userId, input.memberId]],
      );
      const project = await this.project(client, userId, projectId, true);
      // A former Owner may resolve their own committed request while still a member.
      return idempotent(
        client,
        userId,
        `transfer:${projectId}`,
        input,
        async () => {
          this.requireOwner(project);
          this.requireBoardVersion(project, input.expectedBoardRevision);
          if (input.memberId === userId)
            throw conflict('INVALID_OWNER', 'Choose another current member.');
          const target = await client.query(
            'SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2',
            [projectId, input.memberId],
          );
          if (!target.rows.length)
            throw conflict(
              'INVALID_OWNER',
              'The new Owner must be a current project member.',
            );
          await this.ownerQuota(client, input.memberId, projectId, true);
          await client.query(
            "UPDATE project_members SET role = 'Editor' WHERE project_id = $1 AND user_id = $2",
            [projectId, userId],
          );
          await client.query(
            "UPDATE project_members SET role = 'Owner' WHERE project_id = $1 AND user_id = $2",
            [projectId, input.memberId],
          );
          await client.query(
            'UPDATE projects SET owner_id = $2 WHERE id = $1',
            [projectId, input.memberId],
          );
          const revision = await this.nextRevision(client, projectId);
          await this.recordChange(
            client,
            userId,
            projectId,
            null,
            'project.ownership_transferred',
            revision,
            revision,
            { before: { ownerId: userId }, after: { ownerId: input.memberId } },
          );
          return this.project(client, userId, projectId);
        },
      );
    });
  }

  async leaveProject(
    userId: string,
    projectId: string,
    input: { requestId: string },
  ) {
    return this.database.transaction(async (client) => {
      const projects = await client.query<{ status: string }>(
        'SELECT status FROM projects WHERE id = $1 FOR UPDATE',
        [projectId],
      );
      if (!projects.rows[0] || projects.rows[0].status === 'expired')
        throw new NotFoundException(
          'Project not found or no longer accessible.',
        );
      const members = await client.query<{ role: string }>(
        'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
        [projectId, userId],
      );
      return idempotent(
        client,
        userId,
        `leave:${projectId}`,
        input,
        async () => {
          if (!members.rows[0])
            throw new NotFoundException(
              'Project not found or no longer accessible.',
            );
          if (members.rows[0].role === 'Owner')
            throw conflict(
              'OWNER_TRANSFER_REQUIRED',
              'Transfer ownership before leaving this project.',
            );
          await client.query(
            'DELETE FROM project_members WHERE project_id = $1 AND user_id = $2',
            [projectId, userId],
          );
          const revision = await this.nextRevision(client, projectId);
          const cleared = await client.query<{ id: string; version: number }>(
            'UPDATE tasks SET assignee_id = NULL, version = version + 1, updated_at = now() WHERE project_id = $1 AND assignee_id = $2 AND archived_at IS NULL RETURNING id, version',
            [projectId, userId],
          );
          for (const task of cleared.rows)
            await this.recordChange(
              client,
              userId,
              projectId,
              task.id,
              'task.unassigned',
              task.version,
              revision,
              { before: { assigneeId: userId }, after: { assigneeId: null } },
            );
          await this.recordChange(
            client,
            userId,
            projectId,
            null,
            'member.left',
            1,
            revision,
            { memberId: userId },
          );
          return { projectId, left: true };
        },
      );
    });
  }

  async archivedTasks(
    userId: string,
    projectId: string,
    cursor?: string,
    limit: number = pagination.defaultLimit,
  ) {
    return this.database.transaction(async (client) => {
      const project = await this.project(client, userId, projectId, true);
      const scope = `archived-tasks:${projectId}`;
      const { boundary } = readPage(cursor, limit, scope);
      const result = await client.query<Task>(
        `SELECT ${taskFields} FROM tasks t WHERE t.project_id = $1 AND t.archived_at IS NOT NULL AND ($2::timestamptz IS NULL OR (date_trunc('milliseconds', t.archived_at), t.id) < ($2::timestamptz, $3::uuid)) ORDER BY date_trunc('milliseconds', t.archived_at) DESC, t.id DESC LIMIT $4`,
        [projectId, boundary?.at ?? null, boundary?.id ?? null, limit + 1],
      );
      const items = result.rows.slice(0, limit);
      const last = items.at(-1);
      return {
        project,
        items,
        nextCursor:
          result.rows.length > limit && last
            ? nextCursor(scope, last.archivedAt!, last.id)
            : null,
      };
    });
  }

  async setTaskArchived(
    userId: string,
    taskId: string,
    archived: boolean,
    input: TaskAction,
  ) {
    return this.database.transaction(async (client) => {
      const projectId = await this.taskProject(client, taskId);
      const project = await this.project(client, userId, projectId, true);
      this.requireWrite(project);
      return idempotent(
        client,
        userId,
        `task-${archived ? 'archive' : 'restore'}:${taskId}`,
        input,
        async () => {
          const task = await this.readTask(client, taskId);
          if (task.version !== input.expectedVersion)
            throw conflict(
              'VERSION_CONFLICT',
              'This task changed. Refresh it before continuing.',
            );
          if (!!task.archivedAt === archived)
            return { task, boardRevision: project.boardRevision };
          if (archived)
            await client.query(
              'UPDATE tasks SET archived_at = now(), version = version + 1, updated_at = now() WHERE id = $1',
              [taskId],
            );
          else {
            const count = await client.query<{ count: number }>(
              'SELECT count(*)::int AS count FROM tasks WHERE project_id = $1 AND archived_at IS NULL',
              [projectId],
            );
            if (count.rows[0]!.count >= limits.activeTasks)
              throw quotaConflict(
                'TASK_LIMIT_REACHED',
                'activeTasks',
                count.rows[0]!.count,
                limits.activeTasks,
                'Archive another task before restoring this one.',
              );
            // Historical assignees are retained while archived, then revalidated on restore.
            await client.query(
              `UPDATE tasks SET archived_at = NULL, position = (SELECT COALESCE(max(position) + 1, 0) FROM tasks WHERE project_id = $2 AND status = $3 AND archived_at IS NULL), assignee_id = CASE WHEN EXISTS(SELECT 1 FROM project_members WHERE project_id = $2 AND user_id = tasks.assignee_id AND role IN ('Owner', 'Editor')) THEN assignee_id ELSE NULL END, version = version + 1, updated_at = now() WHERE id = $1`,
              [taskId, projectId, task.status],
            );
          }
          const revision = await this.nextRevision(client, projectId);
          const updated = await this.readTask(client, taskId);
          await this.recordChange(
            client,
            userId,
            projectId,
            taskId,
            archived ? 'task.archived' : 'task.restored',
            updated.version,
            revision,
            {
              before: {
                archivedAt: task.archivedAt,
                assigneeId: task.assigneeId,
              },
              after: {
                archivedAt: updated.archivedAt,
                assigneeId: updated.assigneeId,
              },
            },
          );
          return { task: updated, boardRevision: revision };
        },
      );
    });
  }

  private requireBoardVersion(project: Project, expected: number) {
    if (project.boardRevision !== expected)
      throw conflict(
        'VERSION_CONFLICT',
        'This project changed. Review the latest state before continuing.',
      );
  }

  private async ownerQuota(
    client: pg.PoolClient,
    userId: string,
    projectId: string,
    incoming: boolean,
  ) {
    const usage = await client.query<{ active: number; total: number }>(
      "SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*)::int AS total FROM projects WHERE owner_id = $1 AND status <> 'expired' AND id <> $2",
      [userId, projectId],
    );
    const count = usage.rows[0]!;
    if (incoming && count.total >= limits.totalProjects)
      throw quotaConflict(
        'PROJECT_LIMIT_REACHED',
        'totalProjects',
        count.total,
        limits.totalProjects,
        'The new Owner has reached the total project limit. Choose another member; archiving does not release total quota.',
      );
    if (count.active >= limits.activeProjects)
      throw quotaConflict(
        'PROJECT_LIMIT_REACHED',
        'activeProjects',
        count.active,
        limits.activeProjects,
        incoming
          ? 'The new Owner must archive an owned project first, or choose another member.'
          : 'Archive another owned project before restoring this one.',
      );
  }

  private requireWrite(project: Project) {
    if (project.status !== 'active')
      throw conflict(
        'PROJECT_ARCHIVED',
        'Restore this project before making changes.',
      );
    if (!projectCapabilities(project.role, project.status).canEditTask)
      throw new ForbiddenException(
        'Your project role does not allow task changes.',
      );
  }

  private requireOwner(project: Project) {
    if (project.role !== 'Owner')
      throw new ForbiddenException(
        'Only the project Owner can manage this project.',
      );
    if (project.status !== 'active')
      throw conflict(
        'PROJECT_ARCHIVED',
        'Restore this project before making changes.',
      );
  }

  private requireTaskVersion(task: Task, expected: number) {
    if (task.archivedAt)
      throw conflict(
        'TASK_ARCHIVED',
        'This task is archived and cannot be changed.',
      );
    if (task.version !== expected)
      throw conflict(
        'VERSION_CONFLICT',
        'This task was updated by another member. Your draft is kept. Review the latest version before saving again.',
      );
  }

  private async validateAssignee(
    client: pg.PoolClient,
    projectId: string,
    assigneeId: string | null,
  ) {
    if (assigneeId === null) return;
    const member = await client.query(
      "SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2 AND role IN ('Owner', 'Editor')",
      [projectId, assigneeId],
    );
    if (!member.rows.length)
      throw conflict(
        'INVALID_ASSIGNEE',
        'Choose a current Owner or Editor from this project.',
      );
  }

  private async taskProject(client: pg.PoolClient, taskId: string) {
    const result = await client.query<{ project_id: string }>(
      'SELECT project_id FROM tasks WHERE id = $1',
      [taskId],
    );
    if (!result.rows[0])
      throw new NotFoundException('Task not found or no longer accessible.');
    return result.rows[0].project_id;
  }

  private async readTask(client: pg.PoolClient, taskId: string) {
    const result = await client.query<Task>(
      `SELECT ${taskFields} FROM tasks t WHERE t.id = $1`,
      [taskId],
    );
    if (!result.rows[0])
      throw new NotFoundException('Task not found or no longer accessible.');
    return result.rows[0];
  }

  private async nextRevision(client: pg.PoolClient, projectId: string) {
    const result = await client.query<{ board_revision: number }>(
      'UPDATE projects SET board_revision = board_revision + 1 WHERE id = $1 RETURNING board_revision',
      [projectId],
    );
    return result.rows[0]!.board_revision;
  }

  private async project(
    client: pg.PoolClient,
    userId: string,
    id: string,
    lock = false,
  ) {
    if (lock)
      await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [
        id,
      ]);
    const result = await client.query<ProjectRow>(
      `SELECT ${projectFields} FROM projects p JOIN project_members m ON m.project_id = p.id WHERE p.id = $1 AND m.user_id = $2 AND p.status <> 'expired' `,
      [id, userId],
    );
    if (!result.rows[0])
      throw new NotFoundException('Project not found or no longer accessible.');
    return projectView(result.rows[0]);
  }

  private async recordAssignment(
    client: pg.PoolClient,
    actorId: string,
    projectId: string,
    taskId: string,
    sourceEventId: string,
    previousAssignee: string | null,
    assignee: string | null,
  ) {
    if (!assignee || assignee === actorId || assignee === previousAssignee)
      return;
    await client.query(
      "INSERT INTO notifications(id, recipient_id, actor_id, project_id, task_id, type, source_event_id) VALUES ($1, $2, $3, $4, $5, 'task_assigned', $6) ON CONFLICT (recipient_id, source_event_id) DO NOTHING",
      [randomUUID(), assignee, actorId, projectId, taskId, sourceEventId],
    );
  }

  private async recordChange(
    client: pg.PoolClient,
    userId: string,
    projectId: string,
    taskId: string | null,
    action: string,
    version: number,
    revision: number,
    summary: Record<string, unknown> = {},
  ) {
    return recordChange(client, {
      actorId: userId,
      projectId,
      taskId,
      entityId: taskId ?? projectId,
      action,
      version,
      revision,
      summary,
    });
  }
}
