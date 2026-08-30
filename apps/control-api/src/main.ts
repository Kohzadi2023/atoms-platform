import { createPrismaClient } from "@atoms/db";
import { S3ObjectStorageProvider } from "@atoms/storage-provider";
import { z } from "zod";

import { buildControlApi } from "./app.js";
import { resolveAuthRuntimeOptions } from "./auth-runtime.js";
import { BullMqAttachmentScanQueue } from "./attachment-queue.js";
import { PrismaAttachmentRepository } from "./attachment-repository.js";
import { BullMqDatabaseOperationQueue } from "./database-operation-queue.js";
import { PrismaDatabaseControlRepository } from "./database-repository.js";
import { PrismaControlRepository } from "./repository.js";
import { BullMqRunQueue } from "./run-queue.js";

const EnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
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
    S3_PUBLIC_ENDPOINT: z.string().url().optional(),
    S3_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_KMS_KEY_ID: z.string().min(1).optional(),
    RUN_QUEUE_PREFIX: z.string().trim().min(1).optional(),
    AUTH_REQUIRED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    AUTH_ISSUER_URL: z.string().trim().url().optional(),
    AUTH_AUDIENCE: z.string().trim().min(1).optional(),
    AUTH_JWKS_URL: z.string().trim().url().optional(),
    AUTH_ALLOWED_ALGORITHMS: z
      .string()
      .default("ES256")
      .transform((value) =>
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      )
      .pipe(z.array(z.string().min(1)).min(1).max(10)),
    AUTH_DEV_AUTHENTICATOR_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    AUTH_DEV_ACCESS_TOKEN: z.string().trim().min(32).optional(),
    AUTH_DEV_USER_ID: z
      .string()
      .trim()
      .min(1)
      .max(191)
      .default("local-demo-user"),
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
  const authRuntime = resolveAuthRuntimeOptions({
    NODE_ENV: environment.NODE_ENV,
    AUTH_REQUIRED: environment.AUTH_REQUIRED,
    AUTH_ISSUER_URL: environment.AUTH_ISSUER_URL,
    AUTH_AUDIENCE: environment.AUTH_AUDIENCE,
    AUTH_JWKS_URL: environment.AUTH_JWKS_URL,
    AUTH_ALLOWED_ALGORITHMS: environment.AUTH_ALLOWED_ALGORITHMS,
    AUTH_DEV_AUTHENTICATOR_ENABLED: environment.AUTH_DEV_AUTHENTICATOR_ENABLED,
    AUTH_DEV_ACCESS_TOKEN: environment.AUTH_DEV_ACCESS_TOKEN,
    AUTH_DEV_USER_ID: environment.AUTH_DEV_USER_ID,
  });
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
  const runQueue = new BullMqRunQueue({
    redisUrl: environment.REDIS_URL,
    ...(environment.RUN_QUEUE_PREFIX === undefined
      ? {}
      : { prefix: environment.RUN_QUEUE_PREFIX }),
  });
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
    ...(environment.S3_PUBLIC_ENDPOINT === undefined
      ? {}
      : { signingEndpoint: environment.S3_PUBLIC_ENDPOINT }),
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
    authRequired: authRuntime.authRequired,
    ...(authRuntime.authenticator === undefined
      ? {}
      : { authenticator: authRuntime.authenticator }),
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
