import assert from "node:assert/strict";
import test from "node:test";

import type {
  CreateMeetingInput,
  CreateProjectInput,
  FileContentInput,
  JsonValue,
  WorkspacePlan,
  WorkspaceRole,
} from "@atoms/contracts";

import { buildControlApi } from "./app.js";
import type { MeetingRecord } from "./meeting-domain.js";
import {
  registerMeetingRoutes,
} from "./meeting-routes.js";
import type {
  CompleteMeetingBriefResult,
  CreateMeetingResult,
  MeetingAccessRecord,
  MeetingControlRepository,
} from "./meeting-repository.js";
import type {
  ControlRepository,
  CreateRunWithIdempotencyResult,
  PutProjectFileResult,
  WorkspaceMembershipRecord,
} from "./repository.js";
import type { RunQueue } from "./run-queue.js";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000701";
const OTHER_WORKSPACE_ID = "00000000-0000-4000-8000-000000000702";
const MEETING_ID = "00000000-0000-4000-8000-000000000703";
const ACTION_ID = "00000000-0000-4000-8000-000000000704";
const FIXED_NOW = new Date("2026-09-22T10:30:00.000Z");

const validBrief = [
  "Meeting Brief",
  "1. Current State\nStaging is intentionally parked while the remaining readiness evidence is completed.",
  "2. Decision Required\nDecide whether activation can proceed or which prerequisites remain blocking.",
  "3. Relevant Facts\nAcceptance evidence and credential approval are known open items supplied to the meeting.",
  "4. Known Constraints\nNo production-readiness evidence may be invented and the current parked state must be preserved.",
  "5. Open Questions / Gates\nAcceptance evidence and credential approval remain explicit gates.",
  "6. Meeting Goal\nLeave with an explicit decision and a concrete prerequisite plan.",
  "7. Exit Criteria\nEvery blocking prerequisite has an owner, evidence requirement, dependency, and next action.",
].join("\n\n");

class NoopControlRepository implements ControlRepository {
  async listWorkspaceMemberships(): Promise<readonly WorkspaceMembershipRecord[]> {
    return [];
  }
  async getWorkspaceMembership(): Promise<null> {
    return null;
  }
  async updateWorkspacePlan(_workspaceId: string, _plan: WorkspacePlan): Promise<never> {
    throw new Error("not used");
  }
  async createProject(_input: CreateProjectInput): Promise<never> {
    throw new Error("not used");
  }
  async getProject(): Promise<null> {
    return null;
  }
  async createRun(): Promise<null> {
    return null;
  }
  async createRunWithIdempotency(): Promise<CreateRunWithIdempotencyResult> {
    return { kind: "project_not_found" };
  }
  async getRun(): Promise<null> {
    return null;
  }
  async transitionRun(): Promise<null> {
    return null;
  }
  async markRunFailed(
    _runId: string,
    _expectedControlVersion: number,
    _error: JsonValue,
  ): Promise<void> {}
  async listRunEventsAfter(): Promise<[]> {
    return [];
  }
  async listRunArtifacts(): Promise<[]> {
    return [];
  }
  async listProjectFiles(): Promise<null> {
    return null;
  }
  async getProjectFile(): Promise<null> {
    return null;
  }
  async putProjectFile(
    _userId: string,
    _projectId: string,
    _input: FileContentInput,
  ): Promise<PutProjectFileResult> {
    return { kind: "project_not_found" };
  }
  async close(): Promise<void> {}
}

class NoopRunQueue implements RunQueue {
  async enqueue(): Promise<void> {}
  async close(): Promise<void> {}
}

class MemoryMeetingRepository implements MeetingControlRepository {
  role: WorkspaceRole = "OWNER";
  meeting: MeetingRecord | undefined;

  async getWorkspaceMembership(
    _userId: string,
    workspaceId: string,
  ): Promise<{ readonly role: WorkspaceRole } | null> {
    return workspaceId === WORKSPACE_ID ? { role: this.role } : null;
  }

