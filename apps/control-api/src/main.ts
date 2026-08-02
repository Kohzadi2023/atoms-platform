import { createPrismaClient } from "@atoms/db";
import { z } from "zod";

import { buildControlApi } from "./app.js";
import { BullMqDatabaseOperationQueue } from "./database-operation-queue.js";
import { PrismaDatabaseControlRepository } from "./database-repository.js";
import { PrismaControlRepository } from "./repository.js";
import { BullMqRunQueue } from "./run-queue.js";

const EnvironmentSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().url(),
    CONTROL_API_HOST: z.string().min(1).default("0.0.0.0"),
    CONTROL_API_PORT: z.coerce.number().int().min(1).max(65_535).default(3_001),
    SUPABASE_CREDENTIAL_SECRET_REF: z.string().trim().min(1).optional(),
  })
  .passthrough();

async function main(): Promise<void> {
  const environment = EnvironmentSchema.parse(process.env);
  const prisma = createPrismaClient(environment.DATABASE_URL);
  const repository = new PrismaControlRepository(prisma);
  const databaseRepository = new PrismaDatabaseControlRepository(prisma, {
    ...(environment.SUPABASE_CREDENTIAL_SECRET_REF === undefined
      ? {}
      : {
          providerCredentialSecretRef:
            environment.SUPABASE_CREDENTIAL_SECRET_REF,
        }),
  });
  const runQueue = new BullMqRunQueue({ redisUrl: environment.REDIS_URL });
  const databaseQueue = new BullMqDatabaseOperationQueue({
    redisUrl: environment.REDIS_URL,
  });
  const app = await buildControlApi({
    repository,
    runQueue,
    logger: true,
    closeDependencies: true,
    databaseOperations: {
      repository: databaseRepository,
      queue: databaseQueue,
    },
  });

  const shutdown = async (): Promise<void> => {
    await app.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await app.listen({
    host: environment.CONTROL_API_HOST,
    port: environment.CONTROL_API_PORT,
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
