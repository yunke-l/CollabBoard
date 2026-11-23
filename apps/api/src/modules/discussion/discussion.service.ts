import { randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type pg from 'pg';
import {
  pagination,
  type ActivityEntry,
  type CommentResult,
  type CreateComment,
  type Project,
  type TaskAction,
  type TaskComment,
  type UpdateComment,
} from '@collabboard/contracts';
import { Database } from '../../platform/database/database.js';
import { idempotent } from '../../platform/database/idempotency.js';
import { recordChange } from '../../platform/database/changes.js';
import { nextCursor, readPage } from '../../platform/http/pagination.js';

const commentFields = `c.id, c.project_id AS "projectId", c.task_id AS "taskId", c.author_id AS "authorId", u.display_name AS "authorName", EXISTS(SELECT 1 FROM project_members member WHERE member.project_id = c.project_id AND member.user_id = c.author_id) AS "authorActive", CASE WHEN c.deleted_at IS NULL THEN c.body ELSE NULL END AS body, c.version, c.created_at AS "createdAt", c.edited_at AS "editedAt", c.deleted_at AS "deletedAt"`;
type CommentRow = Omit<TaskComment, 'createdAt' | 'editedAt' | 'deletedAt'> & {
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
};
const commentView = (row: CommentRow): TaskComment => ({
  ...row,
  createdAt: new Date(row.createdAt).toISOString(),
  editedAt: row.editedAt ? new Date(row.editedAt).toISOString() : null,
  deletedAt: row.deletedAt ? new Date(row.deletedAt).toISOString() : null,
});
const conflict = (code: string, message: string) =>
  new HttpException({ code, message }, 409);

@Injectable()
export class DiscussionService {
  constructor(@Inject(Database) private readonly database: Database) {}

  async comments(
    userId: string,
    taskId: string,
    cursor?: string,
    limit: number = pagination.defaultLimit,
  ) {
    return this.database.transaction(async (client) => {
      await this.taskContext(client, userId, taskId);
      const scope = `comments:${taskId}`;
      const { boundary } = readPage(cursor, limit, scope);
      const result = await client.query<CommentRow>(
        `SELECT ${commentFields} FROM comments c JOIN users u ON u.id = c.author_id WHERE c.task_id = $1 AND ($2::timestamptz IS NULL OR (date_trunc('milliseconds', c.created_at), c.id) < ($2::timestamptz, $3::uuid)) ORDER BY date_trunc('milliseconds', c.created_at) DESC, c.id DESC LIMIT $4`,
        [taskId, boundary?.at ?? null, boundary?.id ?? null, limit + 1],
      );
      const items = result.rows.slice(0, limit).map(commentView);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          result.rows.length > limit && last
            ? nextCursor(scope, last.createdAt, last.id)
            : null,
      };
    });
  }

  async comment(userId: string, commentId: string) {
    return this.database.transaction(async (client) => {
      const taskId = await this.commentTask(client, commentId);
      await this.taskContext(client, userId, taskId);
      return this.readComment(client, commentId);
    });
  }

  async create(userId: string, taskId: string, input: CreateComment) {
    return this.database.transaction(async (client) => {
      const context = await this.taskContext(client, userId, taskId);
      this.requireWrite(context.project, context.archived, false);
      return idempotent(
        client,
        userId,
        `create-comment:${taskId}`,
        input,
        async () => {
          const id = randomUUID();
          await client.query(
            'INSERT INTO comments(id, project_id, task_id, author_id, body) VALUES ($1, $2, $3, $4, $5)',
            [id, context.project.id, taskId, userId, input.body],
          );
          return this.changed(
            client,
            userId,
            context.project.id,
            taskId,
            id,
            1,
            'comment.created',
          );
        },
      );
    });
  }

  async update(userId: string, commentId: string, input: UpdateComment) {
    return this.mutate(userId, commentId, input, false);
  }

  async delete(userId: string, commentId: string, input: TaskAction) {
    return this.mutate(userId, commentId, input, true);
  }

  private async mutate(
    userId: string,
    commentId: string,
    input: UpdateComment | TaskAction,
    removing: boolean,
  ) {
    return this.database.transaction(async (client) => {
      const taskId = await this.commentTask(client, commentId);
      const context = await this.taskContext(client, userId, taskId);
      this.requireWrite(context.project, context.archived, removing);
      const comment = await this.readComment(client, commentId);
      if (
        comment.authorId !== userId &&
        !(removing && context.project.role === 'Owner')
      )
        throw new ForbiddenException(
          removing
            ? 'Only the author or project Owner can delete this comment.'
            : 'Only the author can edit this comment.',
        );
      return idempotent(
        client,
        userId,
        `${removing ? 'delete' : 'update'}-comment:${commentId}`,
        input,
        async () => {
          if (comment.version !== input.expectedVersion)
            throw conflict(
              'VERSION_CONFLICT',
              'This comment changed. Your draft is kept. Review the latest comment before continuing.',
            );
          if (comment.deletedAt) {
            if (!removing)
              throw conflict(
                'COMMENT_DELETED',
                'This comment was deleted. Your draft is kept for copying.',
              );
            return {
              commentId,
              taskId,
              projectId: context.project.id,
              version: comment.version,
              boardRevision: context.project.boardRevision,
            };
          }
          if (removing)
            await client.query(
              'UPDATE comments SET body = NULL, deleted_at = now(), version = version + 1 WHERE id = $1',
              [commentId],
            );
          else
            await client.query(
              'UPDATE comments SET body = $2, edited_at = now(), version = version + 1 WHERE id = $1',
              [commentId, (input as UpdateComment).body],
            );
          return this.changed(
            client,
            userId,
            context.project.id,
            taskId,
            commentId,
            comment.version + 1,
            removing ? 'comment.deleted' : 'comment.updated',
          );
        },
      );
    });
  }

  async activity(
    userId: string,
    projectId: string,
    taskId?: string,
    cursor?: string,
    limit: number = pagination.defaultLimit,
  ) {
    return this.database.transaction(async (client) => {
      await this.project(client, userId, projectId);
      if (
        taskId &&
        !(
          await client.query(
            'SELECT 1 FROM tasks WHERE id = $1 AND project_id = $2',
            [taskId, projectId],
          )
        ).rows.length
      )
        throw new NotFoundException('Task not found or no longer accessible.');
      const scope = `activity:${projectId}:${taskId ?? 'all'}`;
      const { boundary } = readPage(cursor, limit, scope);
      const result = await client.query<
        Omit<ActivityEntry, 'createdAt'> & { createdAt: Date }
      >(
        `SELECT a.id, a.project_id AS "projectId", a.task_id AS "taskId", t.title AS "taskTitle", a.actor_id AS "actorId", u.display_name AS "actorName", EXISTS(SELECT 1 FROM project_members member WHERE member.project_id = a.project_id AND member.user_id = a.actor_id) AS "actorActive", a.action, a.change_summary AS changes, COALESCE((SELECT json_object_agg(person.id::text, person.display_name) FROM users person WHERE person.id::text = ANY(ARRAY[a.change_summary->>'memberId', a.change_summary->'before'->>'assigneeId', a.change_summary->'after'->>'assigneeId', a.change_summary->'before'->>'ownerId', a.change_summary->'after'->>'ownerId'])), '{}'::json) AS people, a.created_at AS "createdAt" FROM activity a JOIN users u ON u.id = a.actor_id LEFT JOIN tasks t ON t.id = a.task_id AND t.project_id = a.project_id WHERE a.project_id = $1 AND ($2::uuid IS NULL OR a.task_id = $2) AND ($3::timestamptz IS NULL OR (date_trunc('milliseconds', a.created_at), a.id) < ($3::timestamptz, $4::uuid)) ORDER BY date_trunc('milliseconds', a.created_at) DESC, a.id DESC LIMIT $5`,
        [
          projectId,
          taskId ?? null,
          boundary?.at ?? null,
          boundary?.id ?? null,
          limit + 1,
        ],
      );
      const items = result.rows.slice(0, limit).map((row) => ({
        ...row,
        createdAt: new Date(row.createdAt).toISOString(),
      }));
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          result.rows.length > limit && last
            ? nextCursor(scope, last.createdAt, last.id)
            : null,
      };
    });
  }

  private async project(
    client: pg.PoolClient,
    userId: string,
    projectId: string,
  ) {
    // Acquire the same project lock used by lifecycle and member writes before
    // reading membership, so a waiting request cannot use an old role snapshot.
    await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [
      projectId,
    ]);
    const result = await client.query<{
      id: string;
      status: Project['status'];
      role: Project['role'];
      boardRevision: number;
    }>(
      `SELECT p.id, p.status, p.board_revision AS "boardRevision", m.role FROM projects p JOIN project_members m ON m.project_id = p.id WHERE p.id = $1 AND m.user_id = $2 AND p.status <> 'expired' AND (p.expires_at IS NULL OR p.expires_at > now())`,
      [projectId, userId],
    );
    if (!result.rows[0])
      throw new NotFoundException('Project not found or no longer accessible.');
    return result.rows[0];
  }

  private async taskContext(
    client: pg.PoolClient,
    userId: string,
    taskId: string,
  ) {
    const result = await client.query<{ projectId: string }>(
      'SELECT project_id AS "projectId" FROM tasks WHERE id = $1',
      [taskId],
    );
    if (!result.rows[0])
      throw new NotFoundException('Task not found or no longer accessible.');
    const project = await this.project(
      client,
      userId,
      result.rows[0].projectId,
    );
    const task = await client.query<{ archived: boolean }>(
      'SELECT archived_at IS NOT NULL AS archived FROM tasks WHERE id = $1',
      [taskId],
    );
    if (!task.rows[0])
      throw new NotFoundException('Task not found or no longer accessible.');
    return { project, archived: task.rows[0].archived };
  }

  private requireWrite(
    project: { status: Project['status']; role: Project['role'] },
    archived: boolean,
    removing: boolean,
  ) {
    if (project.status !== 'active')
      throw conflict(
        'PROJECT_ARCHIVED',
        'Restore this project before changing comments.',
      );
    if (project.role === 'Viewer')
      throw new ForbiddenException(
        'Your current project role does not allow comment changes.',
      );
    if (archived && !removing)
      throw conflict(
        'TASK_ARCHIVED',
        'Restore this task before adding or editing comments.',
      );
  }

  private async commentTask(client: pg.PoolClient, id: string) {
    const result = await client.query<{ taskId: string }>(
      'SELECT task_id AS "taskId" FROM comments WHERE id = $1',
      [id],
    );
    if (!result.rows[0])
      throw new NotFoundException('Comment not found or no longer accessible.');
    return result.rows[0].taskId;
  }

  private async readComment(client: pg.PoolClient, id: string) {
    const result = await client.query<CommentRow>(
      `SELECT ${commentFields} FROM comments c JOIN users u ON u.id = c.author_id WHERE c.id = $1`,
      [id],
    );
    if (!result.rows[0])
      throw new NotFoundException('Comment not found or no longer accessible.');
    return commentView(result.rows[0]);
  }

  private async changed(
    client: pg.PoolClient,
    actorId: string,
    projectId: string,
    taskId: string,
    commentId: string,
    version: number,
    action: string,
  ): Promise<CommentResult> {
    const result = await client.query<{ revision: number }>(
      'UPDATE projects SET board_revision = board_revision + 1 WHERE id = $1 RETURNING board_revision AS revision',
      [projectId],
    );
    const revision = result.rows[0]!.revision;
    // Bodies never enter immutable history or replay caches, including edits.
    await recordChange(client, {
      actorId,
      projectId,
      taskId,
      entityId: commentId,
      action,
      version,
      revision,
      summary: { commentId, version },
    });
    return { commentId, taskId, projectId, version, boardRevision: revision };
  }
}
