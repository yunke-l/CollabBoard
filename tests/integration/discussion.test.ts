import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  sql,
  service,
  discussion,
  owner,
  other,
  createProject,
  createTask,
  joinedProject,
  editInput,
  projectAction,
  taskAction,
  withConcurrentService,
} from './database-fixture';
import { localIdentities } from '../../apps/api/src/adapters/identity/local-identities';

describe('versioned comments and immutable activity', () => {
  it('creates comments with real counts, a shared revision, activity, outbox, and a body-free idempotent acknowledgement', async () => {
    const { project } = await joinedProject();
    const { task } = await service.createTask(owner, project.id, createTask());
    const input = { body: 'Private discussion text', requestId: randomUUID() };
    const result = await discussion.create(other, task.id, input);
    expect(await discussion.create(other, task.id, input)).toEqual(result);
    expect(result).not.toHaveProperty('body');
    expect(result.boardRevision).toBe(3);
    expect(await discussion.comment(owner, result.commentId)).toMatchObject({
      body: input.body,
      authorId: other,
      authorName: localIdentities[1]!.displayName,
      version: 1,
    });
    expect(await service.task(owner, task.id)).toMatchObject({
      commentCount: 1,
      version: 1,
    });
    expect(
      (await service.board(other, project.id)).tasks[0]!.commentCount,
    ).toBe(1);
    for (const table of ['activity', 'outbox_events'])
      expect(
        (await sql.query(`SELECT count(*)::int AS count FROM ${table}`))
          .rows[0]!.count,
      ).toBe(5);
    expect(
      JSON.stringify(
        (await sql.query('SELECT result FROM idempotency_records')).rows,
      ),
    ).not.toContain(input.body);
    const feed = await discussion.activity(other, project.id, task.id);
    expect(feed.items.map((entry) => entry.action)).toContain(
      'comment.created',
    );
    expect(
      feed.items.find((entry) => entry.action === 'comment.created'),
    ).toMatchObject({
      actorId: other,
      changes: { commentId: result.commentId, version: 1 },
    });
  });

  it('enforces authorship and Owner moderation without letting Owners edit someone else comments', async () => {
    const { project } = await joinedProject();
    const { task } = await service.createTask(owner, project.id, createTask());
    const own = await discussion.create(owner, task.id, {
      body: 'Owner comment',
      requestId: randomUUID(),
    });
    const theirs = await discussion.create(other, task.id, {
      body: 'Editor comment',
      requestId: randomUUID(),
    });
    await expect(
      discussion.update(owner, theirs.commentId, {
        body: 'Replaced',
        expectedVersion: 1,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      discussion.update(other, own.commentId, {
        body: 'Replaced',
        expectedVersion: 1,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      discussion.delete(other, own.commentId, {
        expectedVersion: 1,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (
        await discussion.delete(owner, theirs.commentId, {
          expectedVersion: 1,
          requestId: randomUUID(),
        })
      ).version,
    ).toBe(2);
    expect((await discussion.comment(other, theirs.commentId)).body).toBeNull();
  });

  it('detects comment conflicts and never returns deleted bodies through reads, history, or replay', async () => {
    const project = await service.create(owner, createProject());
    const { task } = await service.createTask(owner, project.id, createTask());
    const input = { body: 'Original secret comment', requestId: randomUUID() };
    const created = await discussion.create(owner, task.id, input);
    const update = {
      body: 'Edited secret comment',
      expectedVersion: 1,
      requestId: randomUUID(),
    };
    const edited = await discussion.update(owner, created.commentId, update);
    expect(
      (await discussion.comment(owner, created.commentId)).editedAt,
    ).toBeTruthy();
    await expect(
      discussion.update(owner, created.commentId, {
        ...update,
        body: 'Stale draft',
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'VERSION_CONFLICT' } });
    const deletion = { expectedVersion: 2, requestId: randomUUID() };
    const removed = await discussion.delete(owner, created.commentId, deletion);
    expect(await discussion.delete(owner, created.commentId, deletion)).toEqual(
      removed,
    );
    expect(await discussion.create(owner, task.id, input)).toEqual(created);
    expect(await discussion.update(owner, created.commentId, update)).toEqual(
      edited,
    );
    const tombstone = await discussion.comment(owner, created.commentId);
    expect(tombstone).toMatchObject({ version: 3, body: null });
    expect(tombstone.deletedAt).toBeTruthy();
    expect((await discussion.comments(owner, task.id)).items).toEqual([
      tombstone,
    ]);
    expect((await service.task(owner, task.id)).commentCount).toBe(0);
    expect(
      (
        await sql.query('SELECT body FROM comments WHERE id = $1', [
          created.commentId,
        ])
      ).rows[0]!.body,
    ).toBeNull();
    const serialized = JSON.stringify([
      await discussion.activity(owner, project.id),
      (await sql.query('SELECT result FROM idempotency_records')).rows,
    ]);
    expect(serialized).not.toContain(input.body);
    expect(serialized).not.toContain(update.body);
    await expect(
      discussion.update(owner, created.commentId, {
        body: 'Revive',
        expectedVersion: 3,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'COMMENT_DELETED' } });
  });

  it('allows authorized deletion on archived tasks and freezes every mutation on archived projects', async () => {
    const { project } = await joinedProject();
    const { task } = await service.createTask(owner, project.id, createTask());
    const own = await discussion.create(owner, task.id, {
      body: 'Keep for moderation',
      requestId: randomUUID(),
    });
    const first = await discussion.create(other, task.id, {
      body: 'Editor one',
      requestId: randomUUID(),
    });
    const second = await discussion.create(other, task.id, {
      body: 'Editor two',
      requestId: randomUUID(),
    });
    await service.setTaskArchived(owner, task.id, true, taskAction(task));
    await expect(
      discussion.create(other, task.id, {
        body: 'Too late',
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'TASK_ARCHIVED' } });
    await expect(
      discussion.update(other, first.commentId, {
        body: 'Too late',
        expectedVersion: 1,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'TASK_ARCHIVED' } });
    await discussion.delete(other, first.commentId, {
      expectedVersion: 1,
      requestId: randomUUID(),
    });
    await discussion.delete(owner, second.commentId, {
      expectedVersion: 1,
      requestId: randomUUID(),
    });
    await service.setProjectArchived(
      owner,
      project.id,
      true,
      await projectAction(project.id),
    );
    for (const write of [
      () =>
        discussion.create(owner, task.id, {
          body: 'Blocked',
          requestId: randomUUID(),
        }),
      () =>
        discussion.update(owner, own.commentId, {
          body: 'Blocked',
          expectedVersion: 1,
          requestId: randomUUID(),
        }),
      () =>
        discussion.delete(owner, own.commentId, {
          expectedVersion: 1,
          requestId: randomUUID(),
        }),
    ])
      await expect(write()).rejects.toMatchObject({
        response: { code: 'PROJECT_ARCHIVED' },
      });
    expect((await discussion.comments(other, task.id)).items).toHaveLength(3);
    expect(
      (await discussion.activity(other, project.id, task.id)).items.length,
    ).toBeGreaterThan(0);
    await service.setProjectArchived(
      owner,
      project.id,
      false,
      await projectAction(project.id),
    );
    await discussion.delete(owner, own.commentId, {
      expectedVersion: 1,
      requestId: randomUUID(),
    });
    expect((await service.task(owner, task.id)).commentCount).toBe(0);
  });

  it('rechecks downgrades and removal before fresh writes and successful mutation replay', async () => {
    const { project } = await joinedProject();
    const { task } = await service.createTask(owner, project.id, createTask());
    const input = {
      body: 'Membership-sensitive comment',
      requestId: randomUUID(),
    };
    const created = await discussion.create(other, task.id, input);
    await service.changeMember(owner, project.id, other, {
      role: 'Viewer',
      requestId: randomUUID(),
    });
    expect((await discussion.comment(other, created.commentId)).body).toBe(
      input.body,
    );
    for (const write of [
      () => discussion.create(other, task.id, input),
      () =>
        discussion.update(other, created.commentId, {
          body: 'Forbidden',
          expectedVersion: 1,
          requestId: randomUUID(),
        }),
      () =>
        discussion.delete(other, created.commentId, {
          expectedVersion: 1,
          requestId: randomUUID(),
        }),
    ])
      await expect(write()).rejects.toMatchObject({ status: 403 });
    await service.changeMember(owner, project.id, other, {
      requestId: randomUUID(),
    });
    for (const read of [
      () => discussion.comments(other, task.id),
      () => discussion.comment(other, created.commentId),
      () => discussion.activity(other, project.id),
      () => discussion.create(other, task.id, input),
    ])
      await expect(read()).rejects.toMatchObject({ status: 404 });
  });

  it('rolls comment writes back when their outbox event fails', async () => {
    const project = await service.create(owner, createProject());
    const { task } = await service.createTask(owner, project.id, createTask());
    const created = await discussion.create(owner, task.id, {
      body: 'Preserved original',
      requestId: randomUUID(),
    });
    const before = await service.board(owner, project.id);
    const history = await discussion.activity(owner, project.id);
    await sql.query(
      "ALTER TABLE outbox_events ADD CONSTRAINT reject_comment_events CHECK (event_type NOT IN ('comment.created', 'comment.updated', 'comment.deleted')) NOT VALID",
    );
    try {
      for (const write of [
        () =>
          discussion.create(owner, task.id, {
            body: 'Rollback create',
            requestId: randomUUID(),
          }),
        () =>
          discussion.update(owner, created.commentId, {
            body: 'Rollback edit',
            expectedVersion: 1,
            requestId: randomUUID(),
          }),
        () =>
          discussion.delete(owner, created.commentId, {
            expectedVersion: 1,
            requestId: randomUUID(),
          }),
      ])
        await expect(write()).rejects.toThrow();
    } finally {
      await sql.query(
        'ALTER TABLE outbox_events DROP CONSTRAINT reject_comment_events',
      );
    }
    expect(await service.board(owner, project.id)).toEqual(before);
    expect(await discussion.activity(owner, project.id)).toEqual(history);
    expect(await discussion.comment(owner, created.commentId)).toMatchObject({
      version: 1,
      body: 'Preserved original',
      deletedAt: null,
      editedAt: null,
    });
    expect((await discussion.comments(owner, task.id)).items).toHaveLength(1);
  });

  it('paginates comments and activity at equal microseconds without mixing tasks or cursor scopes', async () => {
    const { project } = await joinedProject('Viewer');
    const { task } = await service.createTask(owner, project.id, createTask());
    for (let index = 0; index < 25; index++)
      await discussion.create(owner, task.id, {
        body: `Paged comment ${index}`,
        requestId: randomUUID(),
      });
    await sql.query(
      "UPDATE comments SET created_at = date_trunc('day', now()) - interval '1 day' + interval '0.123456 seconds' WHERE task_id = $1",
      [task.id],
    );
    await sql.query(
      "UPDATE activity SET created_at = date_trunc('day', now()) - interval '1 day' + interval '0.123456 seconds' WHERE task_id = $1",
      [task.id],
    );
    const first = await discussion.comments(other, task.id);
    const second = await discussion.comments(other, task.id, first.nextCursor!);
    expect(first.items).toHaveLength(20);
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)).size,
    ).toBe(25);
    expect(
      (await discussion.comments(other, task.id, undefined, 100)).items,
    ).toHaveLength(25);
    const feed = await discussion.activity(other, project.id, task.id);
    await discussion.create(owner, task.id, {
      body: 'Newer arrival',
      requestId: randomUUID(),
    });
    const rest = await discussion.activity(
      other,
      project.id,
      task.id,
      feed.nextCursor!,
    );
    expect(feed.items).toHaveLength(20);
    expect(rest.items).toHaveLength(6);
    expect(
      new Set([...feed.items, ...rest.items].map((entry) => entry.id)).size,
    ).toBe(26);
    expect(
      (await discussion.activity(other, project.id, task.id, undefined, 100))
        .items,
    ).toHaveLength(27);
    const different = await service.createTask(owner, project.id, createTask());
    await expect(
      discussion.comments(other, different.task.id, first.nextCursor!),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CURSOR' } });
    await expect(
      discussion.activity(other, project.id, undefined, feed.nextCursor!),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CURSOR' } });
    const separate = await service.create(owner, createProject());
    await expect(
      discussion.activity(owner, separate.id, task.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      discussion.comments(other, task.id, undefined, 101),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('presents task changes, historical member names, actor attribution, and no invitation credentials', async () => {
    const { project, invitation } = await joinedProject();
    const { task } = await service.createTask(owner, project.id, {
      ...createTask(),
      assigneeId: other,
    });
    await service.updateTask(owner, task.id, {
      ...editInput(task),
      title: 'Changed title',
      assigneeId: owner,
    });
    await service.changeMember(owner, project.id, other, {
      role: 'Viewer',
      requestId: randomUUID(),
    });
    await service.changeMember(owner, project.id, other, {
      requestId: randomUUID(),
    });
    const feed = await discussion.activity(owner, project.id);
    const update = feed.items.find((entry) => entry.action === 'task.updated')!;
    expect(update).toMatchObject({
      actorId: owner,
      changes: {
        before: { title: 'First task', assigneeId: other },
        after: { title: 'Changed title', assigneeId: owner },
      },
    });
    expect(update.people).toMatchObject({
      [other]: localIdentities[1]!.displayName,
      [owner]: localIdentities[0]!.displayName,
    });
    expect(
      feed.items.find((entry) => entry.action === 'member.removed')!.people[
        other
      ],
    ).toBe(localIdentities[1]!.displayName);
    expect(JSON.stringify(feed)).not.toContain(invitation.token);
    expect(JSON.stringify(feed)).not.toContain('token_hash');
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'deduplicates concurrent comment creation and rejects a competing stale edit',
    async () => {
      const { project } = await joinedProject();
      const { task } = await service.createTask(
        owner,
        project.id,
        createTask(),
      );
      const input = { body: 'Concurrent comment', requestId: randomUUID() };
      await withConcurrentService(
        async (_projects, _notifications, concurrent) => {
          const created = await Promise.all([
            concurrent.create(other, task.id, input),
            concurrent.create(other, task.id, input),
          ]);
          expect(created[0]).toEqual(created[1]);
          const results = await Promise.allSettled(
            ['One', 'Two'].map((body) =>
              concurrent.update(other, created[0]!.commentId, {
                body,
                expectedVersion: 1,
                requestId: randomUUID(),
              }),
            ),
          );
          expect(
            results.filter((result) => result.status === 'fulfilled'),
          ).toHaveLength(1);
          const rejected = results.find(
            (result) => result.status === 'rejected',
          );
          expect(
            rejected?.status === 'rejected' ? rejected.reason : null,
          ).toMatchObject({ response: { code: 'VERSION_CONFLICT' } });
        },
      );
      expect((await discussion.comments(owner, task.id)).items).toHaveLength(1);
      expect((await service.task(owner, task.id)).commentCount).toBe(1);
    },
  );

  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'serializes comment editing and deletion without resurrecting a deleted body',
    async () => {
      const project = await service.create(owner, createProject());
      const { task } = await service.createTask(
        owner,
        project.id,
        createTask(),
      );
      const comment = await discussion.create(owner, task.id, {
        body: 'Original',
        requestId: randomUUID(),
      });
      await withConcurrentService(
        async (_projects, _notifications, concurrent) => {
          const results = await Promise.allSettled([
            concurrent.update(owner, comment.commentId, {
              body: 'New version',
              expectedVersion: 1,
              requestId: randomUUID(),
            }),
            concurrent.delete(owner, comment.commentId, {
              expectedVersion: 1,
              requestId: randomUUID(),
            }),
          ]);
          expect(
            results.filter((result) => result.status === 'fulfilled'),
          ).toHaveLength(1);
          const final = await concurrent.comment(owner, comment.commentId);
          expect(final.version).toBe(2);
          expect(final.body).toBe(final.deletedAt ? null : 'New version');
          expect((await service.task(owner, task.id)).commentCount).toBe(
            final.deletedAt ? 0 : 1,
          );
        },
      );
    },
  );

  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'rechecks membership after waiting for the project lock',
    async () => {
      const { project } = await joinedProject();
      const { task } = await service.createTask(
        owner,
        project.id,
        createTask(),
      );
      const blocker = new pg.Client({
        connectionString: process.env.DATABASE_URL,
      });
      await blocker.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT id FROM projects WHERE id = $1 FOR UPDATE',
          [project.id],
        );
        await withConcurrentService(
          async (_projects, _notifications, concurrent) => {
            const pending = concurrent
              .create(other, task.id, {
                body: 'Must not be committed',
                requestId: randomUUID(),
              })
              .then(
                (result) => result,
                (error: unknown) => error,
              );
            let waiting = false;
            for (let attempt = 0; attempt < 100; attempt++) {
              const state = await sql.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name = current_setting('application_name') AND wait_event_type = 'Lock' AND query LIKE 'SELECT id FROM projects WHERE id = %' LIMIT 1",
              );
              if (state.rows.length) {
                waiting = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            await blocker.query(
              "UPDATE project_members SET role = 'Viewer' WHERE project_id = $1 AND user_id = $2",
              [project.id, other],
            );
            await blocker.query('COMMIT');
            expect(waiting).toBe(true);
            expect(await pending).toMatchObject({ status: 403 });
          },
        );
      } finally {
        await blocker.query('ROLLBACK');
        await blocker.end();
      }
      expect((await discussion.comments(owner, task.id)).items).toEqual([]);
    },
  );
});
