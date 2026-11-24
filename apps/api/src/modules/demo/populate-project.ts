import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { recordChange } from '../../platform/database/changes.js';
import { seedSampleArchivedTasks } from './sample-archived-tasks.js';
import { seedSampleInvitations } from './sample-invitations.js';
import { sampleBoard } from './sample.js';

export async function populateSampleProject(
  client: pg.PoolClient,
  projectId: string,
  userId: string,
) {
  await seedSampleInvitations(client, projectId);
  await seedSampleArchivedTasks(client, projectId);
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
}
