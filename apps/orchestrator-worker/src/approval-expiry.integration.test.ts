import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPrismaClient } from "@atoms/db";

import {
  APPROVAL_EXPIRED_CODE,
  PURGE_REDACTION_MARKER,
  PrismaExpiredRunDataRepository,
  PrismaPendingReminderRunRepository,
  PrismaStalePausedRunRepository,
} from "./approval-expiry.js";

const ENABLED = process.env.RUN_APPROVAL_EXPIRY_INTEGRATION_TESTS === "true";
const CONFIRMATION = "DEDICATED_EPHEMERAL_DATABASE";
const HOUR = 3_600_000;

test(
  "PostgreSQL approval expiry cancels only stale PAUSED runs and is safe under concurrent sweeps",
  { skip: !ENABLED },
  async () => {
    assert.equal(
      process.env.APPROVAL_EXPIRY_INTEGRATION_CONFIRMATION,
      CONFIRMATION,
      `APPROVAL_EXPIRY_INTEGRATION_CONFIRMATION must equal ${CONFIRMATION}`,
    );
    const databaseUrl = process.env.DATABASE_URL;
    assert.ok(databaseUrl, "DATABASE_URL is required");

    const suffix = randomUUID().slice(0, 12);
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const now = new Date();
    const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);
    const ids = {
      stalePaused: randomUUID(),
      recentPaused: randomUUID(),
      staleButRunning: randomUUID(),
      pausedWithoutTimestamp: randomUUID(),
      oldCompleted: randomUUID(),
      raceTarget: randomUUID(),
    };

    const client = createPrismaClient(databaseUrl);
    try {
      await client.workspace.create({
        data: {
          id: workspaceId,
          name: `Approval expiry ${suffix}`,
          slug: `approval-expiry-${suffix}`,
        },
      });
      await client.project.create({
        data: {
          id: projectId,
          workspaceId,
          name: `Approval expiry project ${suffix}`,
          slug: `approval-expiry-project-${suffix}`,
        },
      });
      const create = (id: string, status: "PAUSED" | "RUNNING" | "COMPLETED", pausedAt: Date | null) =>
        client.agentRun.create({
          data: { id, workspaceId, projectId, prompt: "expiry probe", status, pausedAt, controlVersion: 3 },
        });
      await create(ids.stalePaused, "PAUSED", ago(120));
      await create(ids.recentPaused, "PAUSED", ago(1));
      await create(ids.staleButRunning, "RUNNING", ago(120));
      await create(ids.pausedWithoutTimestamp, "PAUSED", null);
      await create(ids.oldCompleted, "COMPLETED", ago(200));

      const repository = new PrismaStalePausedRunRepository(client);
      const expired = await repository.expirePausedRuns({
        pausedBefore: ago(72),
        now,
        limit: 100,
      });

      // The database may hold other tests' rows, so assert on the runs created here.
      const created: readonly string[] = Object.values(ids);
      const mine = expired.filter((id) => created.includes(id));
      assert.deepEqual(mine, [ids.stalePaused]);

      const stale = await client.agentRun.findUniqueOrThrow({ where: { id: ids.stalePaused } });
      assert.equal(stale.status, "CANCELLED");
      assert.equal(stale.cancelledAt?.toISOString(), now.toISOString());
      assert.equal(stale.controlVersion, 4, "the control version moves, so stale actions are rejected");
      assert.equal((stale.error as { code?: string } | null)?.code, APPROVAL_EXPIRED_CODE);

      for (const [id, status] of [
        [ids.recentPaused, "PAUSED"],
        [ids.staleButRunning, "RUNNING"],
        [ids.pausedWithoutTimestamp, "PAUSED"],
        [ids.oldCompleted, "COMPLETED"],
      ] as const) {
        const run = await client.agentRun.findUniqueOrThrow({ where: { id } });
        assert.equal(run.status, status, id);
        assert.equal(run.controlVersion, 3, id);
        assert.equal(run.error, null, id);
      }

      const again = await repository.expirePausedRuns({ pausedBefore: ago(72), now, limit: 100 });
      assert.equal(again.includes(ids.stalePaused), false, "a second sweep does not expire it again");

      // Two replicas sweeping at once: the run is cancelled exactly once.
      await create(ids.raceTarget, "PAUSED", ago(500));
      const racers = await Promise.all([
        repository.expirePausedRuns({ pausedBefore: ago(72), now, limit: 100 }),
        repository.expirePausedRuns({ pausedBefore: ago(72), now, limit: 100 }),
        new PrismaStalePausedRunRepository(client).expirePausedRuns({ pausedBefore: ago(72), now, limit: 100 }),
      ]);
      assert.equal(racers.flat().filter((id) => id === ids.raceTarget).length, 1);
      const raced = await client.agentRun.findUniqueOrThrow({ where: { id: ids.raceTarget } });
      assert.equal(raced.controlVersion, 4, "incremented once, not once per replica");
    } finally {
      await client.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
      await client.$disconnect();
    }
  },
);

