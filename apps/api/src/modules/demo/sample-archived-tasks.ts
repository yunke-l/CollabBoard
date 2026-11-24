import type pg from 'pg';
import { limits } from '@collabboard/contracts';

export async function seedSampleArchivedTasks(
  client: pg.PoolClient,
  projectId: string,
) {
  // Stable per-project IDs keep renamed or restored examples intact on later seeds.
  await client.query(
    `INSERT INTO tasks(id, project_id, creator_id, title, description, status, priority, position, archived_at)
     SELECT (left(p.id::text, 24) || right(md5(p.id::text || sample.key), 12))::uuid,
            p.id, p.owner_id, sample.title, sample.description, sample.status, sample.priority, 0, now()
     FROM projects p CROSS JOIN (VALUES
       ('kickoff', 'Publish the kickoff notes', 'The team approved the launch scope and published the meeting notes.', 'done', 'medium'),
       ('navigation', 'Prototype the alternate navigation', 'The team chose the simpler navigation after the first usability review.', 'in_progress', 'high'),
       ('survey', 'Draft the beta signup survey', 'Customer interviews replaced the planned signup survey.', 'todo', 'low')
     ) AS sample(key, title, description, status, priority)
     WHERE p.id = $1
     ORDER BY sample.key
     LIMIT GREATEST(0, $2 - (SELECT count(*) FROM tasks WHERE project_id = $1))
     ON CONFLICT (id) DO NOTHING`,
    [projectId, limits.totalTasks],
  );
}
