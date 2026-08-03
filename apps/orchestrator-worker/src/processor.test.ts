import assert from "node:assert/strict";
import test from "node:test";

import type {
  ActiveMvpAgentName,
  AgentExecutionRequest,
  AgentOutputByName,
  AgentProjectFile,
  AgentRuntime,
} from "@atoms/agents";
import type {
  AgentRunStatus,
  JsonValue,
  RunEventType,
  RunJob,
} from "@atoms/contracts";
import { MemorySaver } from "@langchain/langgraph";
import type { RunAttachmentLoader } from "./attachment-loader.js";

import type {
  CompleteTaskInput,
  CompleteTaskResult,
  FailTaskInput,
  PersistedEvent,
  PrepareTaskInput,
  RunClaimResult,
  TaskMutationResult,
  WorkerRepository,
  WorkerTaskStatus,
} from "./domain.js";
import { RunProcessor } from "./processor.js";
import type { RunValidationInput, RunValidator } from "./validation.js";

const RUN_ID = "00000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const PROJECT_ID = "00000000-0000-4000-8000-000000000003";
const FIXED_NOW = new Date("2026-07-31T12:00:00.000Z");

interface MutableRun {
  status: AgentRunStatus;
  controlVersion: number;
  eventSequence: number;
  error: JsonValue | null;
}

interface MutableTask {
  id: string;
  runId: string;
  agentName: ActiveMvpAgentName;
  description: string;
  ordinal: number;
  status: WorkerTaskStatus;
  attempt: number;
  output: JsonValue | null;
}

class MemoryRepository implements WorkerRepository {
  readonly run: MutableRun = {
    status: "PENDING",
    controlVersion: 0,
    eventSequence: 0,
    error: null,
  };
  readonly tasks = new Map<number, MutableTask>();
  readonly files: Array<AgentProjectFile> = [];
  readonly events: PersistedEvent[] = [];
  completeRunSucceeds = true;

  async claimRun(job: RunJob): Promise<RunClaimResult> {
    if (job.runId !== RUN_ID) return { kind: "missing" };
    if (
      this.run.status === "RUNNING" &&
      this.run.controlVersion === job.controlVersion + 1
    ) {
      return { kind: "ready", run: this.runRecord() };
    }
    if (
      this.run.status !== "PENDING" ||
      this.run.controlVersion !== job.controlVersion
    ) {
      return {
        kind: "stale",
        status: this.run.status,
        controlVersion: this.run.controlVersion,
      };
    }
    this.run.status = "RUNNING";
    this.run.controlVersion += 1;
    this.append("run.status_changed", {
      from: "PENDING",
      to: "RUNNING",
      command: job.command,
    });
    return { kind: "ready", run: this.runRecord() };
  }

  async prepareTask(input: PrepareTaskInput): Promise<TaskMutationResult> {
    if (!this.active(input.expectedControlVersion)) return { kind: "stopped" };
    const existing = this.tasks.get(input.ordinal);
    if (existing !== undefined) return { kind: "ok", task: existing };
    const task: MutableTask = {
      id: `00000000-0000-4000-8000-${String(input.ordinal).padStart(12, "0")}`,
      runId: input.runId,
      agentName: input.agentName,
      description: input.description,
      ordinal: input.ordinal,
      status: "PENDING",
      attempt: 0,
      output: null,
    };
    this.tasks.set(task.ordinal, task);
    this.append("task.created", {
      taskId: task.id,
      agent: task.agentName,
      ordinal: task.ordinal,
    });
    return { kind: "ok", task };
  }

  async startTask(
    _runId: string,
    expectedControlVersion: number,
    taskId: string,
  ): Promise<TaskMutationResult> {
    if (!this.active(expectedControlVersion)) return { kind: "stopped" };
    const task = this.taskById(taskId);
    if (task.status === "COMPLETED") return { kind: "ok", task };
    task.status = "RUNNING";
    task.attempt += 1;
    this.append("task.started", {
      taskId: task.id,
      agent: task.agentName,
      ordinal: task.ordinal,
      attempt: task.attempt,
    });
    return { kind: "ok", task };
  }