  async createMeeting(
    workspaceId: string,
    input: CreateMeetingInput,
    prompt: string,
  ): Promise<CreateMeetingResult> {
    const meeting: MeetingRecord = {
      id: MEETING_ID,
      workspaceId,
      projectId: input.projectId ?? null,
      title: input.title,
      objective: input.objective,
      expectedOutcome: input.expectedOutcome,
      decisionQuestion: input.decisionQuestion,
      relevantProjectContext: input.relevantProjectContext ?? null,
      knownOpenItems: [...input.knownOpenItems],
      meetingBrief: null,
      preparationState: "OLIVIA_ACTION_REQUIRED",
      oliviaAction: {
        id: ACTION_ID,
        meetingId: MEETING_ID,
        kind: "PREPARE_MEETING_BRIEF",
        status: "PENDING",
        targetField: "meetingBrief",
        prompt,
        response: null,
        completedAt: null,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    };
    this.meeting = meeting;
    return { kind: "ok", meeting };
  }

  async listMeetings(workspaceId: string): Promise<readonly MeetingRecord[]> {
    return this.meeting?.workspaceId === workspaceId ? [this.meeting] : [];
  }

  async getMeetingAccess(
    _userId: string,
    meetingId: string,
  ): Promise<MeetingAccessRecord | null> {
    if (this.meeting === undefined || this.meeting.id !== meetingId) return null;
    return { meeting: this.meeting, role: this.role };
  }

  async completeMeetingBriefAction(
    meetingId: string,
    response: string,
    now: Date,
  ): Promise<CompleteMeetingBriefResult> {
    if (this.meeting === undefined || this.meeting.id !== meetingId) {
      return { kind: "not_found" };
    }
    if (this.meeting.oliviaAction.status === "COMPLETED") {
      return { kind: "already_completed", meeting: this.meeting };
    }
    this.meeting = {
      ...this.meeting,
      meetingBrief: response,
      preparationState: "READY_FOR_AGENT_PREPARATION",
      oliviaAction: {
        ...this.meeting.oliviaAction,
        response,
        status: "COMPLETED",
        completedAt: now,
        updatedAt: now,
      },
      updatedAt: now,
    };
    return { kind: "ok", meeting: this.meeting };
  }
}

async function createApp(repository: MemoryMeetingRepository) {
  const app = await buildControlApi({
    repository: new NoopControlRepository(),
    runQueue: new NoopRunQueue(),
    authRequired: false,
    logger: false,
    closeDependencies: false,
    now: () => FIXED_NOW,
  });
  registerMeetingRoutes(app, { repository, now: () => FIXED_NOW });
  return app;
}

test("creates a durable meeting with a server-owned Olivia prompt", async (t) => {
  const repository = new MemoryMeetingRepository();
  const app = await createApp(repository);
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${WORKSPACE_ID}/meetings`,
    payload: {
      title: "Genesisco production execution readiness",
      objective: "Determine the safe path to production-ready live execution.",
      expectedOutcome: "A concrete prioritized prerequisite plan.",
      decisionQuestion: "Can live execution be enabled now?",
      relevantProjectContext: "Staging is intentionally parked.",
      knownOpenItems: ["Close acceptance evidence"],
    },
  });

  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.preparationState, "OLIVIA_ACTION_REQUIRED");
  assert.equal(body.oliviaAction.status, "PENDING");
  assert.match(body.oliviaAction.prompt, /Can live execution be enabled now\?/);
  assert.equal(repository.meeting?.meetingBrief, null);
});

test("rejects an invalid Meeting Brief without advancing the durable gate", async (t) => {
  const repository = new MemoryMeetingRepository();
  const app = await createApp(repository);
  t.after(() => app.close());

  await app.inject({
    method: "POST",
    url: `/v1/workspaces/${WORKSPACE_ID}/meetings`,
    payload: {
      title: "Readiness meeting",
      objective: "Decide the next safe step.",
      expectedOutcome: "A prerequisite plan.",
      decisionQuestion: "Can execution proceed?",
      knownOpenItems: [],
    },
  });

  const response = await app.inject({
    method: "POST",
    url: `/v1/meetings/${MEETING_ID}/olivia-actions/meeting-brief/complete`,
    payload: { response: "Current State: incomplete" },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "MEETING_BRIEF_INVALID");
  assert.equal(repository.meeting?.preparationState, "OLIVIA_ACTION_REQUIRED");
  assert.equal(repository.meeting?.oliviaAction.status, "PENDING");
});

test("completes the Meeting Brief atomically and treats an identical retry as idempotent", async (t) => {
  const repository = new MemoryMeetingRepository();
  const app = await createApp(repository);
  t.after(() => app.close());

  await app.inject({
    method: "POST",
    url: `/v1/workspaces/${WORKSPACE_ID}/meetings`,
    payload: {
      title: "Readiness meeting",
      objective: "Decide the next safe step.",
      expectedOutcome: "A prerequisite plan.",
      decisionQuestion: "Can execution proceed?",
      knownOpenItems: [],
    },
  });

  const first = await app.inject({
    method: "POST",
    url: `/v1/meetings/${MEETING_ID}/olivia-actions/meeting-brief/complete`,
    payload: { response: validBrief },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().preparationState, "READY_FOR_AGENT_PREPARATION");
  assert.equal(first.json().oliviaAction.status, "COMPLETED");
  assert.equal(first.json().meetingBrief, validBrief);

  const retry = await app.inject({
    method: "POST",
    url: `/v1/meetings/${MEETING_ID}/olivia-actions/meeting-brief/complete`,
    payload: { response: validBrief },
  });
  assert.equal(retry.statusCode, 200);

  const changed = await app.inject({
    method: "POST",
    url: `/v1/meetings/${MEETING_ID}/olivia-actions/meeting-brief/complete`,
    payload: { response: `${validBrief}\nAdditional changed content.` },
  });
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.json().error.code, "MEETING_BRIEF_ALREADY_COMPLETED");
});

test("denies workspace-scoped creation outside membership", async (t) => {
  const repository = new MemoryMeetingRepository();
  const app = await createApp(repository);
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${OTHER_WORKSPACE_ID}/meetings`,
    payload: {
      title: "Unauthorized meeting",
      objective: "Should not persist.",
      expectedOutcome: "No meeting.",
      decisionQuestion: "Should this be allowed?",
      knownOpenItems: [],
    },
  });

  assert.equal(response.statusCode, 403);
  assert.equal(repository.meeting, undefined);
});
