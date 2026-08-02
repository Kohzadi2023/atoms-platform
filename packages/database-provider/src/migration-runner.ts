import { isIP } from "node:net";

import {
  type ExecResult,
  type SandboxHandle,
  type SandboxProvider,
} from "@atoms/sandbox-provider";
import { z } from "zod";

import { DatabaseMigrationError } from "./errors.js";

const MigrationInputSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            path: z
              .string()
              .trim()
              .min(1)
              .max(1_024)
              .refine((value) => !value.startsWith("/"))
              .refine((value) => !value.includes("\\"))
              .refine((value) => !value.split("/").includes("..")),
            content: z.string().max(5_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(1_000),
    connectionUrl: z.string().url(),
    metadata: z.record(z.string().min(1).max(128), z.string().max(8_192)),
  })
  .strict()
  .superRefine((value, context) => {
    const paths = new Set(value.files.map((file) => file.path));
    for (const required of ["package.json", "pnpm-lock.yaml"] as const) {
      if (!paths.has(required)) {
        context.addIssue({
          code: "custom",
          path: ["files"],
          message: `migration snapshot must contain ${required}`,
        });
      }
    }
    if (![...paths].some((path) => /(^|\/)schema\.prisma$/.test(path))) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "migration snapshot must contain schema.prisma",
      });
    }
    if (![...paths].some((path) => /^prisma\/migrations\/.+\/migration\.sql$/.test(path))) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "migration snapshot must contain a forward migration",
      });
    }
  });

export type DatabaseMigrationStepName =
  | "install"
  | "migrate"
  | "seed"
  | "connectivity";

export interface DatabaseMigrationStepReport {
  readonly ordinal: number;
  readonly name: DatabaseMigrationStepName;
  readonly command: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly result: ExecResult;
}

export interface DatabaseMigrationInput {
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
  readonly connectionUrl: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly onStep?: (step: DatabaseMigrationStepReport) => Promise<void>;
}

export interface DatabaseMigrationResult {
  readonly steps: readonly DatabaseMigrationStepReport[];
}

export interface DatabaseMigrationRunner {
  migrate(input: DatabaseMigrationInput): Promise<DatabaseMigrationResult>;
}

export interface E2BDatabaseMigrationRunnerOptions {
  readonly provider: SandboxProvider;
  readonly template?: string;
  readonly packageHosts?: readonly string[];
  readonly allowedDatabaseHostSuffixes?: readonly string[];
  readonly sandboxTimeoutMs?: number;
  readonly projectDirectory?: string;
  readonly now?: () => Date;
}

const commandDefinitions: ReadonlyArray<{
  readonly name: DatabaseMigrationStepName;
  readonly command: string;
  readonly timeoutMs: number;
}> = [
  {
    name: "install",
    command: "pnpm install --frozen-lockfile",
    timeoutMs: 600_000,
  },
  {
    name: "migrate",
    command: "pnpm exec prisma migrate deploy",
    timeoutMs: 600_000,
  },
  {
    name: "seed",
    command: "pnpm exec prisma db seed",
    timeoutMs: 300_000,
  },
  {
    name: "connectivity",
    command: "pnpm exec prisma migrate status",
    timeoutMs: 300_000,
  },
];

/** Runs migration and seed commands in a disposable, egress-limited E2B VM. */
export class E2BDatabaseMigrationRunner implements DatabaseMigrationRunner {
  readonly #provider: SandboxProvider;
  readonly #template: string | undefined;
  readonly #packageHosts: readonly string[];
  readonly #allowedDatabaseHostSuffixes: readonly string[];
  readonly #sandboxTimeoutMs: number;
  readonly #projectDirectory: string;
  readonly #now: () => Date;

  constructor(options: E2BDatabaseMigrationRunnerOptions) {
    this.#provider = options.provider;
    this.#template = options.template;
    this.#packageHosts = options.packageHosts ?? [
      "registry.npmjs.org",
      "binaries.prisma.sh",
    ];
    this.#allowedDatabaseHostSuffixes =
      options.allowedDatabaseHostSuffixes ?? [".supabase.co"];
    this.#sandboxTimeoutMs = options.sandboxTimeoutMs ?? 900_000;
    this.#projectDirectory = options.projectDirectory ?? "/home/user/project";
    this.#now = options.now ?? (() => new Date());
  }

  async migrate(input: DatabaseMigrationInput): Promise<DatabaseMigrationResult> {
    const parsed = MigrationInputSchema.parse({
      files: input.files,
      connectionUrl: input.connectionUrl,
      metadata: input.metadata,
    });
    const databaseHost = assertAllowedDatabaseHost(
      parsed.connectionUrl,
      this.#allowedDatabaseHostSuffixes,
    );
    let sandbox: SandboxHandle | undefined;
    const steps: DatabaseMigrationStepReport[] = [];

    try {
      sandbox = await this.#provider.create({
        ...(this.#template === undefined ? {} : { template: this.#template }),
        timeoutMs: this.#sandboxTimeoutMs,
        metadata: parsed.metadata,
        envs: { DATABASE_URL: parsed.connectionUrl },
        network: {
          allowedHosts: [...this.#packageHosts, databaseHost],
          allowPublicTraffic: false,
        },
        lifecycle: { onTimeout: "kill", autoResume: false },
      });
      await this.#provider.writeFiles(
        sandbox.id,
        parsed.files.map((file) => ({
          path: `${this.#projectDirectory}/${file.path}`,
          content: file.content,
        })),
      );

      for (const definition of commandDefinitions) {
        const startedAt = this.#now();
        const rawResult = await this.#provider.exec(sandbox.id, {
          command: definition.command,
          cwd: this.#projectDirectory,
          timeoutMs: definition.timeoutMs,
        });
        const step: DatabaseMigrationStepReport = {
          ordinal: steps.length + 1,
          name: definition.name,
          command: definition.command,
          startedAt: startedAt.toISOString(),
          completedAt: this.#now().toISOString(),
          result: redactExecResult(rawResult, parsed.connectionUrl),
        };
        steps.push(step);
        await input.onStep?.(step);
        if (step.result.exitCode !== 0) {
          throw new DatabaseMigrationError(step.name, step.result.exitCode);
        }
      }
      return { steps };
    } finally {
      if (sandbox !== undefined) {
        await this.#provider.terminate(sandbox.id).catch(() => undefined);
      }
    }
  }
}

export function redactDiagnostic(value: string, secrets: readonly string[]): string {
  let redacted = value.replace(
    /postgres(?:ql)?:\/\/[^\s"'<>]+/giu,
    "[REDACTED_DATABASE_URL]",
  );
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted;
}

function redactExecResult(result: ExecResult, connectionUrl: string): ExecResult {
  const password = new URL(connectionUrl).password;
  const secrets = [connectionUrl, password, decodeURIComponent(password)];
  return {
    ...result,
    stdout: redactDiagnostic(result.stdout, secrets),
    stderr: redactDiagnostic(result.stderr, secrets),
    ...(result.error === undefined
      ? {}
      : { error: redactDiagnostic(result.error, secrets) }),
  };
}

function assertAllowedDatabaseHost(
  connectionUrl: string,
  allowedSuffixes: readonly string[],
): string {
  const parsed = new URL(connectionUrl);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new TypeError("Generated database connection must use PostgreSQL");
  }
  const host = parsed.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal" ||
    isIP(host) !== 0;
  const allowed = allowedSuffixes.some(
    (suffix) => host.endsWith(suffix) && host.length > suffix.length,
  );
  if (blocked || !allowed) {
    throw new TypeError("Generated database host is outside the approved egress policy");
  }
  return host;
}
