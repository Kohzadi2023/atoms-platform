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
  type ApprovalScope,
  type RunJobCommand,
  type WorkspacePlan,
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
import { isRequiredForProjectType, type SkipReason } from "./project-type.js";
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
  approvalScope: Annotation<ApprovalScope | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  controlVersion: Annotation<number>,
  approvalBypassConsumed: Annotation<boolean>({
    reducer: (_current, update) => update,
    default: () => false,
  }),
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
  Sophia: {
    ordinal: 1,
    description: "Analyze market, ICP, competition, pricing, positioning, and evidence gaps",
  },
  Mike: { ordinal: 2, description: "Plan the run and dependency graph" },
  Emma: { ordinal: 3, description: "Produce structured product requirements" },
  Bob: { ordinal: 4, description: "Produce architecture and Prisma schema" },
  Alex: { ordinal: 5, description: "Generate application files and commands" },
  David: {
    ordinal: 6,
    description: "Review schema and generate migrations, seed data, and data policies",
  },
  Sarah: {
    ordinal: 7,
    description: "Generate SEO artifacts and deterministic metadata findings",
  },
  Adrian: {
    ordinal: 8,
    description: "Generate growth copy variants and evidence requirements",
  },
  // Registered contract only: no node/edge references this agent yet, since
  // its real trigger (a customer conversion) is not the run graph.
  CustomerSuccess: {
    ordinal: 9,
    description: "Produce onboarding plan, activation milestones, health review, and retention proposals",
  },
} as const;

// Premium, entitlement-controlled capabilities (ADR-014/ADR-017). Every
// other registered agent is core and always runs. No billing/checkout
// exists yet, so a workspace's plan is set directly -- see
// packages/db/prisma/schema.prisma's WorkspacePlan.
const PREMIUM_AGENTS: ReadonlySet<ActiveAgentName> = new Set([
  "Sophia",
  "Sarah",
  "Adrian",
]);

function isEntitled(plan: WorkspacePlan, agentName: ActiveAgentName): boolean {
  return !PREMIUM_AGENTS.has(agentName) || plan !== "FREE";
}

export function buildRunGraph(options: BuildRunGraphOptions) {
  const now = options.now ?? (() => new Date());

  const runHasReferences = async (runId: string): Promise<boolean> =>
    ((await options.attachmentLoader?.load(runId))?.length ?? 0) > 0;

  const runAgent =
    (agentName: ActiveAgentName) =>
    async (state: RunGraphInput): Promise<{ outputs: Record<string, JsonValue> }> => {
      const definition = taskDefinitions[agentName];
      const upstreamOutputs = parseUpstreamOutputs(state.outputs);

      // An agent runs only if the project type needs it AND the plan entitles it.
      // Either way a missing agent is recorded as a skipped task, never silently dropped.
      const projectType = await options.repository.getProjectType(state.projectId);
      const skipReason: SkipReason | undefined = !isRequiredForProjectType(
        projectType,
        agentName,
      )
        ? "NOT_REQUIRED_FOR_PROJECT_TYPE"
        : PREMIUM_AGENTS.has(agentName) &&
            !isEntitled(
              await options.repository.getWorkspacePlan(state.workspaceId),
              agentName,
            )
          ? "PLAN_NOT_ENTITLED"
          : undefined;
      if (skipReason !== undefined) {
        const skipped = await options.repository.skipTask({
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
          skipReason,
        });
        if (skipped.kind === "stopped") {
          throw new RunStoppedError(
            "Run stopped before the skipped task could be recorded",
            "stopped",
          );
        }
        return { outputs: {} };
      }

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
          agentName === "Sophia" || agentName === "Emma"
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
    const planApprovalAlreadyConsumed = state.outputs.Alex !== undefined;
    if (planApprovalAlreadyConsumed) return {};
    // requiresApproval is model output, and Mike sits downstream of Sophia, which
    // reads user-uploaded references. Text in a reference must never be able to
    // switch the approval off, so a run that carries references always stops.
    if (!mike.requiresApproval && !(await runHasReferences(state.runId))) {
      return {};
    }
    if (
      state.command === "approve" &&
      state.approvalScope === "plan" &&
      !state.approvalBypassConsumed
    ) {
      return { approvalBypassConsumed: true };
    }

    const paused = await options.repository.requestApproval(
      state.runId,
      state.controlVersion,
      "plan",
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
    // Adrian is a premium agent and may have been skipped by the
    // entitlement gate above -- no copy variants means nothing to approve.
    if (state.outputs.Adrian === undefined) return {};
    const adrian = AgentOutputSchemas.Adrian.parse(state.outputs.Adrian);
    const hasCopyVariants =
      adrian.contentPackage.ctaVariants.length > 0 ||
      adrian.contentPackage.adVariants.length > 0;
    if (!hasCopyVariants) return {};
    if (
      state.command === "approve" &&
      state.approvalScope === "content" &&
      !state.approvalBypassConsumed
    ) {
      return { approvalBypassConsumed: true };
    }

    const paused = await options.repository.requestApproval(
      state.runId,
      state.controlVersion,
      "content",
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
    .addNode("sophia", runAgent("Sophia"))
    .addNode("mike", runAgent("Mike"))
    .addNode("emma", runAgent("Emma"))
    .addNode("bob", runAgent("Bob"))
    .addNode("approval", approvalGate)
    .addNode("alex", runAgent("Alex"))
    .addNode("david", runAgent("David"))
    .addNode("sarah", runAgent("Sarah"))
    .addNode("adrian", runAgent("Adrian"))
    .addNode("content-approval", contentApprovalGate)
    .addEdge(START, "sophia")
    .addEdge("sophia", "mike")
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
    ...(outputs.Sophia === undefined
      ? {}
      : { Sophia: AgentOutputSchemas.Sophia.parse(outputs.Sophia) }),
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