test(
  "PostgreSQL approval reminder records once per run and only for runs still PAUSED",
  { skip: !ENABLED },
  async () => {
    assert.equal(
      process.env.APPROVAL_EXPIRY_INTEGRATION_CONFIRMATION,
      CONFIRMATION,
      `APPROVAL_EXPIRY_INTEGRATION_CONFIRMATION must equal ${CONFIRMATION}`,
    );
    const databaseUrl = process.env.DATABASE_URL;
    assert.ok(databaseUrl, "DATABASE_URL is required");

    const suffix = randomUUID().slice(0, 12);
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const now = new Date();
    const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);
    const ids = { dueForReminder: randomUUID(), alreadyReminded: randomUUID(), tooRecent: randomUUID() };

    const client = createPrismaClient(databaseUrl);
    try {
      await client.workspace.create({
        data: { id: workspaceId, name: `Reminder ${suffix}`, slug: `reminder-${suffix}` },
      });
      await client.project.create({
        data: { id: projectId, workspaceId, name: `Reminder project ${suffix}`, slug: `reminder-project-${suffix}` },
      });
      const create = (id: string, pausedAt: Date, reminderSentAt: Date | null) =>
        client.agentRun.create({
          data: { id, workspaceId, projectId, prompt: "reminder probe", status: "PAUSED", pausedAt, reminderSentAt, eventSequence: 0 },
        });
      await create(ids.dueForReminder, ago(48), null);
      await create(ids.alreadyReminded, ago(48), ago(1));
      await create(ids.tooRecent, ago(1), null);

      const repository = new PrismaPendingReminderRunRepository(client);
      const reminded = await repository.sendReminders({ pausedBefore: ago(24), now, limit: 100 });

      const created: readonly string[] = Object.values(ids);
      assert.deepEqual(reminded.filter((id) => created.includes(id)), [ids.dueForReminder]);

      const due = await client.agentRun.findUniqueOrThrow({ where: { id: ids.dueForReminder } });
      assert.equal(due.reminderSentAt?.toISOString(), now.toISOString());
      const event = await client.runEvent.findFirst({ where: { runId: ids.dueForReminder }, orderBy: { sequence: "desc" } });
      assert.equal(event?.eventType, "run.approval_reminder_due");

      const again = await repository.sendReminders({ pausedBefore: ago(24), now, limit: 100 });
      assert.equal(again.includes(ids.dueForReminder), false, "a second sweep does not remind twice");
    } finally {
      await client.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
      await client.$disconnect();
    }
  },
);

