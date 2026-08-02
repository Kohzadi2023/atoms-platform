import { z } from "zod";

import type {
  ExecResult,
  PreviewUrl,
  SandboxHandle,
  SandboxProvider,
} from "./types.js";

const ProjectSnapshotFileSchema = z
  .object({
    path: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .refine((value) => !value.startsWith("/"), {
        message: "project file paths must be relative",
      })
      .refine((value) => !value.includes("\\"), {
        message: "project file paths must use POSIX separators",
      })
      .refine((value) => !value.split("/").includes(".."), {
        message: "project file paths must not traverse",
      }),
    content: z.string().max(5_000_000),
  })
  .strict();

const ValidationInputSchema = z
  .object({
    files: z.array(ProjectSnapshotFileSchema).min(1).max(1_000),
    metadata: z.record(z.string().min(1).max(128), z.string().max(8_192)),
  })
  .strict()
  .superRefine((value, context) => {
    const paths = new Set<string>();
    value.files.forEach((file, index) => {
      if (paths.has(file.path)) {
        context.addIssue({
          code: "custom",
          path: ["files", index, "path"],
          message: "project snapshot paths must be unique",
        });
      }
      paths.add(file.path);
    });
    for (const required of ["package.json", "pnpm-lock.yaml"] as const) {
      if (!paths.has(required)) {
        context.addIssue({
          code: "custom",
          path: ["files"],
          message: `project snapshot must contain ${required}`,
        });
      }
    }
  });

export type ValidationStepName =
  | "install"
  | "prisma-validate"
  | "lint"
  | "typecheck"
  | "test"
  | "build"
  | "preview-start"
  | "preview-health";

export interface ValidationStepReport {
  readonly ordinal: number;
  readonly name: ValidationStepName;
  readonly command: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly result: ExecResult;
}

export interface ProjectValidationHooks {
  onSandboxCreated?(sandbox: SandboxHandle, expiresAt: string): Promise<void>;
  onFilesRestored?(sandbox: SandboxHandle): Promise<void>;
  onStep?(sandbox: SandboxHandle, step: ValidationStepReport): Promise<void>;
}

export interface ProjectValidationInput {
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
  readonly metadata: Readonly<Record<string, string>>;
  readonly hooks?: ProjectValidationHooks;
}

export interface ProjectValidationResult {
  readonly sandbox: SandboxHandle;
  readonly expiresAt: string;
  readonly previewProcessId: number;
  readonly preview: PreviewUrl;
  readonly steps: readonly ValidationStepReport[];
}

export interface ProjectValidationRunnerOptions {
  readonly provider: SandboxProvider;
  readonly template?: string;
  readonly allowedHosts?: readonly string[];
  readonly sandboxTimeoutMs?: number;
  readonly projectDirectory?: string;
  readonly previewPort?: number;
  readonly now?: () => Date;
}

export class SandboxValidationError extends Error {
  override readonly name = "SandboxValidationError";
  readonly code = "SANDBOX_VALIDATION_FAILED";
  readonly retryable = false;
  readonly step: ValidationStepName;
  readonly exitCode: number;

  constructor(step: ValidationStepName, exitCode: number) {
    super(`Sandbox validation step ${step} exited with code ${String(exitCode)}`);
    this.step = step;
    this.exitCode = exitCode;
  }
}

const validationCommands: ReadonlyArray<{
  readonly name: Exclude<ValidationStepName, "preview-start" | "preview-health">;
  readonly command: string;
  readonly timeoutMs: number;
}> = [
  {
    name: "install",
    command: "pnpm install --frozen-lockfile",
    timeoutMs: 600_000,
  },
  {
    name: "prisma-validate",
    command: "pnpm exec prisma validate",
    timeoutMs: 300_000,
  },
  { name: "lint", command: "pnpm lint", timeoutMs: 300_000 },
  { name: "typecheck", command: "pnpm typecheck", timeoutMs: 300_000 },
  { name: "test", command: "pnpm test", timeoutMs: 600_000 },
  { name: "build", command: "pnpm build", timeoutMs: 600_000 },
];

const previewStartCommand = "pnpm start --hostname 0.0.0.0 --port 3000";
const previewHealthCommand =
  "node --input-type=module -e \"for(let i=0;i<60;i++){try{const r=await fetch('http://127.0.0.1:3000');if(r.status<500)process.exit(0)}catch{}await new Promise(r=>setTimeout(r,1000))}process.exit(1)\"";

export class ProjectValidationRunner {
  readonly #provider: SandboxProvider;
  readonly #template: string | undefined;
  readonly #allowedHosts: readonly string[];
  readonly #sandboxTimeoutMs: number;
  readonly #projectDirectory: string;
  readonly #previewPort: number;
  readonly #now: () => Date;