  async completeTask(input: CompleteTaskInput): Promise<CompleteTaskResult> {
    if (!this.active(input.expectedControlVersion)) return { kind: "stopped" };
    const task = this.taskById(input.taskId);
    if (task.status === "COMPLETED") return { kind: "ok", task };

    for (const generated of input.generatedFiles ?? []) {
      const latest = this.latestFile(generated.path);
      const actualVersion = latest?.version ?? 0;
      if (generated.expectedVersion !== actualVersion) {
        return {
          kind: "file_conflict",
          path: generated.path,
          expectedVersion: generated.expectedVersion,
          actualVersion,
        };
      }
    }
    for (const generated of input.generatedFiles ?? []) {
      const latest = this.latestFile(generated.path);
      if (latest?.content === generated.content) continue;
      this.files.push({
        path: generated.path,
        content: generated.content,
        version: (latest?.version ?? 0) + 1,
      });
    }

    task.status = "COMPLETED";
    task.output = input.output;
    this.append("task.completed", {
      taskId: task.id,
      agent: task.agentName,
      ordinal: task.ordinal,
    });
    this.append("artifact.created", {
      version: "v1",
      taskId: task.id,
      agent: task.agentName,
      artifactType: `${task.agentName.toLowerCase()}-output`,
    });
    if (task.agentName === "Sarah") {
      this.append("artifact.created", {
        version: "v1",
        taskId: task.id,
        agent: task.agentName,
        artifactType: "seo-package",
      });
    }
    if (task.agentName === "Adrian") {
      this.append("artifact.created", {
        version: "v1",
        taskId: task.id,
        agent: task.agentName,
        artifactType: "content-package",
      });
    }
    if (input.generatedFiles !== undefined) {
      this.append("code_generated", {
        taskId: task.id,
        fileCount: input.generatedFiles.length,
      });
    }
    return { kind: "ok", task };
  }

  async failTask(input: FailTaskInput): Promise<"failed" | "stopped"> {
    if (!this.active(input.expectedControlVersion)) return "stopped";
    const task = this.taskById(input.taskId);
    task.status = "FAILED";
    this.append("task.failed", {
      taskId: task.id,
      agent: task.agentName,
      error: input.error,
    });
    return "failed";
  }

  async listProjectFiles(): Promise<readonly AgentProjectFile[]> {
    const paths = [...new Set(this.files.map((file) => file.path))].sort();
    return paths.map((path) => this.latestFile(path) as AgentProjectFile);
  }

  async requestApproval(
    _runId: string,
    expectedControlVersion: number,
    reason: string,
  ): Promise<boolean> {
    if (!this.active(expectedControlVersion)) return false;
    this.run.status = "PAUSED";
    this.run.controlVersion += 1;
    this.append("approval.required", { reason });
    return true;
  }

  async completeRun(
    _runId: string,
    expectedControlVersion: number,
  ): Promise<boolean> {
    if (!this.active(expectedControlVersion)) return false;
    if (!this.completeRunSucceeds) return false;
    this.run.status = "COMPLETED";
    this.run.controlVersion += 1;
    this.append("run.completed", { completedAt: FIXED_NOW.toISOString() });
    return true;
  }

  async failRun(
    _runId: string,
    expectedControlVersion: number,
    error: JsonValue,
  ): Promise<boolean> {
    if (!this.active(expectedControlVersion)) return false;
    this.run.status = "FAILED";
    this.run.controlVersion += 1;
    this.run.error = error;
    this.append("run.failed", { error });
    return true;
  }

  async close(): Promise<void> {}

  approve(): number {
    assert.equal(this.run.status, "PAUSED");
    this.run.status = "PENDING";
    this.run.controlVersion += 1;
    return this.run.controlVersion;
  }

