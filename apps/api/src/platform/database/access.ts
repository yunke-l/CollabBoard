import {
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type pg from 'pg';
import type { Project } from '@collabboard/contracts';

export async function projectAccess(
  client: pg.PoolClient,
  userId: string,
  projectId: string,
) {
  await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [
    projectId,
  ]);
  const { rows } = await client.query<Project>(
    `SELECT p.id, p.name, p.description, p.status, p.board_revision AS "boardRevision", p.created_at::text AS "createdAt", m.role FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = $2 WHERE p.id = $1 AND p.status <> 'expired'`,
    [projectId, userId],
  );
  if (!rows[0])
    throw new NotFoundException('Project not found or no longer accessible.');
  return rows[0];
}
export async function taskAccess(
  client: pg.PoolClient,
  userId: string,
  taskId: string,
) {
  const { rows } = await client.query<{ projectId: string }>(
    'SELECT project_id AS "projectId" FROM tasks WHERE id = $1',
    [taskId],
  );
  if (!rows[0])
    throw new NotFoundException('Task not found or no longer accessible.');
  const project = await projectAccess(client, userId, rows[0].projectId);
  const task = await client.query<{ archived: boolean }>(
    'SELECT archived_at IS NOT NULL AS archived FROM tasks WHERE id = $1',
    [taskId],
  );
  if (!task.rows[0])
    throw new NotFoundException('Task not found or no longer accessible.');
  return { project, taskId, archived: task.rows[0].archived };
}
export function contentWrite(
  project: Pick<Project, 'role' | 'status'>,
  archived = false,
) {
  if (project.status !== 'active')
    throw new HttpException(
      {
        code: 'PROJECT_ARCHIVED',
        message: 'Restore this project before making changes.',
      },
      409,
    );
  if (project.role === 'Viewer')
    throw new ForbiddenException(
      'Only Owners and Editors can make this change.',
    );
  if (archived)
    throw new HttpException(
      {
        code: 'TASK_ARCHIVED',
        message: 'Restore this task before adding attachments.',
      },
      409,
    );
}
