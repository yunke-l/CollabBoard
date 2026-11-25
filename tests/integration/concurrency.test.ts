import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type EventHint } from '@collabboard/contracts';
import {
  sql,
  service,
  owner,
  other,
  createProject,
  createTask,
  inviteInput,
  joinedProject,
  editInput,
  projectAction,
  taskAction,
  fillTasks,
  withConcurrentService,
  fileInput,
} from './database-fixture';
import { DispatcherService } from '../../apps/api/src/modules/events/dispatcher.service';
import { consumeRate } from '../../apps/api/src/platform/http/rate-limit';
import { localIdentities } from '../../apps/api/src/adapters/identity/local-identities';

describe('multi-connection PostgreSQL concurrency', () => {
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'serializes creation and project restoration at the last active slot',
    async () => {
      const project = await service.create(owner, createProject());
      await service.setProjectArchived(
        owner,
        project.id,
        true,
        await projectAction(project.id),
      );
      await service.create(owner, createProject());
      await service.create(owner, createProject());
      const input = await projectAction(project.id);
      await withConcurrentService(async (concurrent) => {
        const results = await Promise.allSettled([
          concurrent.create(owner, createProject()),
          concurrent.setProjectArchived(owner, project.id, false, input),
        ]);
        expect(
          results.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
        const rejected = results.find((result) => result.status === 'rejected');
        expect(
          rejected?.status === 'rejected' ? rejected.reason : null,
        ).toMatchObject({ response: { code: 'PROJECT_LIMIT_REACHED' } });
      });
      expect(
        (await service.list(owner)).items.filter(
          (project) => project.status === 'active',
        ),
      ).toHaveLength(3);
    },
  );
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'serializes transfer and creation against the new Owner quota without foreign-key deadlocks',
    async () => {
      const { project } = await joinedProject();
      await service.create(other, createProject());
      await service.create(other, createProject());
      const input = { ...(await projectAction(project.id)), memberId: other };
      await withConcurrentService(async (concurrent) => {
        const results = await Promise.allSettled([
          concurrent.transferOwnership(owner, project.id, input),
          concurrent.create(other, createProject()),
        ]);
        expect(
          results.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
        const rejected = results.find((result) => result.status === 'rejected');
        expect(
          rejected?.status === 'rejected' ? rejected.reason : null,
        ).toMatchObject({ response: { code: 'PROJECT_LIMIT_REACHED' } });
      });
      expect(
        (await service.list(other)).items.filter(
          (project) => project.status === 'active' && project.role === 'Owner',
        ),
      ).toHaveLength(3);
      expect(
        (await service.members(owner, project.id)).members.filter(
          (member) => member.role === 'Owner',
        ),
      ).toHaveLength(1);
    },
  );
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'allows only one concurrent task restoration into the 500th active slot',
    async () => {
      const { project } = await joinedProject();
      await fillTasks(project.id, 499);
      await fillTasks(project.id, 2, true);
      const archived = (await service.archivedTasks(owner, project.id)).items;
      await withConcurrentService(async (concurrent) => {
        const results = await Promise.allSettled(
          archived.map((task, index) =>
            concurrent.setTaskArchived(
              index ? other : owner,
              task.id,
              false,
              taskAction(task),
            ),
          ),
        );
        expect(
          results.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
        const rejected = results.find((result) => result.status === 'rejected');
        expect(
          rejected?.status === 'rejected' ? rejected.reason : null,
        ).toMatchObject({ response: { code: 'TASK_LIMIT_REACHED' } });
      });
      expect((await service.board(owner, project.id)).tasks).toHaveLength(500);
      expect(
        (await service.archivedTasks(other, project.id)).items,
      ).toHaveLength(1);
    },
  );
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'prevents duplicate ownership transfers while serializing content writes without deadlocks',
    async () => {
      const { project } = await joinedProject();
      const input = { ...(await projectAction(project.id)), memberId: other };
      await withConcurrentService(async (concurrent) => {
        const results = await Promise.allSettled([
          concurrent.transferOwnership(owner, project.id, input),
          concurrent.transferOwnership(owner, project.id, {
            ...input,
            requestId: randomUUID(),
          }),
          concurrent.createTask(other, project.id, {
            ...createTask(),
            assigneeId: owner,
          }),
        ]);
        expect(results[2]!.status).toBe('fulfilled');
        const transfers = results.slice(0, 2);
        // A task write may win the project lock, requiring an explicit transfer retry.
        const successes = transfers.filter(
          (result) => result.status === 'fulfilled',
        );
        expect(successes.length).toBeLessThanOrEqual(1);
        for (const result of transfers)
          if (result.status === 'rejected')
            expect([403, 409]).toContain(result.reason.status);
      });
      expect(
        (await service.members(owner, project.id)).members.filter(
          (member) => member.role === 'Owner',
        ),
      ).toHaveLength(1);
    },
  );
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'accepts one membership under simultaneous invitation requests',
    async () => {
      const project = await service.create(owner, createProject());
      const invitation = inviteInput();
      await service.createInvitation(owner, project.id, invitation);
      await withConcurrentService(async (concurrent) => {
        const results = await Promise.all([
          concurrent.acceptInvitation(localIdentities[1]!, {
            token: invitation.token,
            requestId: randomUUID(),
          }),
          concurrent.acceptInvitation(localIdentities[1]!, {
            token: invitation.token,
            requestId: randomUUID(),
          }),
        ]);
        expect(results.filter((result) => !result.alreadyJoined)).toHaveLength(
          1,
        );
      });
      expect((await service.members(owner, project.id)).members).toHaveLength(
        2,
      );
    },
  );
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'allows exactly one edit or move based on the same version',
    async () => {
      const { project } = await joinedProject();
      const { task } = await service.createTask(
        owner,
        project.id,
        createTask(),
      );
      await withConcurrentService(async (concurrent) => {
        const edited = await Promise.allSettled([
          concurrent.updateTask(owner, task.id, {
            ...editInput(task),
            title: 'Owner edit',
          }),
          concurrent.updateTask(other, task.id, {
            ...editInput(task),
            title: 'Editor edit',
          }),
        ]);
        expect(
          edited.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
        const rejected = edited.find((result) => result.status === 'rejected');
        expect(
          rejected?.status === 'rejected' ? rejected.reason : null,
        ).toMatchObject({ response: { code: 'VERSION_CONFLICT' } });
        const current = await service.task(owner, task.id);
        const board = await service.board(owner, project.id);
        const moved = await Promise.allSettled(
          ['in_progress', 'done'].map((status) =>
            concurrent.moveTask(owner, task.id, {
              expectedVersion: current.version,
              expectedBoardRevision: board.project.boardRevision,
              status: status as 'in_progress' | 'done',
              beforeTaskId: null,
              requestId: randomUUID(),
            }),
          ),
        );
        expect(
          moved.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
      });
      const board = await service.board(owner, project.id);
      expect(board.tasks).toHaveLength(1);
      expect(board.tasks[0]!.version).toBe(3);
    },
  );
});