  seedFile(file: AgentProjectFile): void {
    this.files.push(file);
  }

  latestFileForTest(path: string): AgentProjectFile | undefined {
    return this.latestFile(path);
  }

  private active(controlVersion: number): boolean {
    return (
      this.run.status === "RUNNING" &&
      this.run.controlVersion === controlVersion
    );
  }

  private runRecord() {
    return {
      id: RUN_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      status: this.run.status,
      prompt: "Build a customer portal",
      controlVersion: this.run.controlVersion,
    };
  }

  private taskById(taskId: string): MutableTask {
    const task = [...this.tasks.values()].find((candidate) => candidate.id === taskId);
    if (task === undefined) throw new Error("Task fixture not found");
    return task;
  }

  private latestFile(path: string): AgentProjectFile | undefined {
    return this.files
      .filter((file) => file.path === path)
      .sort((left, right) => right.version - left.version)[0];
  }

  private append(eventType: RunEventType, payload: JsonValue): void {
    this.run.eventSequence += 1;
    this.events.push({
      runId: RUN_ID,
      sequence: this.run.eventSequence,
      eventType,
      payload,
    });
  }
}

class RetryableTestError extends Error {
  readonly retryable = true;
}

class ScriptedAgentRuntime implements AgentRuntime {
  readonly calls: ActiveMvpAgentName[] = [];
  readonly requests: AgentExecutionRequest[] = [];
  readonly #outputs: AgentOutputByName;
  failAlexOnce = false;
  #alexFailed = false;

  constructor(outputs: AgentOutputByName) {
    this.#outputs = outputs;
  }

  async execute<Name extends ActiveMvpAgentName>(
    request: AgentExecutionRequest<Name>,
  ): Promise<AgentOutputByName[Name]> {
    this.calls.push(request.agentName);
    this.requests.push(request);
    if (request.agentName === "Alex" && this.failAlexOnce && !this.#alexFailed) {
      this.#alexFailed = true;
      throw new RetryableTestError("Transient model failure");
    }
    return this.#outputs[request.agentName] as unknown as AgentOutputByName[Name];
  }
}

