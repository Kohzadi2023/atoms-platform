import { ApproveOrphanCleanupInputSchema } from "@atoms/contracts";
import { createPrismaClient } from "@atoms/db";
import { z } from "zod";

import { PrismaDatabaseReconciliationRepository } from "./database-reconciliation-repository.js";

const EnvironmentSchema = z.object({ DATABASE_URL: z.string().min(1) }).passthrough();

async function main(): Promise<void> {
  const environment = EnvironmentSchema.parse(process.env);
  const input = ApproveOrphanCleanupInputSchema.parse(parseNamedArguments());
  const prisma = createPrismaClient(environment.DATABASE_URL);
  try {
    const repository = new PrismaDatabaseReconciliationRepository(prisma);
    const result = await repository.approveOrphanCleanup(input, new Date());
    if (result.kind === "not_found") {
      throw new Error("Orphan finding and external resource did not match");
    }
    if (result.kind === "not_ready") {
      throw new Error(`Orphan finding cannot be approved: ${result.reason}`);
    }
    console.log(`Approved orphan cleanup finding ${result.findingId}`);
  } finally {
    await prisma.$disconnect();
  }
}

function parseNamedArguments(): Record<string, string> {
  const values = new Map<string, string>();
  const argumentsList = process.argv.slice(2);
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--")) {
      throw new Error(
        "Expected --finding-id, --external-id, --approved-by, and --confirmation values",
      );
    }
    values.set(name.slice(2), value);
  }
  return {
    findingId: required(values, "finding-id"),
    externalId: required(values, "external-id"),
    approvedBy: required(values, "approved-by"),
    confirmation: required(values, "confirmation"),
  };
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined) throw new Error(`Missing --${key}`);
  return value;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
