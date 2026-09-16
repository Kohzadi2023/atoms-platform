import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@atoms/db";

export interface DealReadyForHandoff {
  readonly dealId: string;
  readonly gtmScopeId: string;
  readonly prospectId: string;
  readonly closedAt: Date;
}

export type RecordHandoffResult = "created" | "already_exists";

export interface CustomerSuccessHandoffRepository {
  listDealsReadyForHandoff(): Promise<readonly DealReadyForHandoff[]>;
  recordHandoff(
    dealId: string,
    gtmScopeId: string,
    prospectId: string,
    now: Date,
  ): Promise<RecordHandoffResult>;
}

export class PrismaCustomerSuccessHandoffRepository
  implements CustomerSuccessHandoffRepository
{
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async listDealsReadyForHandoff(): Promise<readonly DealReadyForHandoff[]> {
    const deals = await this.#prisma.deal.findMany({
      where: { stage: "CLOSED_WON", customerSuccessHandoff: null },
      select: {
        id: true,
        gtmScopeId: true,
        prospectId: true,
        closedAt: true,
      },
    });
    return deals.map((deal) => ({
      dealId: deal.id,
      gtmScopeId: deal.gtmScopeId,
      prospectId: deal.prospectId,
      // closedAt is nullable on Deal (a deal can be CLOSED_WON without ever
      // having had closedAt explicitly set by a caller); fall back to the
      // detection time itself rather than fabricating a closing time.
      closedAt: deal.closedAt ?? new Date(),
    }));
  }

  async recordHandoff(
    dealId: string,
    gtmScopeId: string,
    prospectId: string,
    now: Date,
  ): Promise<RecordHandoffResult> {
    try {
      await this.#prisma.customerSuccessHandoff.create({
        data: {
          id: randomUUID(),
          dealId,
          gtmScopeId,
          prospectId,
          detectedAt: now,
        },
      });
      return "created";
    } catch (error) {
      // Same idempotency-race handling as
      // apps/control-api/src/repository.ts's createRunWithIdempotency:
      // a concurrent reconcile() call may have already recorded this exact
      // deal between listDealsReadyForHandoff() and this create() call.
      if (prismaErrorCode(error) === "P2002") {
        return "already_exists";
      }
      throw error;
    }
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