function outputs(options: {
  readonly requiresApproval?: boolean;
  readonly expectedVersion?: number;
  readonly alexFiles?: AgentOutputByName["Alex"]["files"];
  readonly bobRoutes?: AgentOutputByName["Bob"]["routes"];
  readonly sarahRouteMetadata?: AgentOutputByName["Sarah"]["seoPackage"]["routeMetadata"];
} = {}): AgentOutputByName {
  return {
    Mike: {
      summary: "Generate the supported customer portal.",
      taskGraph: [
        {
          key: "plan-run",
          agent: "Mike",
          description: "Plan the run",
          dependsOn: [],
          acceptanceCriteria: ["Every task is owned"],
          maxAttempts: 3,
        },
      ],
      assumptions: [],
      requiresApproval: options.requiresApproval ?? false,
    },
    Emma: {
      productName: "Customer Portal",
      problemStatement: "Customers need a secure self-service portal.",
      targetUsers: ["Customers"],
      userStories: [
        {
          id: "US-001",
          role: "Customer",
          goal: "View my account",
          benefit: "I can self-serve",
          acceptanceCriteria: ["The dashboard renders"],
        },
      ],
      nonGoals: ["Native mobile application"],
      assumptions: [],
    },
    Bob: {
      architectureSummary: "One supported Next.js application.",
      routes:
        options.bobRoutes ??
        [{ method: "GET", path: "/", purpose: "Dashboard" }],
      components: ["Dashboard"],
      dataModels: ["User"],
      schemaPrisma: "model User { id String @id }",
      decisions: ["Use the fixed launch stack"],
    },
    Alex: {
      summary: "Generated the dashboard.",
      files:
        options.alexFiles ??
        [
          {
            path: "app/page.tsx",
            content: "export default function Page() { return <main>Portal</main>; }",
            expectedVersion: options.expectedVersion ?? 0,
          },
        ],
      commands: {
        lint: "pnpm lint",
        typecheck: "pnpm typecheck",
        test: "pnpm test",
        build: "pnpm build",
      },
    },
    David: {
      summary: "Added a forward-only initial migration and idempotent seed.",
      schemaPrismaPath: "prisma/schema.prisma",
      migrations: [
        {
          name: "init",
          path: "prisma/migrations/202608012000_init/migration.sql",
          risk: "SAFE",
          rationale: "Creates the initial supported schema.",
        },
      ],
      seedPath: "prisma/seed.ts",
      files: [
        {
          path: "prisma/schema.prisma",
          content: "model User { id String @id }",
          expectedVersion: 0,
        },
        {
          path: "prisma/migrations/202608012000_init/migration.sql",
          content: "CREATE TABLE users (id text primary key);",
          expectedVersion: 0,
        },
        {
          path: "prisma/seed.ts",
          content: "export {};",
          expectedVersion: 0,
        },
      ],
      dataPolicyReport: {
        summary: "No sensitive fields are present in the initial model.",
        rlsModels: [],
        findings: [],
      },
      destructiveChanges: [],
    },
    Sarah: {
      summary: "Prepared route metadata and deterministic SEO findings.",
      seoPackage: {
        version: "v1",
        sitemapXml: "<urlset></urlset>",
        robotsTxt: "User-agent: *\nAllow: /\n",
        routeMetadata:
          options.sarahRouteMetadata ??
          [
            {
              routePath: "/",
              title: "Customer Portal",
              description: "Secure self-service dashboard for customers.",
              canonicalUrl: null,
            },
          ],
        findings: [],
      },
    },
    Adrian: {
      summary: "Generated launch copy variants aligned to the approved audience.",
      contentPackage: {
        version: "v1",
        audience: "Small business customers",
        valuePropositions: ["Self-service account access in minutes"],
        ctaVariants: [
          {
            id: "cta-primary",
            headline: "Launch your secure portal",
            body: "Give customers a fast way to manage their account online.",
            ctaLabel: "Start now",
          },
        ],
        adVariants: [],
        claimsRequiringEvidence: [],
      },
    },
  };
}

function startJob(): RunJob {
  return { runId: RUN_ID, command: "start", controlVersion: 0 };
}

function approveJob(controlVersion: number): RunJob {
  return { runId: RUN_ID, command: "approve", controlVersion };
}

function processor(repository: MemoryRepository, agents: AgentRuntime): RunProcessor {
  return new RunProcessor({
    repository,
    agents,
    checkpointer: new MemorySaver(),
    now: () => FIXED_NOW,
  });
}

