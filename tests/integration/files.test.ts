import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  sql,
  service,
  discussion,
  files,
  storage,
  owner,
  other,
  createProject,
  createTask,
  joinedProject,
  fileInput,
  readyFile,
} from './database-fixture';

describe('private attachment lifecycle', () => {
  it('reserves once, validates uploaded bytes, serves authorized short-lived downloads, and counts ready files', async () => {
    const { project } = await joinedProject();
    const { task } = await service.createTask(owner, project.id, createTask());
    const input = fileInput('\u9879\u76ee.txt');
    const reservation = await files.initialize(other, task.id, input);
    const replay = await files.initialize(other, task.id, input);
    expect(replay.attachment.id).toBe(reservation.attachment.id);
    expect((await files.list(owner, task.id)).items).toEqual([]);
    expect((await service.task(owner, task.id)).attachmentCount).toBe(0);
    await expect(
      files.complete(other, reservation.attachment.id, {
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'UPLOAD_NOT_READY' } });
    await files.upload(
      other,
      reservation.attachment.id,
      reservation.upload.token,
      Buffer.from('Hello'),
    );
    const complete = { requestId: randomUUID() };
    expect(
      await files.complete(other, reservation.attachment.id, complete),
    ).toMatchObject({ state: 'ready' });
    await files.complete(other, reservation.attachment.id, complete);
    expect((await service.task(owner, task.id)).attachmentCount).toBe(1);
    expect((await files.list(owner, task.id)).items[0]).toMatchObject({
      originalName: '\u9879\u76ee.txt',
      uploaderId: other,
      uploaderActive: true,
    });
    const link = await files.download(owner, reservation.attachment.id);
    expect(new Date(link.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(
      60000,
    );
    expect(
      (await files.downloaded(link.url.split('/').at(-1)!)).body.toString(),
    ).toBe('Hello');
    const history = await discussion.activity(owner, project.id, task.id);
    expect(
      history.items
        .map((item) => item.action)
        .filter((action) => action === 'attachment.created'),
    ).toHaveLength(1);
    expect(JSON.stringify(history)).not.toContain(reservation.upload.token);
    expect(
      JSON.stringify(
        (await sql.query('SELECT result FROM idempotency_records')).rows,
      ),
    ).not.toContain(reservation.upload.token);
  });
  it('rejects oversized, mismatched, tampered, expired, and cross-upload authorizations', async () => {
    const project = await service.create(owner, createProject());
    const { task } = await service.createTask(owner, project.id, createTask());
    const first = await files.initialize(owner, task.id, fileInput());
    const second = await files.initialize(
      owner,
      task.id,
      fileInput('other.txt'),
    );
    await expect(
      files.upload(
        owner,
        first.attachment.id,
        first.upload.token,
        Buffer.from('Too long'),
      ),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      files.upload(
        owner,
        first.attachment.id,
        first.upload.token,
        Buffer.from('Hi'),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      files.upload(
        owner,
        second.attachment.id,
        first.upload.token,
        Buffer.from('Hello'),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      files.upload(
        owner,
        first.attachment.id,
        first.upload.token + 'x',
        Buffer.from('Hello'),
      ),
    ).rejects.toMatchObject({ status: 401 });
    const expired = await storage.sign({
      purpose: 'upload',
      id: first.attachment.id,
      userId: owner,
      expiresAt: Date.now() - 1,
    });
    await expect(
      files.upload(owner, first.attachment.id, expired, Buffer.from('Hello')),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      files.initialize(owner, task.id, fileInput('../secret.txt')),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      files.initialize(owner, task.id, fileInput('fake.pdf')),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('validates actual content, rejects disguised images, and releases rejected storage', async () => {
    const project = await service.create(owner, createProject());
    const { task } = await service.createTask(owner, project.id, createTask());
    const reservation = await files.initialize(
      owner,
      task.id,
      fileInput('fake.png', 5, 'image/png'),
    );
    await files.upload(
      owner,
      reservation.attachment.id,
      reservation.upload.token,
      Buffer.from('Hello'),
    );
    await expect(
      files.complete(owner, reservation.attachment.id, {
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_FILE' } });
    expect(
      (
        await sql.query('SELECT state FROM attachments WHERE id = $1', [
          reservation.attachment.id,
        ])
      ).rows[0]!.state,
    ).toBe('rejected');
    expect((await files.list(owner, task.id)).items).toEqual([]);
    await files.cleanup();
    expect(
      (
        await sql.query(
          'SELECT object_removed_at FROM attachments WHERE id = $1',
          [reservation.attachment.id],
        )
      ).rows[0]!.object_removed_at,
    ).not.toBeNull();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgZGL+DwABFAEG1rmmRQAAAABJRU5ErkJggg==',
      'base64',
    );
    const valid = await files.initialize(
      owner,
      task.id,
      fileInput('pixel.png', png.length, 'image/png'),
    );
    await files.upload(owner, valid.attachment.id, valid.upload.token, png);
    // The fixture's chunk checksums, not its filename, determine acceptance.
    const { validateFile } =
      await import('../../apps/api/src/modules/files/validate-file');
    expect(validateFile(Buffer.from('binary\0data'), 'text/plain')).toBe(false);
    expect(
      validateFile(
        Buffer.from('%PDF-1.7\n1 0 obj\nendobj\n%%EOF\n'),
        'application/pdf',
      ),
    ).toBe(true);
    expect(validateFile(png.subarray(0, 24), 'image/png')).toBe(false);
    expect(validateFile(png, 'image/png')).toBe(true);
    await files.complete(owner, valid.attachment.id, {
      requestId: randomUUID(),
    });
  });
  // Two 2×2 images encoded with Pillow. Both the full and truncated upload
  // declare their actual byte length so completion tests the file format.
  it.each([
    {
      name: 'pixel.jpg',
      mediaType: 'image/jpeg',
      base64:
        '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCOALiMf//Z',
    },
    {
      name: 'pixel.webp',
      mediaType: 'image/webp',
      base64:
        'UklGRjoAAABXRUJQVlA4IC4AAACQAQCdASoCAAIAAUAmJaACdLoAA5gA/vtV4/+lwf/S4P/pcH/pcH8bss4bpAAA',
    },
  ] as const)(
    'publishes a complete $mediaType image and rejects a truncated upload',
    async ({ name, mediaType, base64 }) => {
      const project = await service.create(owner, createProject());
      const { task } = await service.createTask(
        owner,
        project.id,
        createTask(),
      );
      const original = Buffer.from(base64, 'base64');
      const submit = async (body: Buffer) => {
        const { attachment, upload } = await files.initialize(
          owner,
          task.id,
          fileInput(name, body.length, mediaType),
        );
        await files.upload(owner, attachment.id, upload.token, body);
        return files.complete(owner, attachment.id, {
          requestId: randomUUID(),
        });
      };
      const ready = await submit(original);
      expect(ready.state).toBe('ready');
      await expect(submit(original.subarray(0, -2))).rejects.toMatchObject({
        response: { code: 'INVALID_FILE' },
      });
      expect(
        (await files.list(owner, task.id)).items.map((item) => item.id),
      ).toEqual([ready.attachmentId]);
    },
  );
  it('counts unexpired reservations against task slots and project bytes and releases expiry exactly once', async () => {
    const project = await service.create(owner, createProject());
    const { task } = await service.createTask(owner, project.id, createTask());
    for (let index = 0; index < 5; index++)
      await files.initialize(owner, task.id, fileInput());
    await expect(
      files.initialize(owner, task.id, fileInput()),
    ).rejects.toMatchObject({
      response: {
        code: 'ATTACHMENT_LIMIT_REACHED',
        quota: { used: 5, limit: 5 },
      },
    });
    await sql.query(
      "UPDATE attachments SET expires_at = now() - interval '1 second'",
    );
    await files.initialize(owner, task.id, fileInput());
    await files.cleanup();
    await files.cleanup();
    expect(
      (await sql.query("SELECT 1 FROM attachments WHERE state = 'expired'"))
        .rows,
    ).toHaveLength(5);
    await sql.query(
      "UPDATE attachments SET expires_at = now() - interval '1 second' WHERE state = 'pending'",
    );
    await files.cleanup();
    const tasks = [];
    for (let index = 0; index < 2; index++)
      tasks.push(
        (await service.createTask(owner, project.id, createTask())).task,
      );
    for (const target of tasks)
      for (let index = 0; index < 5; index++)
        await files.initialize(
          owner,
          target.id,
          fileInput('large.txt', 10 * 1024 * 1024),
        );
    await expect(
      files.initialize(owner, task.id, fileInput()),
    ).rejects.toMatchObject({ response: { code: 'STORAGE_LIMIT_REACHED' } });
  });
  it('enforces author and Owner deletion, current permissions at completion, and archived read access', async () => {
    const { project } = await joinedProject();
    const { task } = await service.createTask(owner, project.id, createTask());
    const owned = await readyFile(owner, task.id);
    await expect(
      files.delete(other, owned.id, { requestId: randomUUID() }),
    ).rejects.toMatchObject({ status: 403 });
    const theirs = await readyFile(other, task.id, 'editor.txt');
    const link = await files.download(other, theirs.id);
    await service.setTaskArchived(owner, task.id, true, {
      expectedVersion: 1,
      requestId: randomUUID(),
    });
    await expect(
      files.initialize(other, task.id, fileInput()),
    ).rejects.toMatchObject({ response: { code: 'TASK_ARCHIVED' } });
    expect((await files.list(other, task.id)).items).toHaveLength(2);
    await files.delete(owner, theirs.id, { requestId: randomUUID() });
    await expect(
      files.downloaded(link.url.split('/').at(-1)!),
    ).rejects.toMatchObject({ status: 404 });
    const board = await service.board(owner, project.id);
    await service.setProjectArchived(owner, project.id, true, {
      expectedBoardRevision: board.project.boardRevision,
      requestId: randomUUID(),
    });
    await expect(
      files.delete(owner, owned.id, { requestId: randomUUID() }),
    ).rejects.toMatchObject({ response: { code: 'PROJECT_ARCHIVED' } });
  });
  it('denies removed members and downgraded upload completion without trusting an old grant', async () => {
    const { project } = await joinedProject();
    const { task } = await service.createTask(owner, project.id, createTask());
    const pending = await files.initialize(other, task.id, fileInput());
    await files.upload(
      other,
      pending.attachment.id,
      pending.upload.token,
      Buffer.from('Hello'),
    );
    await service.changeMember(owner, project.id, other, {
      role: 'Viewer',
      requestId: randomUUID(),
    });
    await expect(
      files.complete(other, pending.attachment.id, { requestId: randomUUID() }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      files.upload(
        other,
        pending.attachment.id,
        pending.upload.token,
        Buffer.from('Hello'),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await service.changeMember(owner, project.id, other, {
      requestId: randomUUID(),
    });
    await expect(files.list(other, task.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      files.initialize(other, task.id, fileInput()),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('rolls back readiness and revision when attachment outbox persistence fails', async () => {
    const project = await service.create(owner, createProject());
    const { task } = await service.createTask(owner, project.id, createTask());
    const reservation = await files.initialize(owner, task.id, fileInput());
    await files.upload(
      owner,
      reservation.attachment.id,
      reservation.upload.token,
      Buffer.from('Hello'),
    );
    await sql.query(
      "ALTER TABLE outbox_events ADD CONSTRAINT reject_files CHECK (event_type NOT LIKE 'attachment.%') NOT VALID",
    );
    try {
      await expect(
        files.complete(owner, reservation.attachment.id, {
          requestId: randomUUID(),
        }),
      ).rejects.toThrow();
    } finally {
      await sql.query('ALTER TABLE outbox_events DROP CONSTRAINT reject_files');
    }
    expect((await service.task(owner, task.id)).attachmentCount).toBe(0);
    expect((await service.board(owner, project.id)).project.boardRevision).toBe(
      1,
    );
    expect(
      (
        await sql.query('SELECT state FROM attachments WHERE id = $1', [
          reservation.attachment.id,
        ])
      ).rows[0]!.state,
    ).toBe('pending');
  });
});
