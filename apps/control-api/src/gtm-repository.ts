import type {
  CreateDealInput,
  CreateGtmScopeInput,
  CreateProspectInput,
  DealStage,
  WorkspaceRole,
} from "@atoms/contracts";
import type { PrismaClient } from "@atoms/db";

import type { DealRecord, GtmScopeRecord, ProspectRecord } from "./gtm-domain.js";
import { RepositoryConflictError } from "./errors.js";

const CLOSED_STAGES: ReadonlySet<DealStage> = new Set([
  "CLOSED_WON",
  "CLOSED_LOST",
]);

export type CreateGtmScopeResult =
  | { readonly kind: "ok"; readonly scope: GtmScopeRecord }
  | { readonly kind: "project_not_found" };

export interface GtmScopeAccessRecord {
  readonly scope: GtmScopeRecord;
  readonly role: WorkspaceRole;
}

export type CreateDealResult =
  | { readonly kind: "ok"; readonly deal: DealRecord }
  | { readonly kind: "prospect_not_found" };

export type UpdateDealStageResult =
  | { readonly kind: "ok"; readonly deal: DealRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "terminal_stage"; readonly deal: DealRecord };

export interface GtmControlRepository {
  getWorkspaceMembership(
    userId: string,
    workspaceId: string,
  ): Promise<{ readonly role: WorkspaceRole } | null>;
  createGtmScope(
    workspaceId: string,
    input: CreateGtmScopeInput,
  ): Promise<CreateGtmScopeResult>;
  listGtmScopes(workspaceId: string): Promise<readonly GtmScopeRecord[]>;
  getGtmScopeAccess(
    userId: string,
    gtmScopeId: string,
  ): Promise<GtmScopeAccessRecord | null>;
  createProspect(
    gtmScopeId: string,
    input: CreateProspectInput,
  ): Promise<ProspectRecord>;
  listProspects(gtmScopeId: string): Promise<readonly ProspectRecord[]>;
  getProspect(
    gtmScopeId: string,
    prospectId: string,
  ): Promise<ProspectRecord | null>;
  createDeal(
    gtmScopeId: string,
    input: CreateDealInput,
    now: Date,
  ): Promise<CreateDealResult>;
  listDeals(gtmScopeId: string): Promise<readonly DealRecord[]>;
  getDeal(gtmScopeId: string, dealId: string): Promise<DealRecord | null>;
  updateDealStage(
    gtmScopeId: string,
    dealId: string,
    stage: DealStage,
    now: Date,
  ): Promise<UpdateDealStageResult>;
}