test("worker executes the full Phase 4 chain once and commits ordered events", async () => {
  const repository = new MemoryRepository();
  const agents = new ScriptedAgentRuntime(outputs());
  const runProcessor = processor(repository, agents);

  assert.deepEqual(
    await runProcessor.process(startJob(), { attempt: 1, maxAttempts: 3 }),
    { outcome: "stopped", status: "PAUSED" },
  );
  const approvalEvent = repository.events.find(
    (event) => event.eventType === "approval.required",
  );
  assert.equal(typeof approvalEvent?.payload, "object");
  assert.equal(approvalEvent?.payload === null, false);
  assert.equal(
    (approvalEvent?.payload as { readonly reason: string }).reason,
    "Approve content variants before applying copy changes",
  );
  const approvedVersion = repository.approve();
  assert.deepEqual(
    await runProcessor.process(approveJob(approvedVersion), {
      attempt: 1,
      maxAttempts: 3,
    }),
    { outcome: "completed" },
  );
  assert.deepEqual(agents.calls, [
    "Mike",
    "Emma",
    "Bob",
    "Alex",
    "David",
    "Sarah",
    "Adrian",
  ]);
  assert.equal(repository.run.status, "COMPLETED");
  assert.equal(repository.latestFileForTest("app/page.tsx")?.version, 1);
  const artifactEvents = repository.events.filter(
    (event) => event.eventType === "artifact.created",
  );
  assert.equal(artifactEvents.length, 9);
  const firstArtifactPayload = artifactEvents[0]?.payload;
  const lastArtifactPayload = artifactEvents[8]?.payload;
  assert.equal(typeof firstArtifactPayload, "object");
  assert.equal(firstArtifactPayload === null, false);
  assert.equal(typeof lastArtifactPayload, "object");
  assert.equal(lastArtifactPayload === null, false);
  assert.equal(
    (firstArtifactPayload as { readonly version: string }).version,
    "v1",
  );
  assert.equal(
    (firstArtifactPayload as { readonly artifactType: string }).artifactType,
    "mike-output",
  );
  assert.equal(
    (
      artifactEvents[7]?.payload as { readonly artifactType: string }
    ).artifactType,
    "adrian-output",
  );
  assert.equal(
    (lastArtifactPayload as { readonly artifactType: string }).artifactType,
    "content-package",
  );
  assert.deepEqual(
    repository.events.map((event) => event.sequence),
    repository.events.map((_event, index) => index + 1),
  );

  assert.deepEqual(
    await runProcessor.process(startJob(), { attempt: 1, maxAttempts: 3 }),
    { outcome: "skipped", reason: "stale" },
  );
  assert.deepEqual(agents.calls, [
    "Mike",
    "Emma",
    "Bob",
    "Alex",
    "David",
    "Sarah",
    "Adrian",
  ]);
});

test("worker loads clean references once and sends them only to Emma", async () => {
  const repository = new MemoryRepository();
  const agents = new ScriptedAgentRuntime(outputs());
  let loads = 0;
  const attachmentLoader: RunAttachmentLoader = {
    load: async (runId) => {
      loads += 1;
      assert.equal(runId, RUN_ID);
      return [
        {
          id: "00000000-0000-4000-8000-000000000010",
          kind: "file",
          fileName: "brief.txt",
          mimeType: "text/plain",
          dataBase64: "YnJpZWY=",
        },
      ];
    },
  };
  const runProcessor = new RunProcessor({
    repository,
    agents,
    attachmentLoader,
    checkpointer: new MemorySaver(),
    now: () => FIXED_NOW,
  });

  assert.deepEqual(
    await runProcessor.process(startJob(), { attempt: 1, maxAttempts: 3 }),
    { outcome: "stopped", status: "PAUSED" },
  );
  const approvedVersion = repository.approve();
  assert.deepEqual(
    await runProcessor.process(approveJob(approvedVersion), {
      attempt: 1,
      maxAttempts: 3,
    }),
    { outcome: "completed" },
  );
  assert.equal(loads, 1);
  assert.equal(
    agents.requests.find((request) => request.agentName === "Emma")
      ?.referenceAttachments?.[0]?.fileName,
    "brief.txt",
  );
  assert.equal(
    agents.requests
      .filter((request) => request.agentName !== "Emma")
      .some((request) => request.referenceAttachments !== undefined),
    false,
  );
});

