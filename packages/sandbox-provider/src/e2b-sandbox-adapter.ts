import {
  CommandExitError,
  Sandbox,
  SandboxNotFoundError,
  type CommandHandle,
  type SandboxOpts,
} from "@e2b/code-interpreter";
import { z } from "zod";

import { normalizeE2BError, SandboxProviderError } from "./errors.js";
import {
  ExecCommandSchema,
  SandboxFileInputSchema,
  SandboxSpecSchema,
  type BackgroundProcess,
  type ExecCommand,
  type ExecResult,
  type PreviewUrl,
  type SandboxFileInput,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxSpec,
} from "./types.js";

const SandboxIdSchema = z.string().trim().min(1).max(191);
const PortSchema = z.number().int().min(1).max(65_535);
const FilesSchema = z.array(SandboxFileInputSchema).min(1).max(1_000);

export type E2BSandboxClient = Pick<
  Sandbox,
  | "commands"
  | "files"
  | "getHost"
  | "kill"
  | "sandboxId"
  | "trafficAccessToken"
>;

interface E2BConnectionOptions {
  readonly apiKey?: string;
  readonly requestTimeoutMs?: number;
}

interface E2BCreateOptions extends E2BConnectionOptions {
  readonly template?: string;
  readonly timeoutMs?: number;
  readonly metadata?: Record<string, string>;
  readonly envs?: Record<string, string>;
  readonly allowInternetAccess?: boolean;
  readonly network?: {
    readonly allowedHosts: readonly string[];
    readonly allowPublicTraffic: boolean;
  };
  readonly lifecycle: {
    readonly onTimeout: "kill" | "pause";
    readonly autoResume: boolean;
  };
}

export interface E2BSandboxFactory {
  create(options: E2BCreateOptions): Promise<E2BSandboxClient>;
  connect(
    sandboxId: string,
    options: E2BConnectionOptions,
  ): Promise<E2BSandboxClient>;
}

export interface E2BSandboxAdapterOptions extends E2BConnectionOptions {
  readonly factory?: E2BSandboxFactory;
  readonly now?: () => Date;
}

const defaultFactory: E2BSandboxFactory = {
  async create(options) {
    const sdkOptions: SandboxOpts = {
      secure: true,
      lifecycle: options.lifecycle,
      ...(options.allowInternetAccess === undefined
        ? {}
        : { allowInternetAccess: options.allowInternetAccess }),
      ...(options.network === undefined
        ? {}
        : {
            network: {
              allowOut: [...options.network.allowedHosts],
              allowPublicTraffic: options.network.allowPublicTraffic,
            },
          }),
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(options.metadata === undefined
        ? {}
        : { metadata: options.metadata }),
      ...(options.envs === undefined ? {} : { envs: options.envs }),
    };

    return options.template === undefined
      ? Sandbox.create(sdkOptions)
      : Sandbox.create(options.template, sdkOptions);
  },
  connect(sandboxId, options) {
    return Sandbox.connect(sandboxId, {
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
    });
  },
};

export class E2BSandboxAdapter implements SandboxProvider {
  readonly #apiKey: string | undefined;
  readonly #requestTimeoutMs: number | undefined;
  readonly #factory: E2BSandboxFactory;
  readonly #now: () => Date;
  readonly #sandboxes = new Map<string, E2BSandboxClient>();

  constructor(options: E2BSandboxAdapterOptions = {}) {
    this.#apiKey = options.apiKey;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#factory = options.factory ?? defaultFactory;
    this.#now = options.now ?? (() => new Date());
  }

  async create(input: SandboxSpec): Promise<SandboxHandle> {
    try {
      const spec = SandboxSpecSchema.parse(input);
      const network =
        spec.network === undefined
          ? spec.allowInternetAccess === true
            ? undefined
            : { allowedHosts: [], allowPublicTraffic: false }
          : spec.network;
      const sandbox = await this.#factory.create({
        lifecycle: spec.lifecycle ?? { onTimeout: "kill", autoResume: false },
        ...(spec.allowInternetAccess === undefined
          ? {}
          : { allowInternetAccess: spec.allowInternetAccess }),
        ...(network === undefined ? {} : { network }),
        ...(this.#apiKey === undefined ? {} : { apiKey: this.#apiKey }),
        ...(this.#requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: this.#requestTimeoutMs }),
        ...(spec.template === undefined ? {} : { template: spec.template }),
        ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
        ...(spec.metadata === undefined ? {} : { metadata: spec.metadata }),
        ...(spec.envs === undefined ? {} : { envs: spec.envs }),
      });
      this.#sandboxes.set(sandbox.sandboxId, sandbox);

      return {
        id: sandbox.sandboxId,
        provider: "e2b",
        createdAt: this.#now().toISOString(),
      };
    } catch (error) {
      throw normalizeE2BError(error, "create");
    }
  }

  async writeFiles(
    id: string,
    files: readonly SandboxFileInput[],
  ): Promise<void> {
    const sandboxId = this.#parseSandboxId(id, "writeFiles");

    try {
      const parsedFiles = FilesSchema.parse(files);
      const sandbox = await this.#getSandbox(sandboxId);
      await sandbox.files.write(
        parsedFiles.map((file) => ({
          path: file.path,
          data: file.content,
        })),
        this.#requestOptions(),
      );
    } catch (error) {
      throw normalizeE2BError(error, "writeFiles", sandboxId);
    }
  }

