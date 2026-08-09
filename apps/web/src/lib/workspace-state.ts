import {
  DatabaseStatusChangedEventPayloadV1Schema,
  PreviewUpdatedEventPayloadV1Schema,
  RunAgentNameSchema,
  SandboxValidationProgressEventPayloadV1Schema,
  normalizeApprovalRequiredEventPayload,
  type ApprovalScope,
  type AgentRunStatus,
  type JsonValue,
  type RunAction,
  type RunEventEnvelope,
} from "@atoms/contracts";

export const AGENT_ORDER = RunAgentNameSchema.options;
export type AgentName = (typeof AGENT_ORDER)[number];
export type TaskStatus =
  | "idle"
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed";

export interface AgentTaskProjection {
  readonly id?: string;
  readonly agent: AgentName;
  readonly ordinal?: number;
  readonly description?: string;
  readonly status: TaskStatus;
  readonly attempt?: number;
}

export interface ValidationProjection {
  readonly step: string;
  readonly status: "SUCCEEDED" | "FAILED";
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PreviewProjection {
  readonly status: "READY" | "STOPPED" | "EXPIRED" | "ERROR";
  readonly url?: string;
  readonly expiresAt: string;
}

export interface DatabaseProjection {
  readonly databaseInstanceId: string;
  readonly operationVersion: number;
  readonly status: string;
  readonly message?: string;
}

export interface WorkspaceProjection {
  readonly events: readonly RunEventEnvelope[];
  readonly tasks: Readonly<Record<AgentName, AgentTaskProjection>>;
  readonly activeAgent: AgentName | undefined;
  readonly approvalReason: string | undefined;
  readonly approvalScope: ApprovalScope | undefined;
  readonly preview: PreviewProjection | undefined;
  readonly validations: readonly ValidationProjection[];
  readonly generatedPaths: readonly string[];
  readonly database: DatabaseProjection | undefined;
  readonly inferredRunStatus: AgentRunStatus | undefined;
  readonly error: string | undefined;
}

export function createWorkspaceProjection(): WorkspaceProjection {
  return {
    events: [],
    tasks: Object.fromEntries(
      AGENT_ORDER.map((agent) => [agent, { agent, status: "idle" }]),
    ) as Record<AgentName, AgentTaskProjection>,
    activeAgent: undefined,
    approvalReason: undefined,
    approvalScope: undefined,
    preview: undefined,
    validations: [],
    generatedPaths: [],
    database: undefined,
    inferredRunStatus: undefined,
    error: undefined,
  };
}

export function reduceRunEvent(
  current: WorkspaceProjection,
  event: RunEventEnvelope,
): WorkspaceProjection {
  if (current.events.some((item) => item.sequence === event.sequence)) {
    return current;
  }

  const payload = asRecord(event.payload);
  let next: WorkspaceProjection = {
    ...current,
    events: [...current.events, event]
      .sort((left, right) => left.sequence - right.sequence)
      .slice(-500),
  };

  if (event.eventType === "task.created") {
    const agent = readAgent(payload.agent);
    if (agent !== undefined) {
      const id = readString(payload.taskId);
      const ordinal = readNumber(payload.ordinal);
      const description = readString(payload.description);
      next = updateTask(next, agent, {
        status: "queued",
        ...(id === undefined ? {} : { id }),
        ...(ordinal === undefined ? {} : { ordinal }),
        ...(description === undefined ? {} : { description }),
      });
    }
  }

  if (event.eventType === "task.started" || event.eventType === "task_started") {
    const agent = readAgent(payload.agent);
    if (agent !== undefined) {
      const id = readString(payload.taskId);
      const ordinal = readNumber(payload.ordinal);
      const attempt = readNumber(payload.attempt);
      next = {
        ...updateTask(next, agent, {
          status: "running",
          ...(id === undefined ? {} : { id }),
          ...(ordinal === undefined ? {} : { ordinal }),
          ...(attempt === undefined ? {} : { attempt }),
        }),
        activeAgent: agent,
      };
    }
  }

  if (event.eventType === "task.completed") {
    const agent = readAgent(payload.agent);
    if (agent !== undefined) {
      const id = readString(payload.taskId);
      const ordinal = readNumber(payload.ordinal);
      const attempt = readNumber(payload.attempt);
      const updated = updateTask(next, agent, {
        status: "completed",
        ...(id === undefined ? {} : { id }),
        ...(ordinal === undefined ? {} : { ordinal }),
        ...(attempt === undefined ? {} : { attempt }),
      });
      next = {
        ...updated,
        ...(updated.activeAgent === agent ? { activeAgent: undefined } : {}),
      };
    }
  }

  if (event.eventType === "task.failed") {
    const agent = readAgent(payload.agent);
    if (agent !== undefined) {
      next = {
        ...updateTask(next, agent, { status: "failed" }),
        activeAgent: undefined,
        error: readError(payload.error) ?? `${agent} failed`,
      };
    }
  }

  if (event.eventType === "approval.required" || event.eventType === "approval_required") {
    const agent = next.activeAgent;
    const approval = readApproval(event.payload);
    next = {
      ...next,
      approvalReason:
        approval?.reason ??
        readString(payload.reason) ??
        "Approval is required before the run can continue.",
      approvalScope: approval?.scope,
      inferredRunStatus: "PAUSED",
      ...(agent === undefined
        ? {}
        : { tasks: updateTask(next, agent, { status: "waiting" }).tasks }),
    };
  }

  if (event.eventType === "run.status_changed") {
    const status = readRunStatus(payload.to);
    if (status !== undefined) {
      next = {
        ...next,
        inferredRunStatus: status,
        ...(status !== "PAUSED"
          ? { approvalReason: undefined, approvalScope: undefined }
          : {}),
      };
    }
  }

  if (event.eventType === "run.completed") {
    next = {
      ...next,
      inferredRunStatus: "COMPLETED",
      activeAgent: undefined,
      approvalReason: undefined,
      approvalScope: undefined,
    };
  }

  if (event.eventType === "run.failed" || event.eventType === "error") {
    next = {
      ...next,
      inferredRunStatus: "FAILED",
      activeAgent: undefined,
      approvalReason: undefined,
      approvalScope: undefined,
      error: readError(payload.error) ?? readString(payload.message) ?? "Run failed",
    };
  }

  if (event.eventType === "preview.updated") {
    const parsed = PreviewUpdatedEventPayloadV1Schema.safeParse(event.payload);
    if (parsed.success) {
      next = {
        ...next,
        preview: {
          status: parsed.data.status,
          expiresAt: parsed.data.expiresAt,
          ...(parsed.data.url === undefined ? {} : { url: parsed.data.url }),
        },
      };
    }
  }

  if (event.eventType === "task.progress") {
    const parsed = SandboxValidationProgressEventPayloadV1Schema.safeParse(
      event.payload,
    );
    if (parsed.success) {
      const validation: ValidationProjection = {
        step: parsed.data.step,
        status: parsed.data.status,
        exitCode: parsed.data.exitCode,
        durationMs: parsed.data.durationMs,
        stdout: parsed.data.stdout,
        stderr: parsed.data.stderr,
      };
      next = {
        ...next,
        validations: [
          ...next.validations.filter((item) => item.step !== validation.step),
          validation,
        ],
      };
    }
  }

  if (event.eventType === "code_generated") {
    const paths = Array.isArray(payload.paths)
      ? payload.paths.filter((value): value is string => typeof value === "string")
      : [];
    next = {
      ...next,
      generatedPaths: [...new Set([...next.generatedPaths, ...paths])].sort(),
    };
  }

  if (event.eventType === "integration.status_changed") {
    const parsed = DatabaseStatusChangedEventPayloadV1Schema.safeParse(
      event.payload,
    );
    if (
      parsed.success &&
      (next.database === undefined ||
        next.database.operationVersion <= parsed.data.operationVersion)
    ) {
      next = {
        ...next,
        database: {
          databaseInstanceId: parsed.data.databaseInstanceId,
          operationVersion: parsed.data.operationVersion,
          status: parsed.data.status,
          ...(parsed.data.message === undefined
            ? {}
            : { message: parsed.data.message }),
        },
      };
    }
  }

  return next;
}

export function availableRunActions(status: AgentRunStatus): readonly RunAction[] {
  switch (status) {
    case "PENDING":
    case "RUNNING":
      return ["pause", "cancel"];
    case "PAUSED":
      return ["approve", "resume", "cancel"];
    case "FAILED":
      return ["retry"];
    case "COMPLETED":
    case "CANCELLED":
      return [];
  }
}

export function isSafePreviewUrl(
  value: string | undefined,
  baseDomain: string,
): boolean {
  if (value === undefined) return false;
  try {
    const url = new URL(value);
    if (url.username.length > 0 || url.password.length > 0) return false;
    const local =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname.endsWith(".localhost");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      return false;
    }
    const normalizedDomain = baseDomain.trim().toLowerCase().replace(/^\.+/, "");
    if (normalizedDomain.length === 0) return local;
    const hostname = url.hostname.toLowerCase();
    return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`);
  } catch {
    return false;
  }
}

export function languageForPath(path: string): string {
  if (path.endsWith(".tsx") || path.endsWith(".ts")) return "typescript";
  if (path.endsWith(".jsx") || path.endsWith(".js")) return "javascript";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".prisma")) return "graphql";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".sql")) return "sql";
  if (path.endsWith(".yml") || path.endsWith(".yaml")) return "yaml";
  return "plaintext";
}

function updateTask(
  projection: WorkspaceProjection,
  agent: AgentName,
  patch: Omit<Partial<AgentTaskProjection>, "agent">,
): WorkspaceProjection {
  return {
    ...projection,
    tasks: {
      ...projection.tasks,
      [agent]: {
        ...projection.tasks[agent],
        ...withoutUndefined(patch),
        agent,
      },
    },
  };
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}

function asRecord(value: JsonValue): Record<string, JsonValue> {
  return isJsonRecord(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

function isJsonRecord(
  value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readAgent(value: JsonValue | undefined): AgentName | undefined {
  return typeof value === "string" && AGENT_ORDER.includes(value as AgentName)
    ? (value as AgentName)
    : undefined;
}

function readRunStatus(value: JsonValue | undefined): AgentRunStatus | undefined {
  return typeof value === "string" &&
    ["PENDING", "RUNNING", "PAUSED", "COMPLETED", "FAILED", "CANCELLED"].includes(
      value,
    )
    ? (value as AgentRunStatus)
    : undefined;
}

function readError(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || !isJsonRecord(value)) {
    return undefined;
  }
  return typeof value.message === "string" ? value.message : undefined;
}

function readApproval(value: JsonValue) {
  try {
    return normalizeApprovalRequiredEventPayload(value);
  } catch {
    return undefined;
  }
}