test("worker runs validation after Phase 4 agents and before completing the durable run", async () => {
  const repository = new MemoryRepository();
  const agents = new ScriptedAgentRuntime(outputs());
  const validations: RunValidationInput[] = [];
  const validator: RunValidator = {
    validate: async (input) => {
      assert.equal(repository.run.status, "RUNNING");
      assert.equal(repository.tasks.get(5)?.status, "COMPLETED");
      assert.equal(repository.tasks.get(6)?.status, "COMPLETED");
      assert.equal(repository.tasks.get(7)?.status, "COMPLETED");
      validations.push(input);
    },
  };
  const runProcessor = new RunProcessor({
    repository,
    agents,
    checkpointer: new MemorySaver(),
    validator,
    now: () => FIXED_NOW,
  });

  assert.deepEqual(
    await runProcessor.process(startJob(), { attempt: 2, maxAttempts: 3 }),
    { outcome: "stopped", status: "PAUSED" },
  );
  const approvedVersion = repository.approve();
  assert.deepEqual(
    await runProcessor.process(approveJob(approvedVersion), {
      attempt: 2,
      maxAttempts: 3,
    }),
    { outcome: "completed" },
  );
  assert.equal(validations.length, 1);
  assert.equal(validations[0]?.attempt, 2);
  assert.equal(validations[0]?.run.projectId, PROJECT_ID);
});

test("worker revokes a published preview if completion loses the control-version race", async () => {
  const repository = new MemoryRepository();
  repository.completeRunSucceeds = false;
  const agents = new ScriptedAgentRuntime(outputs());
  let revoked = 0;
  const validator: RunValidator = {
    validate: async () => ({
      revoke: async () => {
        revoked += 1;
      },
    }),
  };
  const runProcessor = new RunProcessor({
    repository,
    agents,
    checkpointer: new MemorySaver(),
    validator,
    now: () => FIXED_NOW,
  });

  assert.deepEqual(
    await runProcessor.process(startJob(), { attempt: 1, maxAttempts: 3 }),
    { outcome: "stopped", status: "PAUSED" },
  );
  const approvedVersion = repository.approve();
  assert.deepEqual(
    await runProcessor.process(approveJob(approvedVersion), {
      attempt: 1,
      maxAttempts: 3,
    }),
    { outcome: "stopped", status: "stale" },
  );
  assert.equal(revoked, 1);
});

test("plan approval pauses after Bob and resumes without repeating completed agents", async () => {
  const repository = new MemoryRepository();
  const agents = new ScriptedAgentRuntime(outputs({ requiresApproval: true }));
  const runProcessor = processor(repository, agents);

  assert.deepEqual(
    await runProcessor.process(startJob(), { attempt: 1, maxAttempts: 3 }),
    { outcome: "stopped", status: "PAUSED" },
  );
  assert.deepEqual(agents.calls, ["Mike", "Emma", "Bob"]);
  const approvedVersion = repository.approve();

  assert.deepEqual(
    await runProcessor.process(
      { runId: RUN_ID, command: "approve", controlVersion: approvedVersion },
      { attempt: 1, maxAttempts: 3 },
    ),
    { outcome: "completed" },
  );
  assert.deepEqual(agents.calls, [
    "Mike",
    "Emma",
    "Bob",
    "Alex",
    "David",
    "Sarah",
    "Adrian",
  ]);
});

test("a retryable failure retries only the unfinished agent task", async () => {
  const repository = new MemoryRepository();
  const agents = new ScriptedAgentRuntime(outputs());
  agents.failAlexOnce = true;
  const runProcessor = processor(repository, agents);

  await assert.rejects(
    runProcessor.process(startJob(), { attempt: 1, maxAttempts: 3 }),
    RetryableTestError,
  );
  assert.equal(repository.run.status, "RUNNING");

  assert.deepEqual(
    await runProcessor.process(startJob(), { attempt: 2, maxAttempts: 3 }),
    { outcome: "stopped", status: "PAUSED" },
  );
  const approvedVersion = repository.approve();
  assert.deepEqual(
    await runProcessor.process(approveJob(approvedVersion), {
      attempt: 2,
      maxAttempts: 3,
    }),
    { outcome: "completed" },
  );
  assert.deepEqual(agents.calls, [
    "Mike",
    "Emma",
    "Bob",
    "Alex",
    "Alex",
    "David",
    "Sarah",
    "Adrian",
  ]);
});

