import type { AdminProjectLatestRun, AgentRunStatus } from "@atoms/contracts";

export type RunTone = "active" | "done" | "problem" | "idle";

const RUN_STATUS: Record<AgentRunStatus, { label: string; tone: RunTone }> = {
  PENDING: { label: "Queued", tone: "active" },
  RUNNING: { label: "Running", tone: "active" },
  PAUSED: { label: "Awaiting approval", tone: "active" },
  COMPLETED: { label: "Completed", tone: "done" },
  FAILED: { label: "Failed", tone: "problem" },
  CANCELLED: { label: "Cancelled", tone: "problem" },
};

export function describeRunStatus(status: AgentRunStatus): { label: string; tone: RunTone } {
  return RUN_STATUS[status];
}

/** "12m 42s" style duration; undefined when the run has not both started and finished. */
export function formatRunDuration(run: AdminProjectLatestRun): string | undefined {
  if (run.startedAt === null || run.completedAt === null) return undefined;
  const seconds = Math.round(
    (Date.parse(run.completedAt) - Date.parse(run.startedAt)) / 1000,
  );
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${String(rest)}s`;
  return `${String(minutes)}m ${String(rest).padStart(2, "0")}s`;
}

/** Fixed, locale-independent UTC timestamp so the table reads the same everywhere. */
export function formatAdminTimestamp(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  return new Date(time).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** Shown above the table when the list is cut short by the server's limit. */
export function describeListCoverage(shown: number, total: number): string {
  if (total === 0) return "No projects yet";
  if (shown >= total) return `${String(total)} project${total === 1 ? "" : "s"}`;
  return `Showing the newest ${String(shown)} of ${String(total)} projects`;
}
