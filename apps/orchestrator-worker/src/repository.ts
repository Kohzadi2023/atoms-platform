import { createHash } from "node:crypto";

import { AgentOutputSchemas, type AgentProjectFile } from "@atoms/agents";
import {
  JsonValueSchema,
  type JsonValue,
  type RunEventType,
  type RunJob,
  validateRunEventPayload,
} from "@atoms/contracts";
import {
  Prisma,
  type AgentRun,
  type AgentTask,
  type PrismaClient,
} from "@atoms/db";

import type {
  CompleteTaskInput,
  CompleteTaskResult,
  FailTaskInput,
  PrepareTaskInput,
  RunClaimResult,
  RunExecutionRecord,
  TaskMutationResult,
  WorkerRepository,
  WorkerTaskRecord,
} from "./domain.js";
import type {
  CreateSandboxSessionInput,
  Phase2ValidationRepository,
  RecordPreviewReadyInput,
  RecordSandboxCommandInput,
  SandboxSessionMutationResult,
} from "./validation.js";

export class PrismaWorkerRepository
  implements WorkerRepository, Phase2ValidationRepository
{
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  claimRun(job: RunJob, now: Date): Promise<RunClaimResult> {
    return this.#prisma.$transaction(async (transaction) => {
      const current = await transaction.agentRun.findUnique({
        where: { id: job.runId },
      });
      if (current === null) return { kind: "missing" };

      if (
        current.status === "RUNNING" &&
        current.controlVersion === job.controlVersion + 1
      ) {
        return { kind: "ready", run: toRunExecutionRecord(current) };
      }

      if (
        current.status !== "PENDING" ||
        current.controlVersion !== job.controlVersion
      ) {
        return {
          kind: "stale",
          status: current.status,
          controlVersion: current.controlVersion,
        };
      }

      const claimed = await transaction.agentRun.updateMany({
        where: {
          id: current.id,
          status: "PENDING",
          controlVersion: job.controlVersion,
        },
        data: {
          status: "RUNNING",
          controlVersion: { increment: 1 },
          startedAt: current.startedAt ?? now,
          lastHeartbeatAt: now,
        },
      });
      if (claimed.count !== 1) {
        const latest = await transaction.agentRun.findUniqueOrThrow({
          where: { id: current.id },
        });
        return {
          kind: "stale",
          status: latest.status,
          controlVersion: latest.controlVersion,
        };
      }

      const run = await transaction.agentRun.findUniqueOrThrow({
        where: { id: current.id },
      });
      await appendEvent(transaction, run.id, "run.status_changed", {
        from: "PENDING",
        to: "RUNNING",
        command: job.command,
        controlVersion: run.controlVersion,
      });
      return { kind: "ready", run: toRunExecutionRecord(run) };
    });
  }

  prepareTask(input: PrepareTaskInput): Promise<TaskMutationResult> {
    return this.#prisma.$transaction(
      async (transaction): Promise<TaskMutationResult> => {
        if (!(await touchActiveRun(transaction, input.runId, input.expectedControlVersion, input.now))) {
          return { kind: "stopped" };
        }

        const existing = await transaction.agentTask.findUnique({
          where: {
            runId_ordinal: { runId: input.runId, ordinal: input.ordinal },
          },
        });
        if (existing !== null) {
          return { kind: "ok", task: toWorkerTaskRecord(existing) };
        }

        const task = await transaction.agentTask.create({
          data: {
            runId: input.runId,
            agentName: input.agentName,
            description: input.description,
            ordinal: input.ordinal,
            input: toPrismaJson(input.input),
          },
        });
        await appendEvent(transaction, input.runId, "task.created", {
          taskId: task.id,
          agent: task.agentName,
          ordinal: task.ordinal,
          description: task.description,
        });
        return { kind: "ok", task: toWorkerTaskRecord(task) };
      },
      { isolationLevel: "Serializable" },
    );
  }

  startTask(
    runId: string,
    expectedControlVersion: number,
    taskId: string,
    now: Date,
  ): Promise<TaskMutationResult> {
    return this.#prisma.$transaction(
      async (transaction): Promise<TaskMutationResult> => {
        if (!(await touchActiveRun(transaction, runId, expectedControlVersion, now))) {
          return { kind: "stopped" };
        }
        const current = await transaction.agentTask.findUniqueOrThrow({
          where: { id: taskId },
        });
        if (current.status === "COMPLETED") {
          return { kind: "ok", task: toWorkerTaskRecord(current) };
        }

        const task = await transaction.agentTask.update({
          where: { id: taskId },
          data: {
            status: "RUNNING",
            attempt: { increment: 1 },
            startedAt: now,
            completedAt: null,
            error: Prisma.DbNull,
          },
        });
        await appendEvent(transaction, runId, "task.started", {
          taskId: task.id,
          agent: task.agentName,
          ordinal: task.ordinal,
          attempt: task.attempt,
        });
        return { kind: "ok", task: toWorkerTaskRecord(task) };
      },
      { isolationLevel: "Serializable" },
    );
  }

  completeTask(input: CompleteTaskInput): Promise<CompleteTaskResult> {
    return this.#prisma.$transaction(
      async (transaction): Promise<CompleteTaskResult> => {
        if (
          !(await touchActiveRun(
            transaction,
            input.runId,
            input.expectedControlVersion,
            input.now,
          ))
        ) {
          return { kind: "stopped" };
        }

        const current = await transaction.agentTask.findUniqueOrThrow({
          where: { id: input.taskId },
        });
        if (current.status === "COMPLETED") {
          return { kind: "ok", task: toWorkerTaskRecord(current) };
        }

        const run = await transaction.agentRun.findUniqueOrThrow({
          where: { id: input.runId },
          select: { projectId: true, workspaceId: true },
        });
        const filePlans: Array<{
          readonly path: string;
          readonly content: string;
          readonly actualVersion: number;
          readonly shouldWrite: boolean;
        }> = [];

        // Validate every compare-and-swap before writing any revision so a
        // multi-file agent patch is committed as one atomic unit.
        for (const file of input.generatedFiles ?? []) {
          const latest = await transaction.projectFile.findFirst({
            where: {
              projectId: run.projectId,
              filePath: file.path,
            },
            orderBy: { version: "desc" },
          });
          const actualVersion = latest?.version ?? 0;
          if (actualVersion !== file.expectedVersion) {
            return {
              kind: "file_conflict",
              path: file.path,
              expectedVersion: file.expectedVersion,
              actualVersion,
            };
          }
          filePlans.push({
            path: file.path,
            content: file.content,
            actualVersion,
            shouldWrite: latest?.content !== file.content,
          });
        }

        const writtenPaths: string[] = [];
        for (const file of filePlans) {
          if (!file.shouldWrite) continue;
          await transaction.projectFile.create({
            data: {
              projectId: run.projectId,
              filePath: file.path,
              content: file.content,
              version: file.actualVersion + 1,
            },
          });
          writtenPaths.push(file.path);
        }

        let migrationArtifact:
          | {
              readonly schemaPath: string;
              readonly schemaHash: string;
              readonly migrationPaths: string[];
              readonly seedPath: string;
              readonly destructive: boolean;
              readonly policyReport: JsonValue;
            }
          | undefined;
        if (current.agentName === "David") {
          const david = AgentOutputSchemas.David.parse(input.output);
          if (
            david.dataPolicyReport.findings.some(
              (finding) => finding.severity === "BLOCKING",
            )
          ) {
            throw new Error(
              "David data-policy report contains a blocking finding",
            );
          }
          const schema = await transaction.projectFile.findFirst({
            where: {
              projectId: run.projectId,
              filePath: david.schemaPrismaPath,
            },
            orderBy: { version: "desc" },
            select: { content: true },
          });
          if (schema === null) {
            throw new Error(
              `David referenced a missing Prisma schema: ${david.schemaPrismaPath}`,
            );
          }
          migrationArtifact = {
            schemaPath: david.schemaPrismaPath,
            schemaHash: createHash("sha256")
              .update(schema.content, "utf8")
              .digest("hex"),
            migrationPaths: david.migrations.map((migration) => migration.path),
            seedPath: david.seedPath,
            destructive: david.destructiveChanges.length > 0,
            policyReport: JsonValueSchema.parse(david.dataPolicyReport),
          };
        }

        const task = await transaction.agentTask.update({
          where: { id: current.id },
          data: {
            status: "COMPLETED",
            output: toPrismaJson(input.output),
            error: Prisma.DbNull,
            completedAt: input.now,
          },
        });
        let migrationArtifactId: string | undefined;
        if (migrationArtifact !== undefined) {
          await transaction.migrationArtifact.updateMany({
            where: {
              projectId: run.projectId,
              status: "VALIDATED",
              agentTaskId: { not: task.id },
            },
            data: { status: "SUPERSEDED" },
          });
          const artifact = await transaction.migrationArtifact.upsert({
            where: { agentTaskId: task.id },
            update: {
              status: "VALIDATED",
              schemaPath: migrationArtifact.schemaPath,
              schemaHash: migrationArtifact.schemaHash,
              migrationPaths: toPrismaJson(migrationArtifact.migrationPaths),
              seedPath: migrationArtifact.seedPath,
              destructive: migrationArtifact.destructive,
              policyReport: toPrismaJson(migrationArtifact.policyReport),
            },
            create: {
              workspaceId: run.workspaceId,
              projectId: run.projectId,
              sourceRunId: input.runId,
              agentTaskId: task.id,
              schemaPath: migrationArtifact.schemaPath,
              schemaHash: migrationArtifact.schemaHash,
              migrationPaths: toPrismaJson(migrationArtifact.migrationPaths),
              seedPath: migrationArtifact.seedPath,
              destructive: migrationArtifact.destructive,
              policyReport: toPrismaJson(migrationArtifact.policyReport),
            },
          });
          migrationArtifactId = artifact.id;
        }
        await appendEvent(transaction, input.runId, "task.completed", {
          taskId: task.id,
          agent: task.agentName,
          ordinal: task.ordinal,
          attempt: task.attempt,
        });
        await appendEvent(transaction, input.runId, "artifact.created", {
          version: "v1",
          taskId: task.id,
          agent: task.agentName,
          artifactType: `${task.agentName.toLowerCase()}-output`,
          ...(migrationArtifactId === undefined
            ? {}
            : { migrationArtifactId }),
        });
        if (task.agentName === "Sarah") {
          await appendEvent(transaction, input.runId, "artifact.created", {
            version: "v1",
            taskId: task.id,
            agent: task.agentName,
            artifactType: "seo-package",
          });
        }
        if (task.agentName === "Adrian") {
          await appendEvent(transaction, input.runId, "artifact.created", {
            version: "v1",
            taskId: task.id,
            agent: task.agentName,
            artifactType: "content-package",
          });
        }
        if (input.generatedFiles !== undefined) {
          await appendEvent(transaction, input.runId, "code_generated", {
            taskId: task.id,
            paths: writtenPaths,
            fileCount: writtenPaths.length,
          });
        }
        return { kind: "ok", task: toWorkerTaskRecord(task) };
      },
      { isolationLevel: "Serializable" },
    );
  }

  failTask(input: FailTaskInput): Promise<"failed" | "stopped"> {
    return this.#prisma.$transaction(
      async (transaction): Promise<"failed" | "stopped"> => {
        if (
          !(await touchActiveRun(
            transaction,
            input.runId,
            input.expectedControlVersion,
            input.now,
          ))
        ) {
          return "stopped";
        }
        const task = await transaction.agentTask.update({
          where: { id: input.taskId },
          data: {
            status: "FAILED",
            error: toPrismaJson(input.error),
            completedAt: input.now,
          },
        });
        await appendEvent(transaction, input.runId, "task.failed", {
          taskId: task.id,
          agent: task.agentName,
          ordinal: task.ordinal,
          attempt: task.attempt,
          error: input.error,
        });
        return "failed";
      },
      { isolationLevel: "Serializable" },
    );
  }

  async listProjectFiles(projectId: string): Promise<readonly AgentProjectFile[]> {
    const files = await this.#prisma.projectFile.findMany({
      where: { projectId },
      orderBy: [{ filePath: "asc" }, { version: "desc" }],
      distinct: ["filePath"],
    });
    return files.map((file) => ({
      path: file.filePath,
      content: file.content,
      version: file.version,
    }));
  }

  createSandboxSession(
    input: CreateSandboxSessionInput,
  ): Promise<SandboxSessionMutationResult> {
    return this.#prisma.$transaction(
      async (transaction): Promise<SandboxSessionMutationResult> => {
        if (
          !(await touchActiveRun(
            transaction,
            input.run.id,
            input.run.controlVersion,
            input.now,
          ))
        ) {
          return { kind: "stopped" };
        }
        const session = await transaction.sandboxSession.upsert({
          where: {
            runId_attempt: {
              runId: input.run.id,
              attempt: input.attempt,
            },
          },
          update: {
            externalId: input.externalId,
            status: "PROVISIONING",
            expiresAt: input.expiresAt,
            error: Prisma.DbNull,
            terminatedAt: null,
          },
          create: {
            workspaceId: input.run.workspaceId,
            projectId: input.run.projectId,
            runId: input.run.id,
            provider: "E2B",
            externalId: input.externalId,
            attempt: input.attempt,
            expiresAt: input.expiresAt,
          },
        });
        return { kind: "ok", sandboxSessionId: session.id };
      },
      { isolationLevel: "Serializable" },
    );
  }

  markSandboxFilesRestored(
    runId: string,
    expectedControlVersion: number,
    sandboxSessionId: string,
    now: Date,
  ): Promise<boolean> {
    return this.#prisma.$transaction(async (transaction) => {
      if (!(await touchActiveRun(transaction, runId, expectedControlVersion, now))) {
        return false;
      }
      const update = await transaction.sandboxSession.updateMany({
        where: { id: sandboxSessionId, runId },
        data: { status: "VALIDATING" },
      });
      if (update.count !== 1) return false;
      await appendEvent(transaction, runId, "sandbox.ready", {
        version: "v1",
        sandboxSessionId,
        status: "VALIDATING",
      });
      return true;
    });
  }

  recordSandboxCommand(input: RecordSandboxCommandInput): Promise<boolean> {
    return this.#prisma.$transaction(
      async (transaction) => {
        if (
          !(await touchActiveRun(
            transaction,
            input.runId,
            input.expectedControlVersion,
            input.now,
          ))
        ) {
          return false;
        }
        const session = await transaction.sandboxSession.findFirst({
          where: { id: input.sandboxSessionId, runId: input.runId },
          select: { id: true },
        });
        if (session === null) return false;
        const status =
          input.step.result.exitCode === 0 ? "SUCCEEDED" : "FAILED";
        const stdout = truncateDiagnostic(input.step.result.stdout);
        const stderr = truncateDiagnostic(input.step.result.stderr);
        await transaction.sandboxCommand.upsert({
          where: {
            sandboxSessionId_ordinal: {
              sandboxSessionId: input.sandboxSessionId,
              ordinal: input.step.ordinal,
            },
          },
          update: {
            name: toSandboxCommandName(input.step.name),
            command: input.step.command,
            status,
            exitCode: input.step.result.exitCode,
            stdout,
            stderr,
            durationMs: input.step.result.durationMs,
            startedAt: new Date(input.step.startedAt),
            completedAt: new Date(input.step.completedAt),
          },
          create: {
            sandboxSessionId: input.sandboxSessionId,
            ordinal: input.step.ordinal,
            name: toSandboxCommandName(input.step.name),
            command: input.step.command,
            status,
            exitCode: input.step.result.exitCode,
            stdout,
            stderr,
            durationMs: input.step.result.durationMs,
            startedAt: new Date(input.step.startedAt),
            completedAt: new Date(input.step.completedAt),
          },
        });
        await appendEvent(transaction, input.runId, "task.progress", {
          version: "v1",
          phase: "sandbox-validation",
          sandboxSessionId: input.sandboxSessionId,
          ordinal: input.step.ordinal,
          step: input.step.name,
          status,
          exitCode: input.step.result.exitCode,
          durationMs: input.step.result.durationMs,
          stdout,
          stderr,
        });
        return true;
      },
      { isolationLevel: "Serializable" },
    );
  }

  recordPreviewReady(input: RecordPreviewReadyInput): Promise<boolean> {
    return this.#prisma.$transaction(
      async (transaction) => {
        if (
          !(await touchActiveRun(
            transaction,
            input.run.id,
            input.run.controlVersion,
            input.now,
          ))
        ) {
          return false;
        }
        const sessionUpdate = await transaction.sandboxSession.updateMany({
          where: { id: input.sandboxSessionId, runId: input.run.id },
          data: { status: "READY", error: Prisma.DbNull },
        });
        if (sessionUpdate.count !== 1) return false;
        await transaction.previewSession.upsert({
          where: { sandboxSessionId: input.sandboxSessionId },
          update: {
            status: "READY",
            gatewayUrl: input.gatewayUrl,
            processId: input.processId,
            expiresAt: input.expiresAt,
            readyAt: input.now,
            stoppedAt: null,
            error: Prisma.DbNull,
          },
          create: {
            id: input.sandboxSessionId,
            workspaceId: input.run.workspaceId,
            projectId: input.run.projectId,
            runId: input.run.id,
            sandboxSessionId: input.sandboxSessionId,
            status: "READY",
            gatewayUrl: input.gatewayUrl,
            processId: input.processId,
            expiresAt: input.expiresAt,
            readyAt: input.now,
          },
        });
        await appendEvent(transaction, input.run.id, "preview.updated", {
          version: "v1",
          previewSessionId: input.sandboxSessionId,
          status: "READY",
          url: input.gatewayUrl,
          expiresAt: input.expiresAt.toISOString(),
        });
        return true;
      },
      { isolationLevel: "Serializable" },
    );
  }

  async markSandboxFailed(
    sandboxSessionId: string,
    error: JsonValue,
    now: Date,
  ): Promise<void> {
    await this.#prisma.sandboxSession.updateMany({
      where: { id: sandboxSessionId },
      data: {
        status: "FAILED",
        error: toPrismaJson(error),
        terminatedAt: now,
      },
    });
  }

  markPreviewStopped(sandboxSessionId: string, now: Date): Promise<void> {
    return this.#prisma.$transaction(async (transaction) => {
      const session = await transaction.sandboxSession.findUnique({
        where: { id: sandboxSessionId },
        select: {
          id: true,
          runId: true,
          preview: { select: { id: true, expiresAt: true } },
        },
      });
      if (session === null) return;
      await transaction.sandboxSession.update({
        where: { id: session.id },
        data: { status: "TERMINATED", terminatedAt: now },
      });
      if (session.preview === null) return;
      await transaction.previewSession.update({
        where: { id: session.preview.id },
        data: { status: "STOPPED", stoppedAt: now },
      });
      await appendEvent(transaction, session.runId, "preview.updated", {
        version: "v1",
        previewSessionId: session.preview.id,
        status: "STOPPED",
        expiresAt: session.preview.expiresAt.toISOString(),
      });
    });
  }

  requestApproval(
    runId: string,
    expectedControlVersion: number,
    reason: string,
    now: Date,
  ): Promise<boolean> {
    return this.#prisma.$transaction(async (transaction) => {
      const update = await transaction.agentRun.updateMany({
        where: {
          id: runId,
          status: "RUNNING",
          controlVersion: expectedControlVersion,
        },
        data: {
          status: "PAUSED",
          controlVersion: { increment: 1 },
          pausedAt: now,
          lastHeartbeatAt: now,
        },
      });
      if (update.count !== 1) return false;
      await appendEvent(transaction, runId, "approval.required", { reason });
      return true;
    });
  }

  completeRun(
    runId: string,
    expectedControlVersion: number,
    now: Date,
  ): Promise<boolean> {
    return this.#prisma.$transaction(async (transaction) => {
      const update = await transaction.agentRun.updateMany({
        where: {
          id: runId,
          status: "RUNNING",
          controlVersion: expectedControlVersion,
        },
        data: {
          status: "COMPLETED",
          controlVersion: { increment: 1 },
          completedAt: now,
          lastHeartbeatAt: now,
        },
      });
      if (update.count !== 1) return false;
      await appendEvent(transaction, runId, "run.completed", {
        completedAt: now.toISOString(),
      });
      return true;
    });
  }

  failRun(
    runId: string,
    expectedControlVersion: number,
    error: JsonValue,
    now: Date,
  ): Promise<boolean> {
    return this.#prisma.$transaction(async (transaction) => {
      const update = await transaction.agentRun.updateMany({
        where: {
          id: runId,
          status: "RUNNING",
          controlVersion: expectedControlVersion,
        },
        data: {
          status: "FAILED",
          controlVersion: { increment: 1 },
          error: toPrismaJson(error),
          completedAt: now,
          lastHeartbeatAt: now,
        },
      });
      if (update.count !== 1) return false;
      await appendEvent(transaction, runId, "run.failed", { error });
      return true;
    });
  }

  close(): Promise<void> {
    return this.#prisma.$disconnect();
  }
}