describe('concurrent resource limits and dispatch leases', () => {
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'reserves exactly five attachment slots under concurrent initialization',
    async () => {
      const project = await service.create(owner, createProject());
      const { task } = await service.createTask(
        owner,
        project.id,
        createTask(),
      );
      await withConcurrentService(async (_p, _n, _d, concurrentFiles) => {
        const result = await Promise.allSettled(
          Array.from({ length: 6 }, () =>
            concurrentFiles.initialize(owner, task.id, fileInput()),
          ),
        );
        expect(
          result.filter((item) => item.status === 'fulfilled'),
        ).toHaveLength(5);
        expect(result.find((item) => item.status === 'rejected')).toMatchObject(
          { reason: { response: { code: 'ATTACHMENT_LIMIT_REACHED' } } },
        );
      });
    },
  );
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'enforces a shared rate counter under competing connections',
    async () => {
      await withConcurrentService(
        async (_p, _n, _d, _f, concurrentDatabase) => {
          const results = await Promise.allSettled(
            Array.from({ length: 20 }, () =>
              consumeRate(concurrentDatabase, owner, [
                { name: 'shared', limit: 10 },
              ]),
            ),
          );
          expect(
            results.filter((result) => result.status === 'fulfilled'),
          ).toHaveLength(10);
          expect(
            (
              await sql.query(
                "SELECT used FROM rate_limits WHERE bucket = 'shared'",
              )
            ).rows[0]!.used,
          ).toBe(10);
        },
      );
    },
  );
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'prevents two workers from publishing the same recipient lease concurrently',
    async () => {
      await joinedProject();
      await withConcurrentService(
        async (_p, _n, _d, _f, concurrentDatabase) => {
          const published: string[] = [];
          const transport = {
            async publish(userId: string, hint: EventHint) {
              await new Promise((resolve) => setTimeout(resolve, 10));
              published.push(`${userId}:${hint.eventId}`);
            },
          };
          await Promise.all([
            new DispatcherService(concurrentDatabase, transport).tick(),
            new DispatcherService(concurrentDatabase, transport).tick(),
          ]);
          expect(published.length).toBeGreaterThan(0);
          expect(new Set(published).size).toBe(published.length);
          expect(
            (
              await sql.query(
                "SELECT 1 FROM event_deliveries WHERE state = 'pending'",
              )
            ).rows,
          ).toEqual([]);
        },
      );
    },
  );
});
