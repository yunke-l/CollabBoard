import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import type pg from 'pg';
import {
  limits,
  type Attachment,
  type InitializeAttachment,
} from '@collabboard/contracts';
import { Database } from '../../platform/database/database.js';
import { contentWrite, taskAccess } from '../../platform/database/access.js';
import { idempotent } from '../../platform/database/idempotency.js';
import { recordChange } from '../../platform/database/changes.js';
import { nextCursor, readPage } from '../../platform/http/pagination.js';
import { quotaConflict } from '../../platform/observability/quota.js';
import { LocalPrivateStorage } from '../../platform/storage/private-storage.js';
import { validFilename, validateFile } from './validate-file.js';

const fields = `a.id, a.project_id AS "projectId", a.task_id AS "taskId", a.uploader_id AS "uploaderId", u.display_name AS "uploaderName", EXISTS(SELECT 1 FROM project_members m WHERE m.project_id = a.project_id AND m.user_id = a.uploader_id) AS "uploaderActive", a.original_name AS "originalName", a.size_bytes AS "sizeBytes", a.media_type AS "mediaType", a.version, a.created_at AS "createdAt"`;
type Row = Omit<Attachment, 'createdAt'> & {
  createdAt: Date;
  state: string;
  expiresAt: Date;
  objectKey: string;
};
type Grant = { purpose: string; id: string; userId: string; expiresAt: number };
const conflict = (code: string, message: string) =>
  new HttpException({ code, message }, 409);
const view = ({
  state: _state,
  expiresAt: _expiry,
  objectKey: _key,
  ...row
}: Row): Attachment => ({
  ...row,
  createdAt: new Date(row.createdAt).toISOString(),
});

