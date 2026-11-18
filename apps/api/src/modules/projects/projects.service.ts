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
  projectCapabilities,
  type CreateProject,
  type CreateTask,
  type Project,
  type Task,
} from '@collabboard/contracts';
import { Database } from '../../platform/database/database.js';

type ProjectRow = Omit<Project, 'createdAt'> & { createdAt: Date };
const projectFields =
  'p.id, p.name, p.description, p.status, p.board_revision AS "boardRevision", p.created_at AS "createdAt", m.role';
const taskFields =
  't.id, t.project_id AS "projectId", t.title, t.description, t.status, t.priority, t.position, t.version, t.due_date::text AS "dueDate", t.archived_at::text AS "archivedAt", NULL AS "assigneeName", 0 AS "commentCount", 0 AS "attachmentCount"';
const projectView = (row: ProjectRow): Project => ({
  ...row,
  createdAt: new Date(row.createdAt).toISOString(),
});
const conflict = (code: string, message: string) =>
  new HttpException({ code, message }, 409);

@Injectable()
export class ProjectsService {
  constructor(@Inject(Database) private readonly database: Database) {}

  async list(userId: string) {
    const result = await this.database.pool.query<ProjectRow>(
      `SELECT ${projectFields} FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = $1 AND p.status <> 'expired' ORDER BY p.created_at DESC, p.id DESC`,
      [userId],
    );
    return { items: result.rows.map(projectView), nextCursor: null };
  }

  async create(userId: string, input: CreateProject) {
    return this.database.transaction(async (client) => {
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [
        userId,
      ]);
      return this.idempotent(
        client,
        userId,
        'create-project',
        input,
        async () => {
          const usage = await client.query<{ active: string; total: string }>(
            "SELECT count(*) FILTER (WHERE status = 'active') AS active, count(*) AS total FROM projects WHERE owner_id = $1 AND is_trial = false",
            [userId],
          );
          if (
            Number(usage.rows[0]?.active) >= limits.activeProjects ||
            Number(usage.rows[0]?.total) >= limits.totalProjects
          ) {
            throw conflict(
              'PROJECT_LIMIT_REACHED',
              'You can own up to 3 active projects and 10 total projects.',
            );
          }
          const id = randomUUID();
          await client.query(
            'INSERT INTO projects (id, owner_id, name, description) VALUES ($1, $2, $3, $4)',
            [id, userId, input.name, input.description],
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
            0,
          );
          return this.project(client, userId, id);
        },
      );
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
      return this.idempotent(
        client,
        userId,
        `create-task:${projectId}`,
        input,
        async () => {
          const usage = await client.query<{ active: string; total: string }>(
            'SELECT count(*) FILTER (WHERE archived_at IS NULL) AS active, count(*) AS total FROM tasks WHERE project_id = $1',
            [projectId],
          );
          if (
            Number(usage.rows[0]?.active) >= limits.activeTasks ||
            Number(usage.rows[0]?.total) >= limits.totalTasks
          )
            throw conflict(
              'TASK_LIMIT_REACHED',
              'This project has reached its task limit.',
            );
          const id = randomUUID();
          await client.query(
            'INSERT INTO tasks (id, project_id, creator_id, title, description, status, priority, due_date, position) SELECT $1, $2, $3, $4, $5, $6, $7, $8, COALESCE(max(position) + 1, 0) FROM tasks WHERE project_id = $2 AND status = $6 AND archived_at IS NULL',
            [
              id,
              projectId,
              userId,
              input.title,
              input.description,
              input.status,
              input.priority,
              input.dueDate,
            ],
          );
          const revision = project.boardRevision + 1;
          await client.query(
            'UPDATE projects SET board_revision = $2 WHERE id = $1',
            [projectId, revision],
          );
          await this.recordChange(
            client,
            userId,
            projectId,
            id,
            'task.created',
            1,
            revision,
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

  private async project(
    client: pg.PoolClient,
    userId: string,
    id: string,
    lock = false,
  ) {
    const result = await client.query<ProjectRow>(
      `SELECT ${projectFields} FROM projects p JOIN project_members m ON m.project_id = p.id WHERE p.id = $1 AND m.user_id = $2 AND p.status <> 'expired' ${lock ? 'FOR UPDATE OF p' : ''}`,
      [id, userId],
    );
    if (!result.rows[0])
      throw new NotFoundException('Project not found or no longer accessible.');
    return projectView(result.rows[0]);
  }

  private async idempotent<T>(
    client: pg.PoolClient,
    userId: string,
    operation: string,
    input: { requestId: string },
    execute: () => Promise<T>,
  ): Promise<T> {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `${userId}:${operation}:${input.requestId}`,
    ]);
    const hash = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex');
    const existing = await client.query<{ payload_hash: string; result: T }>(
      'SELECT payload_hash, result FROM idempotency_records WHERE user_id = $1 AND operation = $2 AND request_id = $3 AND expires_at > now()',
      [userId, operation, input.requestId],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].payload_hash !== hash)
        throw conflict(
          'IDEMPOTENCY_KEY_REUSED',
          'This request ID was already used for different content.',
        );
      return existing.rows[0].result;
    }
    const result = await execute();
    await client.query(
      "INSERT INTO idempotency_records (user_id, operation, request_id, payload_hash, result) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, operation, request_id) DO UPDATE SET payload_hash = EXCLUDED.payload_hash, result = EXCLUDED.result, expires_at = now() + interval '24 hours'",
      [userId, operation, input.requestId, hash, JSON.stringify(result)],
    );
    return result;
  }

  private async recordChange(
    client: pg.PoolClient,
    userId: string,
    projectId: string,
    taskId: string | null,
    action: string,
    version: number,
    revision: number,
  ) {
    await client.query(
      'INSERT INTO activity (id, project_id, task_id, actor_id, action) VALUES ($1, $2, $3, $4, $5)',
      [randomUUID(), projectId, taskId, userId, action],
    );
    await client.query(
      'INSERT INTO outbox_events (event_id, project_id, entity_id, event_type, entity_version, board_revision) VALUES ($1, $2, $3, $4, $5, $6)',
      [randomUUID(), projectId, taskId ?? projectId, action, version, revision],
    );
  }
}
