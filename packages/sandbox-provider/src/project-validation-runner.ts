import { z } from "zod";

import {
  ACCEPTANCE_MANIFEST_PATH,
  ACCEPTANCE_SCRIPT,
  ACCEPTANCE_SCRIPT_PATH,
  AcceptanceManifestSchema,
  type AcceptanceManifest,
} from "./acceptance-script.js";
import {
  LOCAL_DATABASE_BIN_DIRECTORY,
  LOCAL_DATABASE_DATA_DIRECTORY,
  LOCAL_DATABASE_LOG_PATH,
  LOCAL_DATABASE_PORT,
  LOCAL_DATABASE_URL,
} from "./local-database-template.js";
import {
  DEFAULT_PLAYWRIGHT_BROWSERS_PATH,
  DEFAULT_PLAYWRIGHT_ENTRY,
  PREVIEW_VIABILITY_SCRIPT,
  PREVIEW_VIABILITY_SCRIPT_PATH,
} from "./preview-viability-script.js";

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
  | "preview-health"
  | "db-start"
  | "db-migrate"
  | "db-seed"
  | "acceptance";

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
  /**
   * G3 (docs/adr/production-execution-gate.md): when set and the runner was
   * constructed with `acceptanceCheck`, an "acceptance" step runs after a
   * passing preview-health and records per-scenario pass/fail evidence. Never
   * gates run success -- see the step's own comment in `validate()`.
   */
  readonly acceptanceManifest?: AcceptanceManifest | null;
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
  /**
   * When set, the preview-health step also loads the preview in a real browser
   * inside the sandbox (see preview-viability-script.ts). Off by default because
   * it needs Playwright and Chromium in the sandbox template.
   */
  readonly browserViability?: {
    readonly playwrightEntry?: string;
    readonly browsersPath?: string;
  };
  /**
   * When set, a passing preview-health is followed by the G3 acceptance step
   * (see acceptance-script.ts). Off by default, and needs the same
   * Playwright/Chromium template as `browserViability`. Whether the step
   * actually runs also depends on a per-call `acceptanceManifest` being
   * supplied to `validate()` -- both must be present.
   */
  readonly acceptanceCheck?: {
    readonly playwrightEntry?: string;
    readonly browsersPath?: string;
  };
  /**
   * When true and a build's template carries the local database (see
   * local-database-template.ts), a passing build is followed by db-start,
   * db-migrate (`prisma migrate deploy`) and db-seed (`pnpm run seed`, only if
   * the generated package.json defines one) before preview-start, so the
   * delivered preview -- and the G3 acceptance scenarios that need real
   * sign-in -- have a live, ephemeral database to run against. None of these
   * three steps ever blocks the run: a missing or failing seed script simply
   * means those steps report failure and whatever preview-health or
   * acceptance scenarios depend on data will fail as evidence, same as any
   * other unmet precondition.
   */
  readonly provisionLocalDatabase?: boolean;
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
  readonly #browserPlaywrightEntry: string | undefined;
  readonly #browserBrowsersPath: string;
  readonly #acceptancePlaywrightEntry: string | undefined;
  readonly #acceptanceBrowsersPath: string;
  readonly #provisionLocalDatabase: boolean;
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
    this.#browserPlaywrightEntry =
      options.browserViability === undefined
        ? undefined
        : (options.browserViability.playwrightEntry ?? DEFAULT_PLAYWRIGHT_ENTRY);
    this.#browserBrowsersPath =
      options.browserViability?.browsersPath ?? DEFAULT_PLAYWRIGHT_BROWSERS_PATH;
    this.#acceptancePlaywrightEntry =
      options.acceptanceCheck === undefined
        ? undefined
        : (options.acceptanceCheck.playwrightEntry ?? DEFAULT_PLAYWRIGHT_ENTRY);
    this.#acceptanceBrowsersPath =
      options.acceptanceCheck?.browsersPath ?? DEFAULT_PLAYWRIGHT_BROWSERS_PATH;
    this.#provisionLocalDatabase = options.provisionLocalDatabase ?? false;
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
    // Parsed eagerly, before any sandbox spend, since a bad manifest is an
    // operator configuration error, not something to discover mid-run.
    const acceptanceManifest =
      input.acceptanceManifest === undefined || input.acceptanceManifest === null
        ? null
        : AcceptanceManifestSchema.parse(input.acceptanceManifest);
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

      let databaseReady = false;
      if (this.#provisionLocalDatabase) {
        databaseReady = await this.#provisionDatabase(sandbox, steps, input);
      }

      const previewStartedAt = this.#now();
      const process = await this.#provider.startProcess(sandbox.id, {
        command: previewStartCommand.replace("3000", String(this.#previewPort)),
        cwd: this.#projectDirectory,
        timeoutMs: this.#sandboxTimeoutMs,
        ...(databaseReady ? { envs: { DATABASE_URL: LOCAL_DATABASE_URL } } : {}),
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

      let healthStep: ValidationStepReport;
      if (this.#browserPlaywrightEntry === undefined) {
        healthStep = await this.#executeStep(
          sandbox,
          steps.length + 1,
          "preview-health",
          previewHealthCommand.replaceAll("3000", String(this.#previewPort)),
          70_000,
        );
      } else {
        await this.#provider.writeFiles(sandbox.id, [
          { path: PREVIEW_VIABILITY_SCRIPT_PATH, content: PREVIEW_VIABILITY_SCRIPT },
        ]);
        healthStep = await this.#executeStep(
          sandbox,
          steps.length + 1,
          "preview-health",
          `node ${PREVIEW_VIABILITY_SCRIPT_PATH}`,
          150_000,
          {
            VIABILITY_PORT: String(this.#previewPort),
            VIABILITY_PLAYWRIGHT_ENTRY: this.#browserPlaywrightEntry,
            PLAYWRIGHT_BROWSERS_PATH: this.#browserBrowsersPath,
          },
        );
      }
      steps.push(healthStep);
      await input.hooks?.onStep?.(sandbox, healthStep);
      this.#assertSuccessful(healthStep);

      if (this.#acceptancePlaywrightEntry !== undefined && acceptanceManifest !== null) {
        // G3: evidence for the release assessment, never a reason to withhold
        // the preview. A failing or crashing scenario is a normal outcome
        // here, so this step is deliberately never passed to
        // #assertSuccessful, and #runAcceptanceCheck itself never throws.
        const acceptanceStep = await this.#runAcceptanceCheck(
          sandbox,
          steps.length + 1,
          acceptanceManifest,
        );
        steps.push(acceptanceStep);
        await input.hooks?.onStep?.(sandbox, acceptanceStep);
      }

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
    envs?: Record<string, string>,
  ): Promise<ValidationStepReport> {
    const startedAt = this.#now();
    const result = await this.#provider.exec(sandbox.id, {
      command,
      cwd: this.#projectDirectory,
      timeoutMs,
      ...(envs === undefined ? {} : { envs }),
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

  /**
   * Unlike #executeStep, this never rejects: any error `run` throws is caught
   * and reported as an ERROR-shaped step, so it can never abort validation or
   * withhold a preview over an optional, informational step.
   */
  async #tryStep(
    ordinal: number,
    name: ValidationStepName,
    command: string,
    run: () => Promise<ExecResult>,
  ): Promise<ValidationStepReport> {
    const startedAt = this.#now();
    try {
      const result = await run();
      return {
        ordinal, name, command,
        startedAt: startedAt.toISOString(), completedAt: this.#now().toISOString(),
        result,
      };
    } catch (error) {
      const completedAt = this.#now();
      return {
        ordinal, name, command,
        startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(),
        result: {
          exitCode: 1, stdout: "", stderr: "",
          durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async #runAcceptanceCheck(
    sandbox: SandboxHandle,
    ordinal: number,
    manifest: AcceptanceManifest,
  ): Promise<ValidationStepReport> {
    const command = `node ${ACCEPTANCE_SCRIPT_PATH}`;
    return this.#tryStep(ordinal, "acceptance", command, async () => {
      await this.#provider.writeFiles(sandbox.id, [
        { path: ACCEPTANCE_SCRIPT_PATH, content: ACCEPTANCE_SCRIPT },
        { path: ACCEPTANCE_MANIFEST_PATH, content: JSON.stringify(manifest) },
      ]);
      return this.#provider.exec(sandbox.id, {
        command,
        cwd: this.#projectDirectory,
        timeoutMs: 120_000,
        envs: {
          ACCEPTANCE_PORT: String(this.#previewPort),
          ACCEPTANCE_PLAYWRIGHT_ENTRY: this.#acceptancePlaywrightEntry ?? "",
          ACCEPTANCE_MANIFEST_PATH,
          PLAYWRIGHT_BROWSERS_PATH: this.#acceptanceBrowsersPath,
        },
      });
    });
  }

  /**
   * G3 / issue #130: brings up the local database baked into the template
   * (local-database-template.ts) and applies David's migrations and seed
   * data, so AUTH_FLOW acceptance scenarios and the delivered preview itself
   * have something real to read and write. Returns whether DATABASE_URL
   * should be handed to preview-start: true only once both db-start and
   * db-migrate succeed. A missing or failing seed script does not change the
   * answer -- the database is still usable, only fixture-dependent scenarios
   * are affected, and that shows up as their own evidence, not as a blocked
   * run.
   */
  async #provisionDatabase(
    sandbox: SandboxHandle,
    steps: ValidationStepReport[],
    input: ProjectValidationInput,
  ): Promise<boolean> {
    const startCommand =
      `${LOCAL_DATABASE_BIN_DIRECTORY}/pg_ctl -D ${LOCAL_DATABASE_DATA_DIRECTORY} ` +
      `-o '-p ${String(LOCAL_DATABASE_PORT)} -k /tmp' -l ${LOCAL_DATABASE_LOG_PATH} -w start`;
    const startStep = await this.#tryStep(steps.length + 1, "db-start", startCommand, () =>
      this.#provider.exec(sandbox.id, { command: startCommand, timeoutMs: 30_000 }));
    steps.push(startStep);
    await input.hooks?.onStep?.(sandbox, startStep);
    if (startStep.result.exitCode !== 0) return false;

    const migrateCommand = "pnpm exec prisma migrate deploy";
    const migrateStep = await this.#tryStep(steps.length + 1, "db-migrate", migrateCommand, () =>
      this.#provider.exec(sandbox.id, {
        command: migrateCommand,
        cwd: this.#projectDirectory,
        timeoutMs: 120_000,
        envs: { DATABASE_URL: LOCAL_DATABASE_URL },
      }));
    steps.push(migrateStep);
    await input.hooks?.onStep?.(sandbox, migrateStep);
    if (migrateStep.result.exitCode !== 0) return false;

    const seedCommand = "pnpm run seed";
    const seedStep = await this.#tryStep(steps.length + 1, "db-seed", seedCommand, () =>
      this.#provider.exec(sandbox.id, {
        command: seedCommand,
        cwd: this.#projectDirectory,
        timeoutMs: 60_000,
        envs: { DATABASE_URL: LOCAL_DATABASE_URL },
      }));
    steps.push(seedStep);
    await input.hooks?.onStep?.(sandbox, seedStep);
    return true;
  }

  #assertSuccessful(step: ValidationStepReport): void {
    if (step.result.exitCode !== 0) {
      throw new SandboxValidationError(step.name, step.result.exitCode);
    }
  }
}
