import {
  AgentOutputSchemas,
  getAgentManifest,
  type ActiveAgentName,
  type AgentRuntime,
  type AgentUpstreamOutputs,
} from "@atoms/agents";
import {
  JsonValueSchema,
  type JsonValue,
  type RunJobCommand,
} from "@atoms/contracts";
import {
  Annotation,
  END,
  START,
  StateGraph,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";

import type { WorkerRepository } from "./domain.js";
import type { RunAttachmentLoader } from "./attachment-loader.js";
import {
  GeneratedFileConflictError,
  RunStoppedError,
  toWorkerError,
} from "./errors.js";

const RunState = Annotation.Root({
  runId: Annotation<string>,
  workspaceId: Annotation<string>,
  projectId: Annotation<string>,
  prompt: Annotation<string>,
  command: Annotation<RunJobCommand>,
  controlVersion: Annotation<number>,
  outputs: Annotation<Record<string, JsonValue>>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),
});

export type RunGraphInput = typeof RunState.State;

export interface BuildRunGraphOptions {
  readonly repository: WorkerRepository;
  readonly agents: AgentRuntime;
  readonly checkpointer?: BaseCheckpointSaver;
  readonly attachmentLoader?: RunAttachmentLoader;
  readonly now?: () => Date;
}

const taskDefinitions = {
  Mike: { ordinal: 1, description: "Plan the run and dependency graph" },
  Emma: { ordinal: 2, description: "Produce structured product requirements" },
  Bob: { ordinal: 3, description: "Produce architecture and Prisma schema" },
  Alex: { ordinal: 4, description: "Generate application files and commands" },
  David: {
    ordinal: 5,
    description: "Review schema and generate migrations, seed data, and data policies",
  },
  Sarah: {
    ordinal: 6,
    description: "Generate SEO artifacts and deterministic metadata findings",
  },
  Adrian: {
    ordinal: 7,
    description: "Generate growth copy variants and evidence requirements",
  },
} as const;

export function buildRunGraph(options: BuildRunGraphOptions) {
  const now = options.now ?? (() => new Date());

  const runAgent =
    (agentName: ActiveAgentName) =>
    async (state: RunGraphInput): Promise<{ outputs: Record<string, JsonValue> }> => {
      const definition = taskDefinitions[agentName];
      const upstreamOutputs = parseUpstreamOutputs(state.outputs);
      const prepared = await options.repository.prepareTask({
        runId: state.runId,
        expectedControlVersion: state.controlVersion,
        agentName,
        description: definition.description,
        ordinal: definition.ordinal,
        input: JsonValueSchema.parse({
          prompt: state.prompt,
          upstreamOutputs,
        }),
        now: now(),
      });
      if (prepared.kind === "stopped") {
        throw new RunStoppedError("Run stopped before task preparation", "stopped");
      }

      const manifest = getAgentManifest(agentName);
      if (prepared.task.status === "COMPLETED") {
        const restored = manifest.outputSchema.parse(prepared.task.output);
        return {
          outputs: { [agentName]: JsonValueSchema.parse(restored) },
        };
      }

      const started = await options.repository.startTask(
        state.runId,
        state.controlVersion,
        prepared.task.id,
        now(),
      );
      if (started.kind === "stopped") {
        throw new RunStoppedError("Run stopped before task execution", "stopped");
      }
      if (started.task.status === "COMPLETED") {
        const restored = manifest.outputSchema.parse(started.task.output);
        return {
          outputs: { [agentName]: JsonValueSchema.parse(restored) },
        };
      }

      try {
        const currentFiles =
          agentName === "Alex" || agentName === "David"
            ? await options.repository.listProjectFiles(state.projectId)
            : [];
        const referenceAttachments =
          agentName === "Emma"
            ? await options.attachmentLoader?.load(state.runId)
            : undefined;
        const output = await options.agents.execute({
          agentName,
          runId: state.runId,
          prompt: state.prompt,
          upstreamOutputs,
          currentFiles,
          ...(referenceAttachments === undefined ||
          referenceAttachments.length === 0
            ? {}
            : { referenceAttachments }),
        });
        if (agentName === "Sarah") {
          enforceDeterministicSeoChecks(output, upstreamOutputs);
        }
        const normalizedOutput = JsonValueSchema.parse(output);
        const generatedFiles =
          agentName === "Alex"
            ? AgentOutputSchemas.Alex.parse(output).files
            : agentName === "David"
              ? AgentOutputSchemas.David.parse(output).files
              : undefined;
        const completed = await options.repository.completeTask({
          runId: state.runId,
          expectedControlVersion: state.controlVersion,
          taskId: started.task.id,
          output: normalizedOutput,
          ...(generatedFiles === undefined ? {} : { generatedFiles }),
          now: now(),
        });
        if (completed.kind === "stopped") {
          throw new RunStoppedError(
            "Run stopped before the agent result could be applied",
            "stopped",
          );
        }
        if (completed.kind === "file_conflict") {
          throw new GeneratedFileConflictError(
            completed.path,
            completed.expectedVersion,
            completed.actualVersion,
          );
        }
        return { outputs: { [agentName]: normalizedOutput } };
      } catch (error) {
        if (error instanceof RunStoppedError) throw error;
        const failed = await options.repository.failTask({
          runId: state.runId,
          expectedControlVersion: state.controlVersion,
          taskId: started.task.id,
          error: toWorkerError(error),
          now: now(),
        });
        if (failed === "stopped") {
          throw new RunStoppedError(
            "Run stopped while the task result was in flight",
            "stopped",
          );
        }
        throw error;
      }
    };

  const approvalGate = async (state: RunGraphInput): Promise<{}> => {
    const mike = AgentOutputSchemas.Mike.parse(state.outputs.Mike);
    if (!mike.requiresApproval || state.command === "approve") return {};

    const paused = await options.repository.requestApproval(
      state.runId,
      state.controlVersion,
      "Approve the product and architecture plan before code generation",
      now(),
    );
    throw new RunStoppedError(
      paused
        ? "Run is waiting for plan approval"
        : "Run stopped before approval could be requested",
      paused ? "PAUSED" : "stopped",
    );
  };

  const contentApprovalGate = async (state: RunGraphInput): Promise<{}> => {
    const adrian = AgentOutputSchemas.Adrian.parse(state.outputs.Adrian);
    const hasCopyVariants =
      adrian.contentPackage.ctaVariants.length > 0 ||
      adrian.contentPackage.adVariants.length > 0;
    if (!hasCopyVariants || state.command === "approve") return {};

    const paused = await options.repository.requestApproval(
      state.runId,
      state.controlVersion,
      "Approve content variants before applying copy changes",
      now(),
    );
    throw new RunStoppedError(
      paused
        ? "Run is waiting for content approval"
        : "Run stopped before content approval could be requested",
      paused ? "PAUSED" : "stopped",
    );
  };

  const builder = new StateGraph(RunState)
    .addNode("mike", runAgent("Mike"))
    .addNode("emma", runAgent("Emma"))
    .addNode("bob", runAgent("Bob"))
    .addNode("approval", approvalGate)
    .addNode("alex", runAgent("Alex"))
    .addNode("david", runAgent("David"))
    .addNode("sarah", runAgent("Sarah"))
    .addNode("adrian", runAgent("Adrian"))
    .addNode("content-approval", contentApprovalGate)
    .addEdge(START, "mike")
    .addEdge("mike", "emma")
    .addEdge("emma", "bob")
    .addEdge("bob", "approval")
    .addEdge("approval", "alex")
    .addEdge("alex", "david")
    .addEdge("david", "sarah")
    .addEdge("sarah", "adrian")
    .addEdge("adrian", "content-approval")
    .addEdge("content-approval", END);

  return builder.compile(
    options.checkpointer === undefined
      ? {}
      : { checkpointer: options.checkpointer },
  );
}

