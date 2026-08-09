import type {
  ActiveAgentName,
  AgentGeneratedFile,
  AgentProjectFile,
} from "@atoms/agents";
import type {
  ApprovalScope,
  AgentRunStatus,
  JsonValue,
  RunEventType,
  RunJob,
} from "@atoms/contracts";

export interface RunExecutionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly status: AgentRunStatus;
  readonly prompt: string;
  readonly controlVersion: number;
}

export type RunClaimResult =
  | { readonly kind: "ready"; readonly run: RunExecutionRecord }
  | { readonly kind: "missing" }
  | {
      readonly kind: "stale";
      readonly status: AgentRunStatus;
      readonly controlVersion: number;
    };

export type WorkerTaskStatus =
  | "PENDING"
  | "RUNNING"
  | "WAITING_FOR_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface WorkerTaskRecord {
  readonly id: string;
  readonly runId: string;
  readonly agentName: ActiveAgentName;
  readonly description: string;
  readonly ordinal: number;
  readonly status: WorkerTaskStatus;
  readonly attempt: number;
  readonly output: JsonValue | null;
}

export interface PrepareTaskInput {
  readonly runId: string;
  readonly expectedControlVersion: number;
  readonly agentName: ActiveAgentName;
  readonly description: string;
  readonly ordinal: number;
  readonly input: JsonValue;
  readonly now: Date;
}

export type TaskMutationResult =
  | { readonly kind: "ok"; readonly task: WorkerTaskRecord }
  | { readonly kind: "stopped" };

export interface CompleteTaskInput {
  readonly runId: string;
  readonly expectedControlVersion: number;
  readonly taskId: string;
  readonly output: JsonValue;
  readonly generatedFiles?: readonly AgentGeneratedFile[];
  readonly now: Date;
}

export type CompleteTaskResult =
  | { readonly kind: "ok"; readonly task: WorkerTaskRecord }
  | { readonly kind: "stopped" }
  | {
      readonly kind: "file_conflict";
      readonly path: string;
      readonly expectedVersion: number;
      readonly actualVersion: number;
    };

export interface FailTaskInput {
  readonly runId: string;
  readonly expectedControlVersion: number;
  readonly taskId: string;
  readonly error: JsonValue;
  readonly now: Date;
}

export interface WorkerRepository {
  claimRun(job: RunJob, now: Date): Promise<RunClaimResult>;
  prepareTask(input: PrepareTaskInput): Promise<TaskMutationResult>;
  startTask(
    runId: string,
    expectedControlVersion: number,
    taskId: string,
    now: Date,
  ): Promise<TaskMutationResult>;
  completeTask(input: CompleteTaskInput): Promise<CompleteTaskResult>;
  failTask(input: FailTaskInput): Promise<"failed" | "stopped">;
  listProjectFiles(projectId: string): Promise<readonly AgentProjectFile[]>;
  requestApproval(
    runId: string,
    expectedControlVersion: number,
    scope: ApprovalScope,
    reason: string,
    now: Date,
  ): Promise<boolean>;
  completeRun(
    runId: string,
    expectedControlVersion: number,
    now: Date,
  ): Promise<boolean>;
  failRun(
    runId: string,
    expectedControlVersion: number,
    error: JsonValue,
    now: Date,
  ): Promise<boolean>;
  close(): Promise<void>;
}

export interface PersistedEvent {
  readonly runId: string;
  readonly sequence: number;
  readonly eventType: RunEventType;
  readonly payload: JsonValue;
}