@Injectable()
export class FilesService {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(LocalPrivateStorage) private readonly storage: LocalPrivateStorage,
  ) {}

  async list(userId: string, taskId: string, cursor?: string, limit = 20) {
    return this.database.transaction(async (client) => {
      await taskAccess(client, userId, taskId);
      const scope = `attachments:${taskId}`;
      const { boundary } = readPage(cursor, limit, scope);
      const { rows } = await client.query<Row>(
        `SELECT ${fields} FROM attachments a JOIN users u ON u.id = a.uploader_id WHERE a.task_id = $1 AND a.state = 'ready' AND ($2::timestamptz IS NULL OR (date_trunc('milliseconds', a.created_at), a.id) < ($2::timestamptz, $3::uuid)) ORDER BY date_trunc('milliseconds', a.created_at) DESC, a.id DESC LIMIT $4`,
        [taskId, boundary?.at ?? null, boundary?.id ?? null, limit + 1],
      );
      const items = rows.slice(0, limit).map(view);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > limit && last
            ? nextCursor(scope, last.createdAt, last.id)
            : null,
      };
    });
  }

  async initialize(
    userId: string,
    taskId: string,
    input: InitializeAttachment,
  ) {
    if (!validFilename(input.originalName, input.mediaType))
      throw new BadRequestException(
        'Use a filename extension that matches the selected file type.',
      );
    return this.database.transaction(async (client) => {
      const { project, archived } = await taskAccess(client, userId, taskId);
      contentWrite(project, archived);
      const result = await idempotent(
        client,
        userId,
        `initialize-attachment:${taskId}`,
        input,
        async () => {
          const usage = await client.query<{ slots: number; bytes: number }>(
            `SELECT count(*) FILTER (WHERE task_id = $2)::int AS slots, COALESCE(sum(size_bytes), 0)::int AS bytes FROM attachments WHERE project_id = $1 AND (state = 'ready' OR (state = 'pending' AND expires_at > now()))`,
            [project.id, taskId],
          );
          const used = usage.rows[0]!;
          if (used.slots >= limits.attachmentsPerTask)
            throw quotaConflict(
              'ATTACHMENT_LIMIT_REACHED',
              'attachmentsPerTask',
              used.slots,
              limits.attachmentsPerTask,
              'Delete an attachment or wait for an incomplete upload to expire.',
            );
          if (used.bytes + input.sizeBytes > limits.projectStorageBytes)
            throw quotaConflict(
              'STORAGE_LIMIT_REACHED',
              'projectStorageBytes',
              used.bytes,
              limits.projectStorageBytes,
              'Delete an attachment or wait for an incomplete upload to expire before uploading this file.',
            );
          const id = randomUUID();
          await client.query(
            'INSERT INTO attachments(id, project_id, task_id, uploader_id, object_key, original_name, size_bytes, media_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [
              id,
              project.id,
              taskId,
              userId,
              `${project.id}/${taskId}/${id}`,
              input.originalName,
              input.sizeBytes,
              input.mediaType,
            ],
          );
          return { attachmentId: id };
        },
      );
      const row = await this.row(client, result.attachmentId);
      if (row.state !== 'pending' || row.expiresAt.getTime() <= Date.now())
        throw conflict(
          'UPLOAD_EXPIRED',
          'This reservation is no longer available. Start a new upload.',
        );
      const expiresAt = Math.min(Date.now() + 300000, row.expiresAt.getTime());
      const token = await this.storage.sign({
        purpose: 'upload',
        id: row.id,
        userId,
        expiresAt,
      });
      return {
        attachment: view(row),
        upload: {
          path: `/api/attachments/${row.id}/content`,
          token,
          expiresAt: new Date(expiresAt).toISOString(),
        },
      };
    });
  }

  async upload(userId: string, id: string, token: string, body: Buffer) {
    const grant = await this.storage.verify<Grant>(token, 'upload');
    if (grant.id !== id || grant.userId !== userId)
      throw new ForbiddenException(
        'This upload authorization belongs to another upload.',
      );
    return this.database.transaction(async (client) => {
      const row = await this.authorized(client, userId, id);
      const { project, archived } = await taskAccess(
        client,
        userId,
        row.taskId,
      );
      contentWrite(project, archived);
      if (row.uploaderId !== userId)
        throw new ForbiddenException('Only the uploader can send this file.');
      if (row.state !== 'pending' || row.expiresAt.getTime() <= Date.now())
        throw conflict(
          'UPLOAD_EXPIRED',
          'This upload is no longer pending. Start a new upload.',
        );
      if (body.length > row.sizeBytes)
        throw new PayloadTooLargeException(
          'The file exceeds its reserved size.',
        );
      if (body.length !== row.sizeBytes)
        throw new BadRequestException(
          'The file size must match its reservation.',
        );
      await this.storage.put(row.objectKey, body);
      return { uploaded: true };
    });
  }

  async complete(userId: string, id: string, input: { requestId: string }) {
    const result = await this.database.transaction(async (client) => {
      const row = await this.authorized(client, userId, id);
      const { project, archived } = await taskAccess(
        client,
        userId,
        row.taskId,
      );
      contentWrite(project, archived);
      if (row.uploaderId !== userId)
        throw new ForbiddenException(
          'Only the uploader can complete this upload.',
        );
      return idempotent(
        client,
        userId,
        `complete-attachment:${id}`,
        input,
        async () => {
          if (row.state === 'ready')
            return { attachmentId: id, state: 'ready' };
          if (row.state !== 'pending' || row.expiresAt.getTime() <= Date.now())
            throw conflict(
              'UPLOAD_EXPIRED',
              'This upload expired. Start a new upload.',
            );
          let body;
          try {
            body = await this.storage.get(row.objectKey);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
              throw conflict(
                'UPLOAD_NOT_READY',
                'Upload the file before confirming it.',
              );
            throw error;
          }
          if (
            body.length !== row.sizeBytes ||
            !validateFile(body, row.mediaType)
          ) {
            await client.query(
              "UPDATE attachments SET state = 'rejected' WHERE id = $1",
              [id],
            );
            return { attachmentId: id, state: 'rejected' };
          }
          await client.query(
            "UPDATE attachments SET state = 'ready' WHERE id = $1",
            [id],
          );
          await this.changed(client, userId, row, 'attachment.created', 1);
          return { attachmentId: id, state: 'ready' };
        },
      );
    });
    if (result.state === 'rejected')
      throw conflict(
        'INVALID_FILE',
        'The actual file does not match its allowed type or size. Choose a valid file and start again.',
      );
    return result;
  }

  async delete(userId: string, id: string, input: { requestId: string }) {
    return this.database.transaction(async (client) => {
      const row = await this.authorized(client, userId, id);
      const { project } = await taskAccess(client, userId, row.taskId);
      contentWrite(project);
      if (row.uploaderId !== userId && project.role !== 'Owner')
        throw new ForbiddenException(
          'Only the uploader or Owner can delete this attachment.',
        );
      return idempotent(
        client,
        userId,
        `delete-attachment:${id}`,
        input,
        async () => {
          if (row.state !== 'deleted') {
            await client.query(
              "UPDATE attachments SET state = 'deleted', version = version + 1 WHERE id = $1",
              [id],
            );
            if (row.state === 'ready')
              await this.changed(
                client,
                userId,
                row,
                'attachment.deleted',
                row.version + 1,
              );
          }
          return { attachmentId: id, deleted: true };
        },
      );
    });
  }

  async download(userId: string, id: string) {
    return this.database.transaction(async (client) => {
      const row = await this.authorized(client, userId, id);
      if (row.state !== 'ready')
        throw new NotFoundException(
          'Attachment not found or no longer available.',
        );
      const expiresAt = Date.now() + 60000;
      const token = await this.storage.sign({
        purpose: 'download',
        id,
        userId,
        expiresAt,
      });
      return {
        url: `/api/downloads/${token}`,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    });
  }

  async downloaded(token: string) {
    const grant = await this.storage.verify<Grant>(token, 'download');
    return this.database.transaction(async (client) => {
      const row = await this.authorized(client, grant.userId, grant.id);
      if (row.state !== 'ready')
        throw new NotFoundException(
          'Attachment not found or no longer available.',
        );
      return {
        body: await this.storage.get(row.objectKey),
        name: row.originalName,
        type: row.mediaType,
      };
    });
  }

  async cleanup() {
    await this.database.pool.query(
      "UPDATE attachments SET state = 'expired' WHERE state = 'pending' AND expires_at <= now()",
    );
    const { rows } = await this.database.pool.query<{
      id: string;
      key: string;
    }>(
      "SELECT id, object_key AS key FROM attachments WHERE state IN ('deleted','rejected','expired') AND object_removed_at IS NULL LIMIT 100",
    );
    for (const row of rows) {
      await this.storage.remove(row.key);
      await this.database.pool.query(
        'UPDATE attachments SET object_removed_at = now() WHERE id = $1',
        [row.id],
      );
    }
  }

  private async row(client: pg.PoolClient, id: string) {
    const { rows } = await client.query<Row>(
      `SELECT ${fields}, a.state, a.expires_at AS "expiresAt", a.object_key AS "objectKey" FROM attachments a JOIN users u ON u.id = a.uploader_id WHERE a.id = $1`,
      [id],
    );
    if (!rows[0])
      throw new NotFoundException(
        'Attachment not found or no longer accessible.',
      );
    return rows[0];
  }
  private async authorized(client: pg.PoolClient, userId: string, id: string) {
    // Locate first, acquire the shared project lock, then read fresh state.
    const found = await client.query<{ taskId: string }>(
      'SELECT task_id AS "taskId" FROM attachments WHERE id = $1',
      [id],
    );
    if (!found.rows[0])
      throw new NotFoundException(
        'Attachment not found or no longer accessible.',
      );
    await taskAccess(client, userId, found.rows[0].taskId);
    return this.row(client, id);
  }
  private async changed(
    client: pg.PoolClient,
    actorId: string,
    row: Row,
    action: string,
    version: number,
  ) {
    const { rows } = await client.query<{ revision: number }>(
      'UPDATE projects SET board_revision = board_revision + 1 WHERE id = $1 RETURNING board_revision AS revision',
      [row.projectId],
    );
    await recordChange(client, {
      actorId,
      projectId: row.projectId,
      taskId: row.taskId,
      entityId: row.id,
      action,
      version,
      revision: rows[0]!.revision,
      summary: { attachmentId: row.id, originalName: row.originalName },
    });
  }
}
