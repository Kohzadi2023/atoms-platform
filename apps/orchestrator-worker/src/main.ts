import { ModelBackedAgentRuntime } from "@atoms/agents";
import { createPrismaClient } from "@atoms/db";
import {
  E2BDatabaseMigrationRunner,
  SupabaseDatabaseProvider,
  VaultSecretStore,
} from "@atoms/database-provider";
import { OpenAIModelGateway } from "@atoms/model-gateway";
import {
  PreviewTicketSigner,
  RedisPreviewSessionStore,
} from "@atoms/preview";
import {
  E2BSandboxAdapter,
  ProjectValidationRunner,
} from "@atoms/sandbox-provider";
import {
  ClamAvScanner,
  S3ObjectStorageProvider,
} from "@atoms/storage-provider";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { z } from "zod";

import { BullMqOrchestratorWorker } from "./bullmq-worker.js";
import { BullMqDatabaseOperationWorker } from "./database-bullmq-worker.js";
import { DatabaseOperationProcessor } from "./database-processor.js";
import { PrismaDatabaseReconciliationRepository } from "./database-reconciliation-repository.js";
import { BullMqDatabaseReconciliationWorker } from "./database-reconciliation-worker.js";
import { DatabaseReconciler } from "./database-reconciler.js";
import { BullMqDatabaseRecoveryQueue } from "./database-recovery-queue.js";
import { PrismaDatabaseOperationRepository } from "./database-repository.js";
import { RunProcessor } from "./processor.js";
import { PrismaWorkerRepository } from "./repository.js";
import { Phase2RunValidator } from "./validation.js";
import { BullMqAttachmentWorker } from "./attachment-bullmq-worker.js";
import { AttachmentProcessor } from "./attachment-processor.js";
import { PrismaAttachmentScanRepository } from "./attachment-repository.js";
import { PrismaRunAttachmentLoader } from "./attachment-loader.js";

const EnvironmentSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().url(),
    OPENAI_API_KEY: z.string().min(1),
    E2B_API_KEY: z.string().min(1),
    E2B_TEMPLATE: z.string().trim().min(1).optional(),
    E2B_ALLOWED_HOSTS: z
      .string()
      .default("registry.npmjs.org,binaries.prisma.sh"),
    SANDBOX_IDLE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(3_600_000)
      .default(900_000),
    PREVIEW_SIGNING_SECRET: z.string().min(32),
    PREVIEW_BASE_DOMAIN: z.string().min(3),
    PREVIEW_PUBLIC_PROTOCOL: z.enum(["http", "https"]).default("https"),
    RUN_QUEUE_PREFIX: z.string().trim().min(1).optional(),
    ORCHESTRATOR_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
    ATTACHMENT_SCAN_CONCURRENCY: z.coerce
      .number()
      .int()
      .min(1)
      .max(16)
      .default(2),
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
    CLAMAV_HOST: z.string().trim().min(1).default("127.0.0.1"),
    CLAMAV_PORT: z.coerce.number().int().min(1).max(65_535).default(3_310),
    CLAMAV_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(30_000),
    DATABASE_OPERATION_CONCURRENCY: z.coerce
      .number()
      .int()
      .min(1)
      .max(8)
      .default(1),
    DATABASE_RECONCILIATION_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(24 * 60 * 60_000)
      .default(300_000),
    DATABASE_STALE_AFTER_MS: z.coerce
      .number()
      .int()
      .min(5 * 60_000)
      .max(24 * 60 * 60_000)
      .default(20 * 60_000),
    DATABASE_ORPHAN_GRACE_MS: z.coerce
      .number()
      .int()
      .min(60 * 60_000)
      .max(30 * 24 * 60 * 60_000)
      .default(24 * 60 * 60_000),
    DATABASE_ABANDONED_SWEEP_AFTER_MS: z.coerce
      .number()
      .int()
      .min(5 * 60_000)
      .max(24 * 60 * 60_000)
      .default(30 * 60_000),
    DATABASE_MAX_RECOVERY_ATTEMPTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(10)
      .default(3),
    DATABASE_RECOVERY_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100),
    DATABASE_APPROVED_ORPHAN_CLEANUP_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    SUPABASE_ACCESS_TOKEN: z.string().min(1).optional(),
    SUPABASE_ORGANIZATION_SLUG: z.string().trim().min(1).optional(),
    SUPABASE_MANAGEMENT_API_URL: z
      .string()
      .url()
      .default("https://api.supabase.com"),
    VAULT_ADDR: z.string().url().optional(),
    VAULT_TOKEN: z.string().min(1).optional(),
    VAULT_KV_MOUNT: z.string().trim().min(1).default("secret"),
    VAULT_NAMESPACE: z.string().trim().min(1).optional(),
  })
  .passthrough()
  .superRefine((environment, context) => {
    const phase3Values = [
      environment.SUPABASE_ACCESS_TOKEN,
      environment.SUPABASE_ORGANIZATION_SLUG,
      environment.VAULT_ADDR,
      environment.VAULT_TOKEN,
    ];
    const configured = phase3Values.filter((value) => value !== undefined).length;
    if (configured !== 0 && configured !== phase3Values.length) {
      context.addIssue({
        code: "custom",
        message:
          "Phase 3 requires SUPABASE_ACCESS_TOKEN, SUPABASE_ORGANIZATION_SLUG, VAULT_ADDR, and VAULT_TOKEN together",
      });
    }
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
  const repository = new PrismaWorkerRepository(prisma);
  const attachmentRepository = new PrismaAttachmentScanRepository(prisma);
  const checkpointer = PostgresSaver.fromConnString(environment.DATABASE_URL);
  await checkpointer.setup();

  const gateway = new OpenAIModelGateway({ apiKey: environment.OPENAI_API_KEY });
  const agents = new ModelBackedAgentRuntime(gateway);
  const sandboxProvider = new E2BSandboxAdapter({
    apiKey: environment.E2B_API_KEY,
  });
  const validationRunner = new ProjectValidationRunner({
    provider: sandboxProvider,
    ...(environment.E2B_TEMPLATE === undefined
      ? {}
      : { template: environment.E2B_TEMPLATE }),
    allowedHosts: environment.E2B_ALLOWED_HOSTS.split(",")
      .map((host) => host.trim())
      .filter((host) => host.length > 0),
    sandboxTimeoutMs: environment.SANDBOX_IDLE_TIMEOUT_MS,
  });
  const previewStore = new RedisPreviewSessionStore({
    redisUrl: environment.REDIS_URL,
  });
  const previewSigner = new PreviewTicketSigner({
    secret: environment.PREVIEW_SIGNING_SECRET,
    baseDomain: environment.PREVIEW_BASE_DOMAIN,
    publicProtocol: environment.PREVIEW_PUBLIC_PROTOCOL,
  });
  const validator = new Phase2RunValidator({
    repository,
    runner: validationRunner,
    previewStore,
    previewSigner,
  });
  const attachmentStorage = new S3ObjectStorageProvider({
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
  const processor = new RunProcessor({
    repository,
    agents,
    checkpointer,
    validator,
    attachmentLoader: new PrismaRunAttachmentLoader(prisma, attachmentStorage),
  });
  const worker = new BullMqOrchestratorWorker({
    redisUrl: environment.REDIS_URL,
    processor,
    concurrency: environment.ORCHESTRATOR_CONCURRENCY,
    ...(environment.RUN_QUEUE_PREFIX === undefined
      ? {}
      : { prefix: environment.RUN_QUEUE_PREFIX }),
  });
  const attachmentProcessor = new AttachmentProcessor({
    repository: attachmentRepository,
    storage: attachmentStorage,
    scanner: new ClamAvScanner({
      host: environment.CLAMAV_HOST,
      port: environment.CLAMAV_PORT,
      timeoutMs: environment.CLAMAV_TIMEOUT_MS,
    }),
  });
  const attachmentWorker = new BullMqAttachmentWorker({
    redisUrl: environment.REDIS_URL,
    processor: attachmentProcessor,
    concurrency: environment.ATTACHMENT_SCAN_CONCURRENCY,
    ...(environment.RUN_QUEUE_PREFIX === undefined
      ? {}
      : { prefix: environment.RUN_QUEUE_PREFIX }),
  });
  attachmentWorker.onError((error) =>
    console.error("Attachment worker error", error),
  );
  attachmentWorker.onFailed((jobId, error) =>
    console.error("Attachment scan job failed", { jobId, error }),
  );

  const phase3Enabled = environment.SUPABASE_ACCESS_TOKEN !== undefined;
  let databaseWorker: BullMqDatabaseOperationWorker | undefined;
  let databaseReconciliationWorker:
    | BullMqDatabaseReconciliationWorker
    | undefined;
  let databaseRecoveryQueue: BullMqDatabaseRecoveryQueue | undefined;
  if (phase3Enabled) {
    const secretStore = new VaultSecretStore({
      address: environment.VAULT_ADDR as string,
      token: environment.VAULT_TOKEN as string,
      mount: environment.VAULT_KV_MOUNT,
      ...(environment.VAULT_NAMESPACE === undefined
        ? {}
        : { namespace: environment.VAULT_NAMESPACE }),
    });
    const databaseProvider = new SupabaseDatabaseProvider({
      accessToken: environment.SUPABASE_ACCESS_TOKEN as string,
      organizationSlug: environment.SUPABASE_ORGANIZATION_SLUG as string,
      baseUrl: environment.SUPABASE_MANAGEMENT_API_URL,
      secretStore,
    });
    const databaseRepository = new PrismaDatabaseOperationRepository(prisma);
    const migrationRunner = new E2BDatabaseMigrationRunner({
      provider: sandboxProvider,
      ...(environment.E2B_TEMPLATE === undefined
        ? {}
        : { template: environment.E2B_TEMPLATE }),
      packageHosts: environment.E2B_ALLOWED_HOSTS.split(",")
        .map((host) => host.trim())
        .filter((host) => host.length > 0),
      sandboxTimeoutMs: environment.SANDBOX_IDLE_TIMEOUT_MS,
    });
    const databaseProcessor = new DatabaseOperationProcessor({
      repository: databaseRepository,
      provider: databaseProvider,
      secretStore,
      migrationRunner,
    });
    databaseWorker = new BullMqDatabaseOperationWorker({
      redisUrl: environment.REDIS_URL,
      processor: databaseProcessor,
      concurrency: environment.DATABASE_OPERATION_CONCURRENCY,
      ...(environment.RUN_QUEUE_PREFIX === undefined
        ? {}
        : { prefix: environment.RUN_QUEUE_PREFIX }),
    });
    databaseWorker.onError((error) =>
      console.error("Database operation worker error", error),
    );
    databaseWorker.onFailed((jobId, error) =>
      console.error("Database operation job failed", { jobId, error }),
    );

    const reconciliationRepository =
      new PrismaDatabaseReconciliationRepository(prisma);
    databaseRecoveryQueue = new BullMqDatabaseRecoveryQueue({
      redisUrl: environment.REDIS_URL,
      ...(environment.RUN_QUEUE_PREFIX === undefined
        ? {}
        : { prefix: environment.RUN_QUEUE_PREFIX }),
    });
    const reconciler = new DatabaseReconciler({
      repository: reconciliationRepository,
      provider: databaseProvider,
      recoveryQueue: databaseRecoveryQueue,
      staleAfterMs: environment.DATABASE_STALE_AFTER_MS,
      orphanGraceMs: environment.DATABASE_ORPHAN_GRACE_MS,
      abandonedSweepAfterMs: environment.DATABASE_ABANDONED_SWEEP_AFTER_MS,
      maxRecoveryAttempts: environment.DATABASE_MAX_RECOVERY_ATTEMPTS,
      recoveryBatchSize: environment.DATABASE_RECOVERY_BATCH_SIZE,
      cleanupApprovedOrphans:
        environment.DATABASE_APPROVED_ORPHAN_CLEANUP_ENABLED,
    });
    databaseReconciliationWorker =
      new BullMqDatabaseReconciliationWorker({
        redisUrl: environment.REDIS_URL,
        reconciler,
        intervalMs: environment.DATABASE_RECONCILIATION_INTERVAL_MS,
        ...(environment.RUN_QUEUE_PREFIX === undefined
          ? {}
          : { prefix: environment.RUN_QUEUE_PREFIX }),
      });
    await databaseReconciliationWorker.start();
    databaseReconciliationWorker.onError((error) =>
      console.error("Database reconciliation worker error", error),
    );
    databaseReconciliationWorker.onFailed((jobId, error) =>
      console.error("Database reconciliation job failed", { jobId, error }),
    );
  }

  worker.onError((error) => console.error("Orchestrator worker error", error));
  worker.onFailed((jobId, error) =>
    console.error("Orchestrator job failed", { jobId, error }),
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await databaseReconciliationWorker?.close();
    await databaseRecoveryQueue?.close();
    await databaseWorker?.close();
    await attachmentWorker.close();
    await worker.close();
    await previewStore.close();
    await checkpointer.end();
    await repository.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
