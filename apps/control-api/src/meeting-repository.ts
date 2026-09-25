import {
  WorkspaceRoleSchema,
  type CreateMeetingInput,
  type WorkspaceRole,
} from "@atoms/contracts";
import type {
  Meeting as PrismaMeeting,
  OliviaAssistedAction as PrismaOliviaAssistedAction,
  PrismaClient,
} from "@atoms/db";

import type { MeetingRecord } from "./meeting-domain.js";

export interface MeetingAccessRecord {
  readonly meeting: MeetingRecord;
  readonly role: WorkspaceRole;
}

export type CreateMeetingResult =
  | { readonly kind: "ok"; readonly meeting: MeetingRecord }
  | { readonly kind: "project_not_found" };

export type CompleteMeetingBriefResult =
  | { readonly kind: "ok"; readonly meeting: MeetingRecord }
  | { readonly kind: "already_completed"; readonly meeting: MeetingRecord }
  | { readonly kind: "not_found" };

export interface MeetingControlRepository {
  getWorkspaceMembership(
    userId: string,
    workspaceId: string,
  ): Promise<{ readonly role: WorkspaceRole } | null>;
  createMeeting(
    workspaceId: string,
    input: CreateMeetingInput,
    prompt: string,
  ): Promise<CreateMeetingResult>;
  listMeetings(workspaceId: string): Promise<readonly MeetingRecord[]>;
  getMeetingAccess(userId: string, meetingId: string): Promise<MeetingAccessRecord | null>;
  completeMeetingBriefAction(
    meetingId: string,
    response: string,
    now: Date,
  ): Promise<CompleteMeetingBriefResult>;
}

type PrismaMeetingWithAction = PrismaMeeting & {
  readonly oliviaAction: PrismaOliviaAssistedAction | null;
};

export class PrismaMeetingControlRepository implements MeetingControlRepository {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async getWorkspaceMembership(
    userId: string,
    workspaceId: string,
  ): Promise<{ readonly role: WorkspaceRole } | null> {
    const membership = await this.#prisma.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    return membership === null
      ? null
      : { role: WorkspaceRoleSchema.parse(membership.role) };
  }

  async createMeeting(
    workspaceId: string,
    input: CreateMeetingInput,
    prompt: string,
  ): Promise<CreateMeetingResult> {
    if (input.projectId !== undefined) {
      const project = await this.#prisma.project.findFirst({
        where: {
          id: input.projectId,
          workspaceId,
          archivedAt: null,
        },
        select: { id: true },
      });
      if (project === null) return { kind: "project_not_found" };
    }

    try {
      const meeting = await this.#prisma.meeting.create({
        data: {
          workspaceId,
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          title: input.title,
          objective: input.objective,
          expectedOutcome: input.expectedOutcome,
          decisionQuestion: input.decisionQuestion,
          ...(input.relevantProjectContext === undefined
            ? {}
            : { relevantProjectContext: input.relevantProjectContext }),
          knownOpenItems: input.knownOpenItems,
          oliviaAction: {
            create: {
              kind: "PREPARE_MEETING_BRIEF",
              status: "PENDING",
              targetField: "meetingBrief",
              prompt,
            },
          },
        },
        include: { oliviaAction: true },
      });

      return { kind: "ok", meeting: toMeetingRecord(meeting) };
    } catch (error) {
      // A concurrent request can win the same (workspaceId, title) race; treat the
      // conflict as success and hand back whichever row actually landed, instead of
      // failing one of two legitimate simultaneous "prepare this meeting" callers.
      if (prismaErrorCode(error) === "P2002") {
        const existing = await this.#prisma.meeting.findUnique({
          where: { workspaceId_title: { workspaceId, title: input.title } },
          include: { oliviaAction: true },
        });
        if (existing !== null) return { kind: "ok", meeting: toMeetingRecord(existing) };
      }
      throw error;
    }
  }

  async listMeetings(workspaceId: string): Promise<readonly MeetingRecord[]> {
    const meetings = await this.#prisma.meeting.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      include: { oliviaAction: true },
    });
    return meetings.map(toMeetingRecord);
  }

  async getMeetingAccess(
    userId: string,
    meetingId: string,
  ): Promise<MeetingAccessRecord | null> {
    const meeting = await this.#prisma.meeting.findUnique({
      where: { id: meetingId },
      include: { oliviaAction: true },
    });
    if (meeting === null) return null;

    const membership = await this.getWorkspaceMembership(userId, meeting.workspaceId);
    if (membership === null) return null;
    return { meeting: toMeetingRecord(meeting), role: membership.role };
  }

  async completeMeetingBriefAction(
    meetingId: string,
    response: string,
    now: Date,
  ): Promise<CompleteMeetingBriefResult> {
    return this.#prisma.$transaction(async (tx) => {
      const current = await tx.meeting.findUnique({
        where: { id: meetingId },
        include: { oliviaAction: true },
      });
      if (current === null || current.oliviaAction === null) {
        return { kind: "not_found" } as const;
      }

      if (current.oliviaAction.status === "COMPLETED") {
        return {
          kind: "already_completed",
          meeting: toMeetingRecord(current),
        } as const;
      }

      // Compare-and-set on status: two concurrent completions raced past the read
      // above would otherwise both pass and the second silently overwrite the
      // first, despite the "already_completed" check just above intending to
      // prevent exactly that.
      const { count } = await tx.oliviaAssistedAction.updateMany({
        where: { meetingId, status: { not: "COMPLETED" } },
        data: {
          response,
          status: "COMPLETED",
          completedAt: now,
        },
      });
      if (count === 0) {
        const raced = await tx.meeting.findUniqueOrThrow({
          where: { id: meetingId },
          include: { oliviaAction: true },
        });
        return { kind: "already_completed", meeting: toMeetingRecord(raced) } as const;
      }
      const meeting = await tx.meeting.update({
        where: { id: meetingId },
        data: {
          meetingBrief: response,
          preparationState: "READY_FOR_AGENT_PREPARATION",
        },
        include: { oliviaAction: true },
      });
      return { kind: "ok", meeting: toMeetingRecord(meeting) } as const;
    });
  }
}

function prismaErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function toMeetingRecord(record: PrismaMeetingWithAction): MeetingRecord {
  if (record.oliviaAction === null) {
    throw new Error(`Meeting ${record.id} is missing its required Olivia action`);
  }
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    title: record.title,
    objective: record.objective,
    expectedOutcome: record.expectedOutcome,
    decisionQuestion: record.decisionQuestion,
    relevantProjectContext: record.relevantProjectContext,
    knownOpenItems: record.knownOpenItems,
    meetingBrief: record.meetingBrief,
    preparationState: record.preparationState,
    oliviaAction: {
      id: record.oliviaAction.id,
      meetingId: record.oliviaAction.meetingId,
      kind: record.oliviaAction.kind,
      status: record.oliviaAction.status,
      targetField: record.oliviaAction.targetField,
      prompt: record.oliviaAction.prompt,
      response: record.oliviaAction.response,
      completedAt: record.oliviaAction.completedAt,
      createdAt: record.oliviaAction.createdAt,
      updatedAt: record.oliviaAction.updatedAt,
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