function enforceDeterministicSeoChecks(
  output: unknown,
  upstreamOutputs: AgentUpstreamOutputs,
): void {
  const sarah = AgentOutputSchemas.Sarah.parse(output);
  const bob = upstreamOutputs.Bob;
  if (bob === undefined) return;

  const requiredRoutePaths = [...new Set(bob.routes.map((route) => route.path))];
  const coveredRoutePaths = new Set(
    sarah.seoPackage.routeMetadata.map((entry) => entry.routePath),
  );
  const missingRouteMetadata = requiredRoutePaths.filter(
    (path) => !coveredRoutePaths.has(path),
  );

  const canonicalCounts = new Map<string, number>();
  for (const entry of sarah.seoPackage.routeMetadata) {
    if (entry.canonicalUrl === null) continue;
    canonicalCounts.set(
      entry.canonicalUrl,
      (canonicalCounts.get(entry.canonicalUrl) ?? 0) + 1,
    );
  }
  const duplicateCanonicals = [...canonicalCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([canonicalUrl]) => canonicalUrl);

  if (missingRouteMetadata.length === 0 && duplicateCanonicals.length === 0) {
    return;
  }

  const issues: string[] = [];
  if (missingRouteMetadata.length > 0) {
    issues.push(
      `missing route metadata for: ${missingRouteMetadata.join(", ")}`,
    );
  }
  if (duplicateCanonicals.length > 0) {
    issues.push(
      `duplicate canonical URLs detected: ${duplicateCanonicals.join(", ")}`,
    );
  }
  throw new DeterministicSeoValidationError(
    `Sarah output failed deterministic SEO checks: ${issues.join("; ")}`,
  );
}

class DeterministicSeoValidationError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "DeterministicSeoValidationError";
  }
}

function parseUpstreamOutputs(
  outputs: Readonly<Record<string, JsonValue>>,
): AgentUpstreamOutputs {
  return {
    ...(outputs.Mike === undefined
      ? {}
      : { Mike: AgentOutputSchemas.Mike.parse(outputs.Mike) }),
    ...(outputs.Emma === undefined
      ? {}
      : { Emma: AgentOutputSchemas.Emma.parse(outputs.Emma) }),
    ...(outputs.Bob === undefined
      ? {}
      : { Bob: AgentOutputSchemas.Bob.parse(outputs.Bob) }),
    ...(outputs.Alex === undefined
      ? {}
      : { Alex: AgentOutputSchemas.Alex.parse(outputs.Alex) }),
    ...(outputs.David === undefined
      ? {}
      : { David: AgentOutputSchemas.David.parse(outputs.David) }),
    ...(outputs.Sarah === undefined
      ? {}
      : { Sarah: AgentOutputSchemas.Sarah.parse(outputs.Sarah) }),
    ...(outputs.Adrian === undefined
      ? {}
      : { Adrian: AgentOutputSchemas.Adrian.parse(outputs.Adrian) }),
  };
}