export class PrismaGtmControlRepository implements GtmControlRepository {
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
    return membership === null ? null : { role: membership.role };
  }

  async createGtmScope(
    workspaceId: string,
    input: CreateGtmScopeInput,
  ): Promise<CreateGtmScopeResult> {
    if (input.mode === "PROJECT_GTM") {
      // Contract-level superRefine already guarantees projectId is set
      // whenever mode is PROJECT_GTM.
      const projectId = input.projectId as string;
      const project = await this.#prisma.project.findFirst({
        where: { id: projectId, workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (project === null) {
        return { kind: "project_not_found" };
      }
    }
    try {
      const scope = await this.#prisma.gtmScope.create({
        data: {
          workspaceId,
          projectId: input.mode === "PROJECT_GTM" ? (input.projectId as string) : null,
          mode: input.mode,
        },
      });
      return { kind: "ok", scope };
    } catch (error) {
      if (prismaErrorCode(error) === "P2002") {
        throw new RepositoryConflictError(
          input.mode === "PLATFORM_GTM"
            ? "This workspace already has a PLATFORM_GTM scope"
            : "This project already has a GtmScope",
          "gtm_scopes_mode_uniqueness",
        );
      }
      throw error;
    }
  }

  async listGtmScopes(workspaceId: string): Promise<readonly GtmScopeRecord[]> {
    return this.#prisma.gtmScope.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
    });
  }

  async getGtmScopeAccess(
    userId: string,
    gtmScopeId: string,
  ): Promise<GtmScopeAccessRecord | null> {
    const scope = await this.#prisma.gtmScope.findFirst({
      where: { id: gtmScopeId },
      include: { workspace: { include: { memberships: { where: { userId } } } } },
    });
    if (scope === null) return null;
    const membership = scope.workspace.memberships[0];
    if (membership === undefined) return null;
    return {
      scope: {
        id: scope.id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        mode: scope.mode,
        createdAt: scope.createdAt,
        updatedAt: scope.updatedAt,
      },
      role: membership.role,
    };
  }

  async createProspect(
    gtmScopeId: string,
    input: CreateProspectInput,
  ): Promise<ProspectRecord> {
    try {
      return await this.#prisma.prospect.create({
        data: {
          gtmScopeId,
          companyName: input.companyName,
          companyDomain: input.companyDomain ?? null,
          contactName: input.contactName,
          contactEmail: input.contactEmail,
          normalizedEmail: normalizeEmail(input.contactEmail),
          contactTitle: input.contactTitle ?? null,
          industry: input.industry ?? null,
          companySizeHeadcount: input.companySizeHeadcount ?? null,
          useCase: input.useCase,
          fitEvidenceStatus: input.fitEvidenceStatus,
          fitEvidenceNotes: input.fitEvidenceNotes ?? null,
          source: input.source,
          sourceExternalId: input.sourceExternalId ?? null,
        },
      });
    } catch (error) {
      if (prismaErrorCode(error) === "P2002") {
        throw new RepositoryConflictError(
          "A prospect with this email already exists in this GTM scope",
          "prospects_gtm_scope_id_normalized_email_key",
        );
      }
      throw error;
    }
  }

  async listProspects(gtmScopeId: string): Promise<readonly ProspectRecord[]> {
    return this.#prisma.prospect.findMany({
      where: { gtmScopeId },
      orderBy: { createdAt: "asc" },
    });
  }

  async getProspect(
    gtmScopeId: string,
    prospectId: string,
  ): Promise<ProspectRecord | null> {
    return this.#prisma.prospect.findFirst({
      where: { id: prospectId, gtmScopeId },
    });
  }

  async createDeal(
    gtmScopeId: string,
    input: CreateDealInput,
    now: Date,
  ): Promise<CreateDealResult> {
    const prospect = await this.#prisma.prospect.findFirst({
      where: { id: input.prospectId, gtmScopeId },
      select: { id: true },
    });
    if (prospect === null) {
      return { kind: "prospect_not_found" };
    }
    const stage = input.stage ?? "PROSPECTING";
    const deal = await this.#prisma.deal.create({
      data: {
        gtmScopeId,
        prospectId: input.prospectId,
        name: input.name,
        stage,
        amountUsdMicros:
          input.amountUsdMicros === undefined ? null : BigInt(input.amountUsdMicros),
        closeDateExpected:
          input.closeDateExpected === undefined
            ? null
            : new Date(input.closeDateExpected),
        closedAt: CLOSED_STAGES.has(stage) ? now : null,
      },
    });
    return { kind: "ok", deal };
  }

  async listDeals(gtmScopeId: string): Promise<readonly DealRecord[]> {
    return this.#prisma.deal.findMany({
      where: { gtmScopeId },
      orderBy: { createdAt: "asc" },
    });
  }

  async getDeal(gtmScopeId: string, dealId: string): Promise<DealRecord | null> {
    return this.#prisma.deal.findFirst({ where: { id: dealId, gtmScopeId } });
  }

  async updateDealStage(
    gtmScopeId: string,
    dealId: string,
    stage: DealStage,
    now: Date,
  ): Promise<UpdateDealStageResult> {
    return this.#prisma.$transaction(async (tx) => {
      const existing = await tx.deal.findFirst({ where: { id: dealId, gtmScopeId } });
      if (existing === null) {
        return { kind: "not_found" as const };
      }
      if (CLOSED_STAGES.has(existing.stage)) {
        return { kind: "terminal_stage" as const, deal: existing };
      }
      const updated = await tx.deal.update({
        where: { id: dealId },
        data: {
          stage,
          closedAt: CLOSED_STAGES.has(stage) ? now : existing.closedAt,
        },
      });
      return { kind: "ok" as const, deal: updated };
    });
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
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