test(
  "PostgreSQL data purge redacts only expired runs, drops attachment links, and is idempotent",
  { skip: !ENABLED },
  async () => {
    assert.equal(
      process.env.APPROVAL_EXPIRY_INTEGRATION_CONFIRMATION,
      CONFIRMATION,
      `APPROVAL_EXPIRY_INTEGRATION_CONFIRMATION must equal ${CONFIRMATION}`,
    );
    const databaseUrl = process.env.DATABASE_URL;
    assert.ok(databaseUrl, "DATABASE_URL is required");

    const suffix = randomUUID().slice(0, 12);
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const now = new Date();
    const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);
    const ids = {
      expiredAndDue: randomUUID(),
      expiredNotYetDue: randomUUID(),
      userCancelled: randomUUID(),
      stillPaused: randomUUID(),
    };

    const client = createPrismaClient(databaseUrl);
    try {
      await client.workspace.create({
        data: { id: workspaceId, name: `Purge ${suffix}`, slug: `purge-${suffix}` },
      });
      await client.project.create({
        data: { id: projectId, workspaceId, name: `Purge project ${suffix}`, slug: `purge-project-${suffix}` },
      });
      const expiredError = { code: APPROVAL_EXPIRED_CODE, name: "ApprovalExpired", message: "expired", retryable: false };
      await client.agentRun.create({
        data: {
          id: ids.expiredAndDue, workspaceId, projectId, prompt: "purge probe",
          status: "CANCELLED", cancelledAt: ago(24 * 40), error: expiredError, eventSequence: 0,
        },
      });
      await client.agentTask.create({
        data: { runId: ids.expiredAndDue, agentName: "Emma", description: "probe", ordinal: 1, input: { a: 1 }, output: { b: 2 } },
      });
      await client.agentRun.create({
        data: { id: ids.expiredNotYetDue, workspaceId, projectId, prompt: "not yet", status: "CANCELLED", cancelledAt: ago(1), error: expiredError, eventSequence: 0 },
      });
      await client.agentRun.create({
        data: { id: ids.userCancelled, workspaceId, projectId, prompt: "user cancelled", status: "CANCELLED", cancelledAt: ago(24 * 40), eventSequence: 0 },
      });
      await client.agentRun.create({
        data: { id: ids.stillPaused, workspaceId, projectId, prompt: "still paused", status: "PAUSED", pausedAt: ago(24 * 40), eventSequence: 0 },
      });

      const repository = new PrismaExpiredRunDataRepository(client);
      const purged = await repository.purgeExpiredRunData({ cancelledBefore: ago(24 * 30), now, limit: 100 });

      const created: readonly string[] = Object.values(ids);
      assert.deepEqual(purged.filter((id) => created.includes(id)), [ids.expiredAndDue]);

      const redacted = await client.agentRun.findUniqueOrThrow({ where: { id: ids.expiredAndDue } });
      assert.equal(redacted.prompt, PURGE_REDACTION_MARKER);
      assert.equal(redacted.checkpoint, null);
      assert.equal(redacted.purgedAt?.toISOString(), now.toISOString());
      const task = await client.agentTask.findFirstOrThrow({ where: { runId: ids.expiredAndDue } });
      assert.equal(task.input, null);
      assert.equal(task.output, null);
      const event = await client.runEvent.findFirst({ where: { runId: ids.expiredAndDue }, orderBy: { sequence: "desc" } });
      assert.equal(event?.eventType, "run.data_purged");

      for (const [id, expectedPrompt] of [
        [ids.expiredNotYetDue, "not yet"],
        [ids.userCancelled, "user cancelled"],
        [ids.stillPaused, "still paused"],
      ] as const) {
        const run = await client.agentRun.findUniqueOrThrow({ where: { id } });
        assert.equal(run.prompt, expectedPrompt, id);
        assert.equal(run.purgedAt, null, id);
      }

      const again = await repository.purgeExpiredRunData({ cancelledBefore: ago(24 * 30), now, limit: 100 });
      assert.equal(again.includes(ids.expiredAndDue), false, "a second sweep does not purge twice");
    } finally {
      await client.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
      await client.$disconnect();
    }
  },
);
