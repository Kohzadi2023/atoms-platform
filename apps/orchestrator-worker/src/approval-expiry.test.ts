import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  ApprovalExpirySweeper,
  type StalePausedRunRepository,
} from "./approval-expiry.js";

const NOW = new Date("2026-09-19T12:00:00.000Z");
const HOUR = 3_600_000;

class FakeRepository implements StalePausedRunRepository {
  readonly calls: Array<{ pausedBefore: Date; now: Date; limit: number }> = [];
  constructor(private readonly batches: ReadonlyArray<readonly string[] | Error>) {}

  async expirePausedRuns(input: {
    readonly pausedBefore: Date;
    readonly now: Date;
    readonly limit: number;
  }): Promise<readonly string[]> {
    const next = this.batches[this.calls.length] ?? [];
    this.calls.push(input);
    if (next instanceof Error) throw next;
    return next;
  }
}

test("a sweep expires runs paused before now minus the TTL", async () => {
  const repository = new FakeRepository([["run-1", "run-2"]]);
  const sweeper = new ApprovalExpirySweeper({
    repository,
    ttlMs: 72 * HOUR,
    now: () => NOW,
  });

  const count = await sweeper.sweepOnce();

  assert.equal(count, 2);
  assert.equal(repository.calls[0]?.pausedBefore.toISOString(), "2026-09-16T12:00:00.000Z");
  assert.equal(repository.calls[0]?.now.toISOString(), NOW.toISOString());
});

test("a backlog is worked off in batches and stops at the first short batch", async () => {
  const repository = new FakeRepository([["a", "b"], ["c", "d"], ["e"]]);
  const expiredIds: string[] = [];
  const sweeper = new ApprovalExpirySweeper({
    repository,
    ttlMs: HOUR,
    batchSize: 2,
    now: () => NOW,
    onExpired: (ids) => expiredIds.push(...ids),
  });

  assert.equal(await sweeper.sweepOnce(), 5);
  assert.equal(repository.calls.length, 3);
  assert.deepEqual(expiredIds, ["a", "b", "c", "d", "e"]);
});

test("a sweep never loops forever on a repository that always returns full batches", async () => {
  const repository = new FakeRepository(Array.from({ length: 50 }, () => ["x", "y"]));
  const sweeper = new ApprovalExpirySweeper({
    repository,
    ttlMs: HOUR,
    batchSize: 2,
    now: () => NOW,
  });

  await sweeper.sweepOnce();

  assert.equal(repository.calls.length, 10, "bounded per sweep; the rest waits for the next one");
});

test("nothing to expire is a quiet zero", async () => {
  const expired: unknown[] = [];
  const sweeper = new ApprovalExpirySweeper({
    repository: new FakeRepository([[]]),
    ttlMs: HOUR,
    now: () => NOW,
    onExpired: (ids) => expired.push(ids),
  });

  assert.equal(await sweeper.sweepOnce(), 0);
  assert.deepEqual(expired, []);
});

test("a repository failure is reported and does not throw", async () => {
  const errors: unknown[] = [];
  const sweeper = new ApprovalExpirySweeper({
    repository: new FakeRepository([new Error("database down")]),
    ttlMs: HOUR,
    now: () => NOW,
    onError: (error) => errors.push(error),
  });

  assert.equal(await sweeper.sweepOnce(), 0);
  assert.equal(errors.length, 1);
});

test("a non-positive or fractional TTL is refused, so a typo cannot expire everything at once", () => {
  for (const ttlMs of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => new ApprovalExpirySweeper({ repository: new FakeRepository([]), ttlMs }),
      RangeError,
      String(ttlMs),
    );
  }
});

test("start sweeps immediately and stop ends the schedule", async () => {
  const repository = new FakeRepository([]);
  const sweeper = new ApprovalExpirySweeper({
    repository,
    ttlMs: HOUR,
    intervalMs: 5,
    now: () => NOW,
  });

  sweeper.start();
  sweeper.start();
  await new Promise((done) => setTimeout(done, 40));
  sweeper.stop();
  const atStop = repository.calls.length;
  await new Promise((done) => setTimeout(done, 30));

  assert.ok(atStop >= 2);
  assert.equal(repository.calls.length, atStop);
});

test("the worker enables expiry only when a TTL is configured and stops it on shutdown", async () => {
  const source = await readFile(resolve(process.cwd(), "src/main.ts"), "utf8");

  assert.match(source, /PAUSED_RUN_TTL_HOURS: z\.coerce[\s\S]*?\.default\(0\)/u);
  assert.match(source, /if \(environment\.PAUSED_RUN_TTL_HOURS > 0\)/u);
  assert.match(source, /new PrismaStalePausedRunRepository\(prisma\)/u);
  assert.match(source, /approvalExpirySweeper\?\.stop\(\)/u);
});
