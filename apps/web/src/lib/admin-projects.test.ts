import assert from "node:assert/strict";
import test from "node:test";

import type { AdminProjectLatestRun } from "@atoms/contracts";

import {
  describeListCoverage,
  describeRunStatus,
  formatAdminTimestamp,
  formatRunDuration,
} from "./admin-projects.js";

const run = (patch: Partial<AdminProjectLatestRun> = {}): AdminProjectLatestRun => ({
  id: "00000000-0000-4000-8000-000000000901",
  status: "COMPLETED",
  createdAt: "2026-10-22T10:02:25.000Z",
  startedAt: "2026-10-22T10:02:26.000Z",
  completedAt: "2026-10-22T10:15:08.000Z",
  ...patch,
});

test("every run status has a readable label and a tone", () => {
  assert.deepEqual(describeRunStatus("COMPLETED"), { label: "Completed", tone: "done" });
  assert.deepEqual(describeRunStatus("RUNNING"), { label: "Running", tone: "active" });
  assert.deepEqual(describeRunStatus("PAUSED"), { label: "Awaiting approval", tone: "active" });
  assert.equal(describeRunStatus("FAILED").tone, "problem");
  assert.equal(describeRunStatus("CANCELLED").tone, "problem");
  assert.equal(describeRunStatus("PENDING").label, "Queued");
});

test("formats the duration of a finished run", () => {
  assert.equal(formatRunDuration(run()), "12m 42s");
  assert.equal(
    formatRunDuration(run({ completedAt: "2026-10-22T10:02:41.000Z" })),
    "15s",
  );
  assert.equal(
    formatRunDuration(run({ completedAt: "2026-10-22T10:05:26.000Z" })),
    "3m 00s",
  );
});

test("a run that has not both started and finished has no duration", () => {
  assert.equal(formatRunDuration(run({ startedAt: null })), undefined);
  assert.equal(formatRunDuration(run({ completedAt: null })), undefined);
  assert.equal(
    formatRunDuration(run({ completedAt: "2026-10-22T10:00:00.000Z" })),
    undefined,
  );
});

test("timestamps are shown in UTC regardless of the viewer's locale", () => {
  assert.equal(formatAdminTimestamp("2026-10-22T10:02:25.000Z"), "2026-10-22 10:02 UTC");
  assert.equal(formatAdminTimestamp("2026-10-22T23:59:59+02:00"), "2026-10-22 21:59 UTC");
  assert.equal(formatAdminTimestamp("not a date"), "not a date");
});

test("says when the list is truncated by the server limit", () => {
  assert.equal(describeListCoverage(0, 0), "No projects yet");
  assert.equal(describeListCoverage(1, 1), "1 project");
  assert.equal(describeListCoverage(7, 7), "7 projects");
  assert.equal(describeListCoverage(100, 250), "Showing the newest 100 of 250 projects");
});

test("the admin page only reads, and treats 403/404 as 'not allowed' rather than a failure", async () => {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const page = await readFile(
    resolve(process.cwd(), "src/components/admin-projects-page.tsx"),
    "utf8",
  );

  assert.match(page, /getWorkspaceAdminProjects\(/u);
  // A read-only page: no creation, run control, file write or archive call.
  assert.doesNotMatch(
    page,
    /\.(createProject|createRun|runAction|putProjectFile|archive\w*|delete\w*)\s*\(/u,
  );
  assert.match(page, /caught\.status === 403 \|\| caught\.status === 404/u);
  assert.match(page, /Only workspace owners and admins can see this page/u);
});

test("the workspace shell links to the admin page only inside the admin-only card", async () => {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const shell = await readFile(
    resolve(process.cwd(), "src/components/workspace-shell.tsx"),
    "utf8",
  );

  const card = shell.slice(shell.indexOf("function AdminOverviewCard"));
  assert.match(card, /status === "idle" \|\| status === "unavailable"\) return null/u);
  assert.ok(card.indexOf('href="/admin"') > card.indexOf('return null'));
  assert.equal(shell.split('href="/admin"').length - 1, 1);
});
