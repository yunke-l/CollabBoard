import { randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type pg from 'pg';
import { Database } from '../../platform/database/database.js';
import { projectAccess } from '../../platform/database/access.js';
import { idempotent } from '../../platform/database/idempotency.js';
import { recordChange } from '../../platform/database/changes.js';
import { sampleBoard } from '../demo/sample.js';

@Injectable()
export class TrialsService {
  constructor(@Inject(Database) private readonly database: Database) {}
  async current(userId: string) {
    const { rows } = await this.database.pool.query<{
      projectId: string;
      expiresAt: Date;
    }>(
      `SELECT id AS "projectId", expires_at AS "expiresAt" FROM projects WHERE owner_id = $1 AND is_trial AND status = 'active' AND expires_at > now() LIMIT 1`,
      [userId],
    );
    return rows[0]
      ? {
          projectId: rows[0].projectId,
          expiresAt: new Date(rows[0].expiresAt).toISOString(),
        }
      : null;
  }
  create(userId: string, input: { requestId: string }) {
    return this.database.transaction(async (client) => {
      await this.lockOwner(client, userId);
      const result = await idempotent(
        client,
        userId,
        'create-trial',
        input,
        () => this.copy(client, userId),
      );
      await projectAccess(client, userId, result.projectId);
      return result;
    });
  }
  reset(userId: string, projectId: string, input: { requestId: string }) {
    return this.database.transaction(async (client) => {
      await this.lockOwner(client, userId);
      const result = await idempotent(
        client,
        userId,
        `reset-trial:${projectId}`,
        input,
        async () => {
          const project = await projectAccess(client, userId, projectId);
          this.owner(project);
          await client.query(
            "UPDATE projects SET status = 'expired' WHERE id = $1",
            [projectId],
          );
          await client.query(
            "UPDATE invitations SET status = 'revoked' WHERE project_id = $1 AND status = 'pending'",
            [projectId],
          );
          return this.copy(client, userId);
        },
      );
      await projectAccess(client, userId, result.projectId);
      return result;
    });
  }
  cleanupOwned(
    userId: string,
    projectId: string,
    input: { requestId: string },
  ) {
    return this.database.transaction(async (client) => {
      await this.lockOwner(client, userId);
      return idempotent(
        client,
        userId,
        `cleanup-trial:${projectId}`,
        input,
        async () => {
          const project = await projectAccess(client, userId, projectId);
          this.owner(project);
          await client.query(
            "UPDATE projects SET status = 'expired' WHERE id = $1",
            [projectId],
          );
          await client.query(
            "UPDATE invitations SET status = 'revoked' WHERE project_id = $1 AND status = 'pending'",
            [projectId],
          );
          return { projectId, cleaned: true };
        },
      );
    });
  }
  async cleanup() {
    await this.database.transaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM projects WHERE is_trial AND (status = 'expired' OR expires_at <= now()) LIMIT 100 FOR UPDATE SKIP LOCKED`,
      );
      for (const row of rows) {
        await client.query(
          'INSERT INTO object_cleanup(object_key) SELECT object_key FROM attachments WHERE project_id = $1 ON CONFLICT DO NOTHING',
          [row.id],
        );
        await client.query('DELETE FROM notifications WHERE project_id = $1', [
          row.id,
        ]);
        await client.query('DELETE FROM projects WHERE id = $1', [row.id]);
      }
    });
  }
  private async lockOwner(client: pg.PoolClient, userId: string) {
    await client.query('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE', [
      userId,
    ]);
    await client.query(
      "UPDATE projects SET status = 'expired' WHERE owner_id = $1 AND is_trial AND status <> 'expired' AND expires_at <= now()",
      [userId],
    );
  }
  private owner(project: { isTrial: boolean; role: string }) {
    if (!project.isTrial || project.role !== 'Owner')
      throw new ForbiddenException(
        'Only the current trial Owner can reset or clean up this trial.',
      );
  }
  private async copy(client: pg.PoolClient, userId: string) {
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM projects WHERE owner_id = $1 AND is_trial AND status = 'active' AND expires_at > now()",
      [userId],
    );
    if (existing.rows[0])
      throw new HttpException(
        {
          code: 'TRIAL_ALREADY_EXISTS',
          message:
            'You already own an active trial. Open it, reset it, or clean it up before starting another.',
        },
        409,
      );
    const projectId = randomUUID();
    const created = await client.query<{ expiresAt: Date }>(
      `INSERT INTO projects(id, owner_id, name, description, is_trial, expires_at, board_revision) VALUES ($1, $2, 'Your sample project', 'An isolated seven-day trial. All changes belong to this project.', true, now() + interval '7 days', 1) RETURNING expires_at AS "expiresAt"`,
      [projectId, userId],
    );
    await client.query(
      "INSERT INTO project_members(project_id, user_id, role) VALUES ($1,$2,'Owner')",
      [projectId, userId],
    );
    await recordChange(client, {
      actorId: userId,
      projectId,
      taskId: null,
      entityId: projectId,
      action: 'project.created',
      version: 1,
      revision: 1,
      summary: { isTrial: true },
    });
    for (const original of sampleBoard.tasks) {
      const taskId = randomUUID();
      await client.query(
        'INSERT INTO tasks(id, project_id, creator_id, title, description, status, priority, position, due_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          taskId,
          projectId,
          userId,
          original.title,
          original.description,
          original.status,
          original.priority,
          original.position,
          original.dueDate,
        ],
      );
      await recordChange(client, {
        actorId: userId,
        projectId,
        taskId,
        entityId: taskId,
        action: 'task.created',
        version: 1,
        revision: 1,
      });
      for (let index = 0; index < original.commentCount; index++) {
        const id = randomUUID();
        await client.query(
          'INSERT INTO comments(id, project_id, task_id, author_id, body) VALUES ($1,$2,$3,$4,$5)',
          [
            id,
            projectId,
            taskId,
            userId,
            `Sample discussion ${index + 1}: Add context, agree on a next step, and keep your team informed.`,
          ],
        );
        await recordChange(client, {
          actorId: userId,
          projectId,
          taskId,
          entityId: id,
          action: 'comment.created',
          version: 1,
          revision: 1,
          summary: { commentId: id, version: 1 },
        });
      }
    }
    return {
      projectId,
      expiresAt: new Date(created.rows[0]!.expiresAt).toISOString(),
    };
  }
}