async function touchActiveRun(
  transaction: Prisma.TransactionClient,
  runId: string,
  expectedControlVersion: number,
  now: Date,
): Promise<boolean> {
  const update = await transaction.agentRun.updateMany({
    where: {
      id: runId,
      status: "RUNNING",
      controlVersion: expectedControlVersion,
    },
    data: { lastHeartbeatAt: now },
  });
  return update.count === 1;
}

async function appendEvent(
  transaction: Prisma.TransactionClient,
  runId: string,
  eventType: RunEventType,
  payload: JsonValue,
): Promise<void> {
  const normalizedPayload = JsonValueSchema.parse(
    validateRunEventPayload(eventType, payload),
  );
  const run = await transaction.agentRun.update({
    where: { id: runId },
    data: { eventSequence: { increment: 1 } },
    select: { eventSequence: true },
  });
  await transaction.runEvent.create({
    data: {
      runId,
      sequence: run.eventSequence,
      eventType,
      payload: toPrismaJson(normalizedPayload),
    },
  });
}

function toRunExecutionRecord(run: AgentRun): RunExecutionRecord {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    status: run.status,
    prompt: run.prompt,
    controlVersion: run.controlVersion,
  };
}

function toWorkerTaskRecord(task: AgentTask): WorkerTaskRecord {
  return {
    id: task.id,
    runId: task.runId,
    agentName: task.agentName,
    description: task.description,
    ordinal: task.ordinal,
    status: task.status,
    attempt: task.attempt,
    output: task.output === null ? null : JsonValueSchema.parse(task.output),
  };
}

function toPrismaJson(value: JsonValue): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function truncateDiagnostic(value: string): string {
  const maximumLength = 64_000;
  return value.length <= maximumLength
    ? value
    : `${value.slice(0, maximumLength)}\n[truncated]`;
}

function toSandboxCommandName(
  name: RecordSandboxCommandInput["step"]["name"],
):
  | "INSTALL"
  | "PRISMA_VALIDATE"
  | "LINT"
  | "TYPECHECK"
  | "TEST"
  | "BUILD"
  | "PREVIEW_START"
  | "PREVIEW_HEALTH" {
  return name.replaceAll("-", "_").toUpperCase() as
    | "INSTALL"
    | "PRISMA_VALIDATE"
    | "LINT"
    | "TYPECHECK"
    | "TEST"
    | "BUILD"
    | "PREVIEW_START"
    | "PREVIEW_HEALTH";
}
