import { z } from "zod";

const StringRecordSchema = z.record(
  z.string().min(1).max(128),
  z.string().max(8_192),
);

const NetworkHostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^(?:\*\.)?(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/,
    "must be a hostname or wildcard hostname",
  );

export const SandboxNetworkPolicySchema = z
  .object({
    allowedHosts: z.array(NetworkHostSchema).max(100),
    allowPublicTraffic: z.boolean().default(false),
  })
  .strict();

export type SandboxNetworkPolicy = z.infer<
  typeof SandboxNetworkPolicySchema
>;

export const SandboxLifecyclePolicySchema = z
  .object({
    onTimeout: z.enum(["kill", "pause"]).default("kill"),
    autoResume: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.onTimeout === "kill" && value.autoResume) {
      context.addIssue({
        code: "custom",
        path: ["autoResume"],
        message: "autoResume requires onTimeout=pause",
      });
    }
  });

export type SandboxLifecyclePolicy = z.infer<
  typeof SandboxLifecyclePolicySchema
>;

export const SandboxSpecSchema = z
  .object({
    template: z.string().trim().min(1).max(191).optional(),
    timeoutMs: z.number().int().min(10_000).max(86_400_000).optional(),
    metadata: StringRecordSchema.optional(),
    envs: StringRecordSchema.optional(),
    network: SandboxNetworkPolicySchema.optional(),
    lifecycle: SandboxLifecyclePolicySchema.optional(),
    /** @deprecated Prefer an explicit network.allowedHosts policy. */
    allowInternetAccess: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.network !== undefined && value.allowInternetAccess !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["allowInternetAccess"],
        message: "allowInternetAccess cannot be combined with network",
      });
    }
  });

export type SandboxSpec = z.infer<typeof SandboxSpecSchema>;

export interface SandboxHandle {
  readonly id: string;
  readonly provider: "e2b";
  readonly createdAt: string;
}

export const SandboxFileInputSchema = z
  .object({
    path: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .refine((value) => !value.includes("\\"), {
        message: "path must use POSIX separators",
      })
      .refine((value) => !value.split("/").includes(".."), {
        message: "path must not traverse outside the sandbox workspace",
      }),
    content: z.string().max(5_000_000),
  })
  .strict();

export type SandboxFileInput = z.infer<typeof SandboxFileInputSchema>;

export const ExecCommandSchema = z
  .object({
    command: z.string().trim().min(1).max(32_768),
    cwd: z.string().trim().min(1).max(4_096).optional(),
    envs: StringRecordSchema.optional(),
    timeoutMs: z.number().int().min(1).max(3_600_000).optional(),
  })
  .strict();

export type ExecCommand = z.infer<typeof ExecCommandSchema>;

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly error?: string;
}

export interface PreviewUrl {
  readonly port: number;
  readonly url: string;
  /** Server-to-server headers. They must never be sent to a browser or event log. */
  readonly requestHeaders?: Readonly<Record<string, string>>;
}

export interface BackgroundProcess {
  readonly pid: number;
}

export interface SandboxProvider {
  create(input: SandboxSpec): Promise<SandboxHandle>;
  writeFiles(id: string, files: readonly SandboxFileInput[]): Promise<void>;
  exec(id: string, command: ExecCommand): Promise<ExecResult>;
  startProcess(id: string, command: ExecCommand): Promise<BackgroundProcess>;
  exposePort(id: string, port: number): Promise<PreviewUrl>;
  terminate(id: string): Promise<void>;
}
