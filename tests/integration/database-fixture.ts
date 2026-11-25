import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import type {
  CreateProject,
  CreateTask,
  InitializeAttachment,
} from '@collabboard/contracts';
import { ProjectsService } from '../../apps/api/src/modules/projects/projects.service';
import { NotificationsService } from '../../apps/api/src/modules/notifications/notifications.service';
import { DiscussionService } from '../../apps/api/src/modules/discussion/discussion.service';
import { FilesService } from '../../apps/api/src/modules/files/files.service';
import { LocalPrivateStorage } from '../../apps/api/src/platform/storage/private-storage';
import { Database } from '../../apps/api/src/platform/database/database';
import { localIdentities } from '../../apps/api/src/adapters/identity/local-identities';

import { createTestSchema } from './postgres-schema';

type Sql = {
  query: (
    sql: string,
    parameters?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
  end?: () => Promise<void>;
  close?: () => Promise<void>;
  exec?: (sql: string) => Promise<unknown>;
};
export let sql: Sql;
export let service: ProjectsService;
export let notifications: NotificationsService;
export let discussion: DiscussionService;
export let database: Database;
export let files: FilesService;
export let storage: LocalPrivateStorage;
export let storageRoot: string;
export const owner = localIdentities[0]!.id;
export const other = localIdentities[1]!.id;
export const createProject = (): CreateProject => ({
  name: 'Launch',
  description: 'A focused launch.',
  requestId: randomUUID(),
});
export const createTask = (): CreateTask => ({
  title: 'First task',
  description: '',
  status: 'todo',
  priority: 'medium',
  dueDate: null,
  assigneeId: null,
  requestId: randomUUID(),
});

let schema: Awaited<ReturnType<typeof createTestSchema>> | undefined;

beforeAll(async () => {
  if (process.env.TEST_DATABASE_URL) {
    schema = await createTestSchema(process.env.TEST_DATABASE_URL);
    vi.stubEnv('DATABASE_URL', schema.url);
    database = new Database();
    // Fixture SQL uses a single connection for explicit BEGIN/COMMIT pairs.
    const client = new pg.Client({
      connectionString: schema.url,
    });
    sql = client;
    await client.connect();
  } else {
    const embedded = new PGlite();
    sql = embedded as unknown as Sql;
    database = {
      pool: embedded,
      transaction: (work: (client: Sql) => Promise<unknown>) =>
        embedded.transaction(work),
    } as unknown as Database;
  }
  const migrations = new URL('../../apps/api/migrations/', import.meta.url);
  for (const name of (await readdir(migrations))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const migration = await readFile(new URL(name, migrations), 'utf8');
    if (sql.exec) await sql.exec(migration);
    else await sql.query(migration);
  }
  service = new ProjectsService(database);
  notifications = new NotificationsService(database);
  discussion = new DiscussionService(database);
  storageRoot = await mkdtemp(join(tmpdir(), 'collabboard-files-'));
  storage = new LocalPrivateStorage(storageRoot);
  files = new FilesService(database, storage);
});
beforeEach(async () => {
  await sql.query('TRUNCATE users CASCADE');
  await sql.query('TRUNCATE rate_limits, object_cleanup');
  for (const user of localIdentities)
    await sql.query(
      'INSERT INTO users (id, identity_subject, email, display_name) VALUES ($1, $2, $3, $4)',
      [user.id, `local:${user.id}`, user.email, user.displayName],
    );
});
afterAll(async () => {
  if (database instanceof Database) await database.beforeApplicationShutdown();
  vi.unstubAllEnvs();
  await sql?.end?.();
  await sql?.close?.();
  await schema?.close();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

export const inviteInput = (role: 'Editor' | 'Viewer' = 'Editor') => ({
  email: localIdentities[1]!.email,
  role,
  token: randomBytes(32).toString('hex'),
  requestId: randomUUID(),
});
export async function joinedProject(role: 'Editor' | 'Viewer' = 'Editor') {
  const project = await service.create(owner, createProject());
  const invitation = inviteInput(role);
  await service.createInvitation(owner, project.id, invitation);
  await service.acceptInvitation(localIdentities[1]!, {
    token: invitation.token,
    requestId: randomUUID(),
  });
  return { project, invitation };
}
export const editInput = (
  task: Awaited<ReturnType<ProjectsService['task']>>,
) => ({
  title: task.title,
  description: task.description,
  priority: task.priority,
  dueDate: task.dueDate,
  assigneeId: task.assigneeId,
  expectedVersion: task.version,
  requestId: randomUUID(),
});

export const projectAction = async (projectId: string, userId = owner) => ({
  expectedBoardRevision: (await service.details(userId, projectId))
    .boardRevision,
  requestId: randomUUID(),
});
export const taskAction = (task: { version: number }) => ({
  expectedVersion: task.version,
  requestId: randomUUID(),
});

export async function fillTasks(
  projectId: string,
  count: number,
  archived = false,
) {
  const values = Array.from({ length: count }, (_, position) => ({
    id: randomUUID(),
    position,
  }));
  await sql.query(
    `INSERT INTO tasks(id, project_id, creator_id, title, position, archived_at) SELECT item.id, $1, $2, 'Quota task', item.position, CASE WHEN $4 THEN now() ELSE NULL END FROM jsonb_to_recordset($3::jsonb) AS item(id uuid, position int)`,
    [projectId, owner, JSON.stringify(values), archived],
  );
}

export function actionForRevision(expectedBoardRevision: number) {
  return { expectedBoardRevision, requestId: randomUUID() };
}

export async function withConcurrentService(
  work: (
    concurrent: ProjectsService,
    concurrentNotifications: NotificationsService,
    concurrentDiscussion: DiscussionService,
    concurrentFiles: FilesService,
    concurrentDatabase: Database,
  ) => Promise<void>,
) {
  const database = new Database();
  try {
    await work(
      new ProjectsService(database),
      new NotificationsService(database),
      new DiscussionService(database),
      new FilesService(database, storage),
      database,
    );
  } finally {
    await database.beforeApplicationShutdown();
  }
}

export const fileInput = (
  originalName = 'notes.txt',
  sizeBytes = 5,
  mediaType: InitializeAttachment['mediaType'] = 'text/plain',
) => ({ originalName, sizeBytes, mediaType, requestId: randomUUID() });
export async function readyFile(
  userId: string,
  taskId: string,
  name = 'notes.txt',
) {
  const initialized = await files.initialize(userId, taskId, fileInput(name));
  await files.upload(
    userId,
    initialized.attachment.id,
    initialized.upload.token,
    Buffer.from('Hello'),
  );
  await files.complete(userId, initialized.attachment.id, {
    requestId: randomUUID(),
  });
  return initialized.attachment;
}