  async exec(id: string, command: ExecCommand): Promise<ExecResult> {
    const sandboxId = this.#parseSandboxId(id, "exec");
    const startedAt = performance.now();

    try {
      const parsedCommand = ExecCommandSchema.parse(command);
      const sandbox = await this.#getSandbox(sandboxId);
      const result = await sandbox.commands.run(parsedCommand.command, {
        background: false,
        ...(parsedCommand.cwd === undefined
          ? {}
          : { cwd: parsedCommand.cwd }),
        ...(parsedCommand.envs === undefined
          ? {}
          : { envs: parsedCommand.envs }),
        ...(parsedCommand.timeoutMs === undefined
          ? {}
          : { timeoutMs: parsedCommand.timeoutMs }),
        ...this.#requestOptions(),
      });

      return this.#mapCommandResult(result, performance.now() - startedAt);
    } catch (error) {
      if (error instanceof CommandExitError) {
        return this.#mapCommandResult(error, performance.now() - startedAt);
      }
      throw normalizeE2BError(error, "exec", sandboxId);
    }
  }

  async startProcess(
    id: string,
    command: ExecCommand,
  ): Promise<BackgroundProcess> {
    const sandboxId = this.#parseSandboxId(id, "startProcess");

    try {
      const parsedCommand = ExecCommandSchema.parse(command);
      const sandbox = await this.#getSandbox(sandboxId);
      const process = (await sandbox.commands.run(parsedCommand.command, {
        background: true,
        ...(parsedCommand.cwd === undefined
          ? {}
          : { cwd: parsedCommand.cwd }),
        ...(parsedCommand.envs === undefined
          ? {}
          : { envs: parsedCommand.envs }),
        ...(parsedCommand.timeoutMs === undefined
          ? {}
          : { timeoutMs: parsedCommand.timeoutMs }),
        ...this.#requestOptions(),
      })) as CommandHandle;
      return { pid: process.pid };
    } catch (error) {
      throw normalizeE2BError(error, "startProcess", sandboxId);
    }
  }

  async exposePort(id: string, port: number): Promise<PreviewUrl> {
    const sandboxId = this.#parseSandboxId(id, "exposePort");

    try {
      const parsedPort = PortSchema.parse(port);
      const sandbox = await this.#getSandbox(sandboxId);
      const host = sandbox.getHost(parsedPort);
      const protocol =
        host.startsWith("localhost:") || host.startsWith("127.0.0.1:")
          ? "http"
          : "https";

      return {
        port: parsedPort,
        url: host.startsWith("http://") || host.startsWith("https://")
          ? host
          : `${protocol}://${host}`,
        ...(sandbox.trafficAccessToken === undefined
          ? {}
          : {
              requestHeaders: {
                "E2B-Traffic-Access-Token": sandbox.trafficAccessToken,
              },
            }),
      };
    } catch (error) {
      throw normalizeE2BError(error, "exposePort", sandboxId);
    }
  }

  async terminate(id: string): Promise<void> {
    const sandboxId = this.#parseSandboxId(id, "terminate");

    try {
      const sandbox = await this.#getSandbox(sandboxId);
      await sandbox.kill(this.#requestOptions());
    } catch (error) {
      const alreadyTerminated =
        error instanceof SandboxNotFoundError ||
        (error instanceof SandboxProviderError && error.code === "NOT_FOUND");
      if (!alreadyTerminated) {
        throw normalizeE2BError(error, "terminate", sandboxId);
      }
    } finally {
      this.#sandboxes.delete(sandboxId);
    }
  }

  #parseSandboxId(
    id: string,
    operation:
      | "exec"
      | "exposePort"
      | "startProcess"
      | "terminate"
      | "writeFiles",
  ): string {
    try {
      return SandboxIdSchema.parse(id);
    } catch (error) {
      throw normalizeE2BError(error, operation, id);
    }
  }

  async #getSandbox(sandboxId: string): Promise<E2BSandboxClient> {
    const existing = this.#sandboxes.get(sandboxId);
    if (existing !== undefined) {
      return existing;
    }

    try {
      const sandbox = await this.#factory.connect(sandboxId, {
        ...(this.#apiKey === undefined ? {} : { apiKey: this.#apiKey }),
        ...(this.#requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: this.#requestTimeoutMs }),
      });
      this.#sandboxes.set(sandboxId, sandbox);
      return sandbox;
    } catch (error) {
      throw normalizeE2BError(error, "connect", sandboxId);
    }
  }

  #requestOptions(): { requestTimeoutMs?: number } {
    return this.#requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: this.#requestTimeoutMs };
  }

  #mapCommandResult(
    result: {
      readonly error?: string | undefined;
      readonly exitCode: number;
      readonly stderr: string;
      readonly stdout: string;
    },
    durationMs: number,
  ): ExecResult {
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Math.max(0, Math.round(durationMs)),
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  }
}
