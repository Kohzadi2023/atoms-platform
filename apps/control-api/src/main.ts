import { createPrismaClient } from "@atoms/db";
import { S3ObjectStorageProvider } from "@atoms/storage-provider";
import { z } from "zod";

import { buildControlApi } from "./app.js";
import { BullMqAttachmentScanQueue } from "./attachment-queue.js";
import { PrismaAttachmentRepository } from "./attachment-repository.js";
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
    CONTROL_API_CORS_ORIGINS: z
      .string()
      .default("http://localhost:3000")
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0),
      )
      .pipe(z.array(z.string().url()).min(1).max(10)),
    SUPABASE_CREDENTIAL_SECRET_REF: z.string().trim().min(1).optional(),
    S3_BUCKET: z.string().trim().min(3).default("atoms-attachments"),
    S3_REGION: z.string().trim().min(1).default("us-east-1"),
    S3_ENDPOINT: z.string().url().optional(),
    S3_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_KMS_KEY_ID: z.string().min(1).optional(),
    RUN_QUEUE_PREFIX: z.string().trim().min(1).optional(),
  })
  .passthrough()
  .superRefine((environment, context) => {
    if (
      (environment.S3_ACCESS_KEY_ID === undefined) !==
      (environment.S3_SECRET_ACCESS_KEY === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be configured together",
      });
    }
  });

async function main(): Promise<void> {
  const environment = EnvironmentSchema.parse(process.env);
  const prisma = createPrismaClient(environment.DATABASE_URL);
  const repository = new PrismaControlRepository(prisma);
  const attachmentRepository = new PrismaAttachmentRepository(prisma);
  const databaseRepository = new PrismaDatabaseControlRepository(prisma, {
    ...(environment.SUPABASE_CREDENTIAL_SECRET_REF === undefined
      ? {}
      : {
          providerCredentialSecretRef:
            environment.SUPABASE_CREDENTIAL_SECRET_REF,
        }),
  });
  const runQueue = new BullMqRunQueue({ redisUrl: environment.REDIS_URL });
  const attachmentQueue = new BullMqAttachmentScanQueue({
    redisUrl: environment.REDIS_URL,
    ...(environment.RUN_QUEUE_PREFIX === undefined
      ? {}
      : { prefix: environment.RUN_QUEUE_PREFIX }),
  });
  const storage = new S3ObjectStorageProvider({
    bucket: environment.S3_BUCKET,
    region: environment.S3_REGION,
    forcePathStyle: environment.S3_FORCE_PATH_STYLE,
    ...(environment.S3_ENDPOINT === undefined
      ? {}
      : { endpoint: environment.S3_ENDPOINT }),
    ...(environment.S3_ACCESS_KEY_ID === undefined ||
    environment.S3_SECRET_ACCESS_KEY === undefined
      ? {}
      : {
          accessKeyId: environment.S3_ACCESS_KEY_ID,
          secretAccessKey: environment.S3_SECRET_ACCESS_KEY,
        }),
    ...(environment.S3_KMS_KEY_ID === undefined
      ? {}
      : { kmsKeyId: environment.S3_KMS_KEY_ID }),
  });
  const databaseQueue = new BullMqDatabaseOperationQueue({
    redisUrl: environment.REDIS_URL,
  });
  const app = await buildControlApi({
    repository,
    runQueue,
    logger: true,
    closeDependencies: true,
    corsOrigins: environment.CONTROL_API_CORS_ORIGINS,
    databaseOperations: {
      repository: databaseRepository,
      queue: databaseQueue,
    },
    attachmentOperations: {
      repository: attachmentRepository,
      queue: attachmentQueue,
      storage,
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