  constructor(options: ProjectValidationRunnerOptions) {
    this.#provider = options.provider;
    this.#template = options.template;
    this.#allowedHosts = options.allowedHosts ?? [
      "registry.npmjs.org",
      "binaries.prisma.sh",
    ];
    this.#sandboxTimeoutMs = options.sandboxTimeoutMs ?? 900_000;
    this.#projectDirectory = options.projectDirectory ?? "/home/user/project";
    this.#previewPort = options.previewPort ?? 3_000;
    this.#now = options.now ?? (() => new Date());
  }

  async validate(input: ProjectValidationInput): Promise<ProjectValidationResult> {
    const parsed = ValidationInputSchema.parse({
      files: input.files,
      metadata: input.metadata,
    });
    const createdAt = this.#now();
    const expiresAt = new Date(
      createdAt.getTime() + this.#sandboxTimeoutMs,
    ).toISOString();
    const sandbox = await this.#provider.create({
      ...(this.#template === undefined ? {} : { template: this.#template }),
      timeoutMs: this.#sandboxTimeoutMs,
      metadata: parsed.metadata,
      network: {
        allowedHosts: [...this.#allowedHosts],
        allowPublicTraffic: false,
      },
      lifecycle: { onTimeout: "kill", autoResume: false },
    });
    const steps: ValidationStepReport[] = [];

    try {
      await input.hooks?.onSandboxCreated?.(sandbox, expiresAt);
      await this.#provider.writeFiles(
        sandbox.id,
        parsed.files.map((file) => ({
          path: `${this.#projectDirectory}/${file.path}`,
          content: file.content,
        })),
      );
      await input.hooks?.onFilesRestored?.(sandbox);

      for (const definition of validationCommands) {
        const step = await this.#executeStep(
          sandbox,
          steps.length + 1,
          definition.name,
          definition.command,
          definition.timeoutMs,
        );
        steps.push(step);
        await input.hooks?.onStep?.(sandbox, step);
        this.#assertSuccessful(step);
      }

      const previewStartedAt = this.#now();
      const process = await this.#provider.startProcess(sandbox.id, {
        command: previewStartCommand.replace("3000", String(this.#previewPort)),
        cwd: this.#projectDirectory,
        timeoutMs: this.#sandboxTimeoutMs,
      });
      const previewStartStep: ValidationStepReport = {
        ordinal: steps.length + 1,
        name: "preview-start",
        command: previewStartCommand.replace("3000", String(this.#previewPort)),
        startedAt: previewStartedAt.toISOString(),
        completedAt: this.#now().toISOString(),
        result: {
          exitCode: 0,
          stdout: `Background process ${String(process.pid)} started`,
          stderr: "",
          durationMs: Math.max(0, this.#now().getTime() - previewStartedAt.getTime()),
        },
      };
      steps.push(previewStartStep);
      await input.hooks?.onStep?.(sandbox, previewStartStep);

      const healthCommand = previewHealthCommand.replaceAll(
        "3000",
        String(this.#previewPort),
      );
      const healthStep = await this.#executeStep(
        sandbox,
        steps.length + 1,
        "preview-health",
        healthCommand,
        70_000,
      );
      steps.push(healthStep);
      await input.hooks?.onStep?.(sandbox, healthStep);
      this.#assertSuccessful(healthStep);

      const preview = await this.#provider.exposePort(
        sandbox.id,
        this.#previewPort,
      );
      return {
        sandbox,
        expiresAt,
        previewProcessId: process.pid,
        preview,
        steps,
      };
    } catch (error) {
      await this.#provider.terminate(sandbox.id).catch(() => undefined);
      throw error;
    }
  }

  terminate(sandboxId: string): Promise<void> {
    return this.#provider.terminate(sandboxId);
  }

  async #executeStep(
    sandbox: SandboxHandle,
    ordinal: number,
    name: ValidationStepName,
    command: string,
    timeoutMs: number,
  ): Promise<ValidationStepReport> {
    const startedAt = this.#now();
    const result = await this.#provider.exec(sandbox.id, {
      command,
      cwd: this.#projectDirectory,
      timeoutMs,
    });
    return {
      ordinal,
      name,
      command,
      startedAt: startedAt.toISOString(),
      completedAt: this.#now().toISOString(),
      result,
    };
  }

  #assertSuccessful(step: ValidationStepReport): void {
    if (step.result.exitCode !== 0) {
      throw new SandboxValidationError(step.name, step.result.exitCode);
    }
  }
}