test("Sarah output fails when route coverage is incomplete", async () => {
  const repository = new MemoryRepository();
  const agents = new ScriptedAgentRuntime(
    outputs({
      bobRoutes: [
        { method: "GET", path: "/", purpose: "Dashboard" },
        { method: "GET", path: "/pricing", purpose: "Pricing" },
      ],
      sarahRouteMetadata: [
        {
          routePath: "/",
          title: "Customer Portal",
          description: "Secure self-service dashboard for customers.",
          canonicalUrl: "https://acme.example/",
        },
      ],
    }),
  );
  const runProcessor = processor(repository, agents);

  assert.deepEqual(
    await runProcessor.process(startJob(), { attempt: 1, maxAttempts: 3 }),
    { outcome: "failed" },
  );
  assert.equal(repository.run.status, "FAILED");
  assert.deepEqual(agents.calls, ["Mike", "Emma", "Bob", "Alex", "David", "Sarah"]);
});

test("Sarah output fails when canonical URLs are duplicated", async () => {
  const repository = new MemoryRepository();
  const agents = new ScriptedAgentRuntime(
    outputs({
      bobRoutes: [
        { method: "GET", path: "/", purpose: "Dashboard" },
        { method: "GET", path: "/pricing", purpose: "Pricing" },
      ],
      sarahRouteMetadata: [
        {
          routePath: "/",
          title: "Customer Portal",
          description: "Secure self-service dashboard for customers.",
          canonicalUrl: "https://acme.example/home",
        },
        {
          routePath: "/pricing",
          title: "Pricing",
          description: "Simple plans for teams.",
          canonicalUrl: "https://acme.example/home",
        },
      ],
    }),
  );
  const runProcessor = processor(repository, agents);

  assert.deepEqual(
    await runProcessor.process(startJob(), { attempt: 1, maxAttempts: 3 }),
    { outcome: "failed" },
  );
  assert.equal(repository.run.status, "FAILED");
  assert.deepEqual(agents.calls, ["Mike", "Emma", "Bob", "Alex", "David", "Sarah"]);
});

test("a generated-file CAS conflict preserves the manual revision and fails safely", async () => {
  const repository = new MemoryRepository();
  repository.seedFile({
    path: "app/page.tsx",
    content: "export default function Page() { return <main>Manual edit</main>; }",
    version: 1,
  });
  const agents = new ScriptedAgentRuntime(outputs({ expectedVersion: 0 }));
  const runProcessor = processor(repository, agents);

  assert.deepEqual(
    await runProcessor.process(startJob(), { attempt: 1, maxAttempts: 3 }),
    { outcome: "failed" },
  );
  assert.equal(repository.run.status, "FAILED");
  assert.equal(
    repository.latestFileForTest("app/page.tsx")?.content,
    "export default function Page() { return <main>Manual edit</main>; }",
  );
  assert.equal(repository.latestFileForTest("app/page.tsx")?.version, 1);
});

test("a conflict in a multi-file patch prevents every generated file from being committed", async () => {
  const repository = new MemoryRepository();
  repository.seedFile({
    path: "app/page.tsx",
    content: "export default function Page() { return <main>Manual edit</main>; }",
    version: 1,
  });
  const agents = new ScriptedAgentRuntime(
    outputs({
      alexFiles: [
        {
          path: "app/layout.tsx",
          content: "export default function Layout() { return <html />; }",
          expectedVersion: 0,
        },
        {
          path: "app/page.tsx",
          content: "export default function Page() { return <main>Generated</main>; }",
          expectedVersion: 0,
        },
      ],
    }),
  );
  const runProcessor = processor(repository, agents);

  assert.deepEqual(
    await runProcessor.process(startJob(), { attempt: 1, maxAttempts: 3 }),
    { outcome: "failed" },
  );
  assert.equal(repository.latestFileForTest("app/layout.tsx"), undefined);
  assert.equal(
    repository.latestFileForTest("app/page.tsx")?.content,
    "export default function Page() { return <main>Manual edit</main>; }",
  );
});
