"use client";

import type {
  AgentRunStatus,
  AttachmentUploadIntentResponse,
  FileContentResponse,
  ProjectFileSummary,
  ProjectResponse,
  ProjectAttachment,
  WorkspaceSummary,
  RunActionInput,
  RunAction,
  RunArtifactResponse,
  RunEventEnvelope,
  RunResponse,
} from "@atoms/contracts";
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_PROJECT_ATTACHMENTS,
} from "@atoms/contracts";
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronRight,
  Circle,
  Clock3,
  Code2,
  Database,
  FileCode2,
  FileDiff,
  FlaskConical,
  FolderTree,
  Gauge,
  GitBranch,
  LoaderCircle,
  MonitorPlay,
  Paperclip,
  Pause,
  Play,
  RefreshCcw,
  Rocket,
  Save,
  Search,
  ShieldCheck,
  Square,
  X,
  XCircle,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";

import { createDevelopmentAccessTokenProvider } from "../lib/browser-auth";
import {
  ControlApiClient,
  ControlApiError,
  type ControlApiAccessTokenProvider,
} from "../lib/control-api";
import {
  AGENT_ORDER,
  availableRunActions,
  createWorkspaceProjection,
  isSafePreviewUrl,
  languageForPath,
  reduceRunEvent,
  type AgentName,
  type TaskStatus,
} from "../lib/workspace-state";
import { CodeEditor } from "./code-editor";

const CONTROL_API_URL =
  process.env.NEXT_PUBLIC_CONTROL_API_URL ?? "http://localhost:3001";
const DEVELOPMENT_ACCESS_TOKEN_PROVIDER =
  createDevelopmentAccessTokenProvider({
    nodeEnv: process.env.NODE_ENV,
    configuredToken: process.env.NEXT_PUBLIC_CONTROL_API_ACCESS_TOKEN,
  });
const PREVIEW_BASE_DOMAIN =
  process.env.NEXT_PUBLIC_PREVIEW_BASE_DOMAIN ?? "preview.localhost";
const ACTIVE_RUN_STORAGE_KEY = "atoms.active-run.v1";
const ALLOWED_ATTACHMENT_TYPES = new Set<string>(
  ALLOWED_ATTACHMENT_MIME_TYPES,
);

const WORKSPACE_TABS = [
  { id: "preview", label: "Preview", icon: MonitorPlay },
  { id: "code", label: "Code", icon: Code2 },
  { id: "diff", label: "Diff", icon: FileDiff },
  { id: "tests", label: "Tests", icon: FlaskConical },
  { id: "artifacts", label: "Artifacts", icon: FileCode2 },
  { id: "data", label: "Data", icon: Database },
  { id: "deployments", label: "Deployments", icon: Rocket },
] as const;

type WorkspaceTab = (typeof WORKSPACE_TABS)[number]["id"];
type MobilePane = "agents" | "project";

export interface WorkspaceShellProps {
  readonly accessTokenProvider?: ControlApiAccessTokenProvider;
}

export function WorkspaceShell({
  accessTokenProvider = DEVELOPMENT_ACCESS_TOKEN_PROVIDER,
}: WorkspaceShellProps = {}) {
  const api = useMemo(
    () =>
      new ControlApiClient({
        baseUrl: CONTROL_API_URL,
        accessTokenProvider,
      }),
    [accessTokenProvider],
  );
  const [mobilePane, setMobilePane] = useState<MobilePane>("agents");
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("preview");
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [projectName, setProjectName] = useState("Customer operations portal");
  const [projectSlug, setProjectSlug] = useState("customer-operations-portal");
  const [prompt, setPrompt] = useState(
    "Build a responsive customer operations portal with account summaries, support requests, role-based navigation, Prisma models, API routes, and deterministic tests.",
  );
  const [attachments, setAttachments] = useState<readonly File[]>([]);
  const [attachmentRecords, setAttachmentRecords] = useState<
    readonly ProjectAttachment[]
  >([]);
  const [project, setProject] = useState<ProjectResponse | undefined>();
  const [run, setRun] = useState<RunResponse | undefined>();
  const [projection, setProjection] = useState(createWorkspaceProjection);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<RunAction | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [now, setNow] = useState(() => Date.now());
  const [files, setFiles] = useState<readonly ProjectFileSummary[]>([]);
  const [artifacts, setArtifacts] = useState<readonly RunArtifactResponse[]>([]);
  const [fileSearch, setFileSearch] = useState("");
  const [selectedFile, setSelectedFile] = useState<
    FileContentResponse | undefined
  >();
  const [previousContent, setPreviousContent] = useState<string | undefined>();
  const [editorValue, setEditorValue] = useState("");
  const [saving, setSaving] = useState(false);
  const lastSequenceRef = useRef(0);
  const runRequestRef = useRef<
    { readonly fingerprint: string; readonly idempotencyKey: string } | undefined
  >(undefined);
  const uploadIntentsRef = useRef(
    new Map<string, AttachmentUploadIntentResponse>(),
  );

  useEffect(() => {
    let active = true;
    void api
      .listWorkspaces()
      .then((response) => {
        if (!active) return;
        setWorkspaces(response.items);
        setWorkspaceId((current) =>
          response.items.some((workspace) => workspace.id === current)
            ? current
            : response.items[0]?.id ?? "",
        );
      })
      .catch((caught: unknown) => {
        if (active) setError(`Could not load workspaces: ${toMessage(caught)}`);
      });
    return () => {
      active = false;
    };
  }, [api]);

  const effectiveStatus = projection.inferredRunStatus ?? run?.status;
  const terminal =
    effectiveStatus !== undefined &&
    ["COMPLETED", "FAILED", "CANCELLED"].includes(effectiveStatus);

  const refreshFiles = useCallback(
    async (projectId: string) => {
      try {
        const response = await api.listProjectFiles(projectId);
        setFiles(response.items);
      } catch (caught) {
        setError(toMessage(caught));
      }
    },
    [api],
  );

  const refreshArtifacts = useCallback(
    async (runId: string) => {
      try {
        const response = await api.listRunArtifacts(runId);
        setArtifacts(response.items);
      } catch (caught) {
        setError(toMessage(caught));
      }
    },
    [api],
  );

  useEffect(() => {
    const stored = readActiveRunIds(
      globalThis.localStorage.getItem(ACTIVE_RUN_STORAGE_KEY),
    );
    if (stored === undefined) return;
    const controller = new AbortController();
    void Promise.all([
      api.getProject(stored.projectId, controller.signal),
      api.getRun(stored.runId, controller.signal),
    ])
      .then(([restoredProject, restoredRun]) => {
        if (restoredRun.projectId !== restoredProject.id) {
          throw new Error("Saved project and run identifiers do not match.");
        }
        lastSequenceRef.current = 0;
        setProject(restoredProject);
        setRun(restoredRun);
        setProjection(createWorkspaceProjection());
        setNotice("Restored the durable run and replaying ordered events…");
        void refreshFiles(restoredProject.id);
        void refreshArtifacts(restoredRun.id);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        globalThis.localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
        setError(`Could not restore the saved run: ${toMessage(caught)}`);
      });
    return () => controller.abort();
  }, [api, refreshArtifacts, refreshFiles]);

  useEffect(() => {
    if (run === undefined) return;
    const controller = new AbortController();
    void api
      .streamRunEvents({
        runId: run.id,
        afterSequence: lastSequenceRef.current,
        signal: controller.signal,
        onConnectionChange: setConnected,
        onEvent: (event) => {
          lastSequenceRef.current = Math.max(
            lastSequenceRef.current,
            event.sequence,
          );
          setProjection((current) => reduceRunEvent(current, event));
          if (
            event.eventType === "code_generated" ||
            event.eventType === "task.completed"
          ) {
            void refreshFiles(run.projectId);
          }
          if (event.eventType === "artifact.created") {
            void refreshArtifacts(run.id);
          }
          if (
            event.eventType === "approval.required" ||
            event.eventType === "run.completed" ||
            event.eventType === "run.failed"
          ) {
            void api.getRun(run.id).then(setRun).catch(() => undefined);
          }
        },
      })
      .then(async () => {
        const latest = await api.getRun(run.id);
        setRun(latest);
        setProjection((current) => ({
          ...current,
          inferredRunStatus: latest.status,
        }));
        await refreshArtifacts(run.id);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(toMessage(caught));
      });
    return () => controller.abort();
  }, [api, refreshArtifacts, refreshFiles, run?.id, run?.projectId]);

  useEffect(() => {
    if (run === undefined || terminal) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [run, terminal]);

  async function createProjectRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setNotice(undefined);
    setBusy(true);
    try {
      const createdProject =
        project ??
        (await api.createProject({
          workspaceId,
          name: projectName,
          slug: projectSlug,
          description: "Created from the Atoms developer workspace",
        }));
      setProject(createdProject);
      const attachmentIds: string[] = [];
      for (const [index, file] of attachments.entries()) {
        const existing = attachmentRecords.find(
          (attachment) =>
            attachment.fileName === file.name &&
            attachment.sizeBytes === file.size &&
            ["QUARANTINED", "SCANNING", "CLEAN"].includes(
              attachment.status,
            ),
        );
        if (existing !== undefined) {
          attachmentIds.push(existing.id);
          continue;
        }
        setNotice(
          `Uploading reference ${String(index + 1)} of ${String(attachments.length)} to quarantine…`,
        );
        const identity = attachmentIdentity(file);
        const intent =
          uploadIntentsRef.current.get(identity) ??
          (await api.createAttachmentUploadIntent(createdProject.id, {
            fileName: file.name,
            contentType:
              file.type as (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number],
            sizeBytes: file.size,
          }));
        uploadIntentsRef.current.set(identity, intent);
        setAttachmentRecords((current) =>
          current.some((item) => item.id === intent.attachment.id)
            ? current
            : [...current, intent.attachment],
        );
        const upload = await fetch(intent.upload.url, {
          method: intent.upload.method,
          headers: intent.upload.headers,
          body: file,
          credentials: "omit",
        });
        if (!upload.ok) {
          throw new Error(
            `Object storage rejected ${file.name} (${String(upload.status)}).`,
          );
        }
        const completed = await api.completeAttachmentUpload(
          createdProject.id,
          intent.attachment.id,
          upload.headers.get("etag") ?? undefined,
        );
        setAttachmentRecords((current) =>
          current.map((item) =>
            item.id === completed.id ? completed : item,
          ),
        );
        uploadIntentsRef.current.delete(identity);
        attachmentIds.push(completed.id);
      }

      if (attachmentIds.length > 0) {
        setNotice("References uploaded. Waiting for malware and file-type scans…");
        const clean = await waitForCleanAttachments(
          api,
          createdProject.id,
          attachmentIds,
          setAttachmentRecords,
        );
        setAttachmentRecords(clean);
      }
      const fingerprint = JSON.stringify({
        prompt: prompt.trim(),
        attachmentIds: [...attachmentIds].sort(),
      });
      if (runRequestRef.current?.fingerprint !== fingerprint) {
        runRequestRef.current = {
          fingerprint,
          idempotencyKey: globalThis.crypto.randomUUID(),
        };
      }
      const createdRun = await api.createRun(
        createdProject.id,
        prompt,
        runRequestRef.current.idempotencyKey,
        attachmentIds,
      );
      runRequestRef.current = undefined;
      lastSequenceRef.current = 0;
      setProjection(createWorkspaceProjection());
      setFiles([]);
      setArtifacts([]);
      setSelectedFile(undefined);
      setPreviousContent(undefined);
      setRun(createdRun);
      globalThis.localStorage.setItem(
        ACTIVE_RUN_STORAGE_KEY,
        JSON.stringify({ projectId: createdProject.id, runId: createdRun.id }),
      );
      setNow(Date.now());
      setMobilePane("project");
      setNotice(
        attachmentIds.length === 0
          ? "Durable run created. Listening for ordered events…"
          : "References passed quarantine. Durable run created and listening for ordered events…",
      );
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function selectAttachments(event: ChangeEvent<HTMLInputElement>) {
    const selected = [...(event.target.files ?? [])];
    if (selected.length > MAX_PROJECT_ATTACHMENTS) {
      setError(
        `Choose at most ${String(MAX_PROJECT_ATTACHMENTS)} attachments.`,
      );
      event.target.value = "";
      return;
    }
    const invalid = selected.find(
      (file) =>
        file.size > MAX_ATTACHMENT_BYTES ||
        !ALLOWED_ATTACHMENT_TYPES.has(file.type),
    );
    if (invalid !== undefined) {
      setError(
        `${invalid.name} must be PDF, text, PNG, JPG, or WebP and no larger than 10 MB.`,
      );
      event.target.value = "";
      return;
    }
    setError(undefined);
    uploadIntentsRef.current.clear();
    setAttachmentRecords([]);
    setAttachments(selected);
  }

  async function applyRunAction(action: RunAction) {
    if (run === undefined) return;
    setActionBusy(action);
    setError(undefined);
    try {
      const latest = await api.getRun(run.id);
      if (!availableRunActions(latest.status).includes(action)) {
        setRun(latest);
        throw new Error(
          `${action} is no longer valid because the run is ${latest.status}.`,
        );
      }
      const common = {
        expectedStatus: latest.status,
        expectedControlVersion: latest.controlVersion,
      } as const;
      let input: RunActionInput;
      if (action === "approve") {
        if (projection.approvalScope === undefined) {
          throw new Error(
            "The approval scope is unavailable. Wait for the approval event replay before trying again.",
          );
        }
        input = {
          ...common,
          action,
          approvalScope: projection.approvalScope,
          reason: `Approved ${projection.approvalScope} in the Atoms workspace`,
        };
      } else {
        input = { ...common, action };
      }
      const updated = await api.runAction(run.id, input);
      setRun(updated);
      setProjection((current) => ({
        ...current,
        inferredRunStatus: updated.status,
        ...(action === "approve" || action === "resume"
          ? { approvalReason: undefined, approvalScope: undefined }
          : {}),
      }));
      setNotice(`${capitalize(action)} accepted at control version ${String(updated.controlVersion)}.`);
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setActionBusy(undefined);
    }
  }

  async function openFile(file: ProjectFileSummary) {
    if (project === undefined) return;
    setError(undefined);
    try {
      const [latest, previous] = await Promise.all([
        api.getProjectFile(project.id, file.filePath),
        file.version > 1
          ? api.getProjectFile(project.id, file.filePath, file.version - 1)
          : Promise.resolve(undefined),
      ]);
      setSelectedFile(latest);
      setEditorValue(latest.content);
      setPreviousContent(previous?.content);
    } catch (caught) {
      setError(toMessage(caught));
    }
  }

  async function saveFile() {
    if (project === undefined || selectedFile === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      const saved = await api.putProjectFile(
        project.id,
        selectedFile.filePath,
        editorValue,
        selectedFile.version,
      );
      setPreviousContent(selectedFile.content);
      setSelectedFile(saved);
      setEditorValue(saved.content);
      await refreshFiles(project.id);
      setNotice(`Saved immutable revision v${String(saved.version)}.`);
    } catch (caught) {
      if (
        caught instanceof ControlApiError &&
        caught.code === "PROJECT_FILE_VERSION_CONFLICT"
      ) {
        setError(
          "Conflict detected. Your unsaved editor content was preserved; reload the latest revision before applying it.",
        );
      } else {
        setError(toMessage(caught));
      }
    } finally {
      setSaving(false);
    }
  }

  const filteredFiles = files.filter((file) =>
    file.filePath.toLowerCase().includes(fileSearch.trim().toLowerCase()),
  );
  const completedTasks = AGENT_ORDER.filter(
    (agent) => projection.tasks[agent].status === "completed",
  ).length;
  const progress = Math.round((completedTasks / AGENT_ORDER.length) * 100);
  const previewReady = isSafePreviewUrl(
    projection.preview?.url,
    PREVIEW_BASE_DOMAIN,
  );

  return (
    <main className="min-h-screen">
      <header className="flex h-16 items-center justify-between border-b border-[#1f2733] bg-[#090c12]/95 px-4 backdrop-blur md:px-6">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-xl border border-[#36554b] bg-[#10251e] text-[#78e6bd]">
            <GitBranch aria-hidden="true" size={18} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold tracking-tight">Atoms</span>
              <span className="rounded-full border border-[#2d3948] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#aab5c5]">
                PoC
              </span>
            </div>
            <p className="text-xs text-[#7f8b9d]">Agent application workspace</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${
              connected
                ? "border-[#2f6654] bg-[#10271f] text-[#8af0c9]"
                : "border-[#39414d] bg-[#11161e] text-[#a2adbc]"
            }`}
          >
            <span
              className={`size-1.5 rounded-full ${connected ? "bg-[#78e6bd]" : "bg-[#6f7885]"}`}
              aria-hidden="true"
            />
            {connected ? "SSE live" : "SSE idle"}
          </span>
          <span className="hidden rounded-full border border-[#2b3442] px-2.5 py-1 text-[#98a5b7] sm:inline-flex">
            CAD 4 build target
          </span>
        </div>
      </header>

      <div className="workspace-mobile-toggle grid-cols-2 border-b border-[#1f2733] bg-[#0a0e14] p-2">
        {(["agents", "project"] as const).map((pane) => (
          <button
            key={pane}
            type="button"
            className={`rounded-lg px-3 py-2 text-sm font-medium ${
              mobilePane === pane
                ? "bg-[#1b2b27] text-[#8df1cc]"
                : "text-[#98a5b7]"
            }`}
            aria-pressed={mobilePane === pane}
            onClick={() => setMobilePane(pane)}
          >
            {pane === "agents" ? "Agent Hub" : "Project Workspace"}
          </button>
        ))}
      </div>

      <div className="workspace-grid" data-mobile-pane={mobilePane}>
        <section
          className="workspace-scroll border-r border-[#1f2733] bg-[#090d13] p-4 md:p-5"
          data-pane="agents"
          aria-label="Agent Hub"
        >
          <SectionHeading
            eyebrow="Agent Hub"
            title={run === undefined ? "Create a durable run" : "Build in progress"}
            trailing={
              effectiveStatus === undefined ? undefined : <StatusBadge status={effectiveStatus} />
            }
          />

          {run === undefined ? (
            <form
              className="mt-4 space-y-4 rounded-2xl border border-[#252d3a] bg-[#0d121a] p-4 shadow-2xl shadow-black/20"
              onSubmit={createProjectRun}
            >
              <Field label="Workspace">
                <select
                  className={inputClass}
                  value={workspaceId}
                  onChange={(event) => setWorkspaceId(event.target.value)}
                  required
                  disabled={workspaces.length === 0}
                >
                  {workspaces.length === 0 ? (
                    <option value="">No authorized workspaces</option>
                  ) : (
                    workspaces.map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>
                        {workspace.name} ({workspace.slug})
                      </option>
                    ))
                  )}
                </select>
              </Field>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                <Field label="Project name">
                  <input
                    className={inputClass}
                    value={projectName}
                    maxLength={160}
                    required
                    onChange={(event) => {
                      setProjectName(event.target.value);
                      setProjectSlug(slugify(event.target.value));
                    }}
                  />
                </Field>
                <Field label="Slug">
                  <input
                    className={inputClass}
                    value={projectSlug}
                    maxLength={100}
                    required
                    pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                    onChange={(event) => setProjectSlug(event.target.value)}
                  />
                </Field>
              </div>
              <Field
                label="What should the agents build?"
                hint={`${prompt.length.toLocaleString()} / 100,000 characters`}
              >
                <textarea
                  className={`${inputClass} min-h-40 resize-y leading-6`}
                  value={prompt}
                  maxLength={100_000}
                  required
                  onChange={(event) => setPrompt(event.target.value)}
                />
              </Field>

              <div className="rounded-xl border border-dashed border-[#364151] bg-[#0a0f16] p-3">
                <label className="flex cursor-pointer items-center justify-between gap-3 text-sm font-medium text-[#c8d1de]">
                  <span className="inline-flex items-center gap-2">
                    <Paperclip size={16} aria-hidden="true" />
                    Reference files
                  </span>
                  <span className="rounded-lg border border-[#303a48] px-2.5 py-1 text-xs text-[#a6b1c0]">
                    Choose files
                  </span>
                  <input
                    className="sr-only"
                    type="file"
                    multiple
                    accept=".pdf,.txt,.png,.jpg,.jpeg,.webp"
                    onChange={selectAttachments}
                  />
                </label>
                <p className="mt-2 text-xs leading-5 text-[#7f8b9d]">
                  Up to five files, 10 MB each. Files are uploaded directly to
                  encrypted quarantine storage and scanned before agents can use them.
                </p>
                {attachments.length > 0 ? (
                  <>
                    <ul className="mt-2 space-y-1" aria-label="Selected attachments">
                      {attachments.map((file) => (
                        <li
                          key={`${file.name}-${String(file.lastModified)}`}
                          className="flex items-center justify-between rounded-lg bg-[#111821] px-2.5 py-1.5 text-xs"
                        >
                          <span className="truncate text-[#cbd5e1]">{file.name}</span>
                          <span className="text-[#7f8b9d]">{formatBytes(file.size)}</span>
                          {attachmentRecords.find(
                            (attachment) => attachment.fileName === file.name,
                          )?.status !== undefined ? (
                            <span className="text-[#78e6bd]">
                              {
                                attachmentRecords.find(
                                  (attachment) =>
                                    attachment.fileName === file.name,
                                )?.status
                              }
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      className="mt-2 text-xs font-semibold text-[#9fc5ff] hover:text-[#c3d9ff]"
                      onClick={() => {
                        setAttachments([]);
                        uploadIntentsRef.current.clear();
                        setAttachmentRecords([]);
                      }}
                    >
                      Clear attachments
                    </button>
                  </>
                ) : null}
              </div>

              <button
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#78e6bd] px-4 py-3 text-sm font-bold text-[#06281e] transition hover:bg-[#91efd0] disabled:cursor-not-allowed disabled:opacity-50"
                type="submit"
                disabled={busy}
              >
                {busy ? (
                  <LoaderCircle className="animate-spin" size={17} aria-hidden="true" />
                ) : (
                  <Play size={17} fill="currentColor" aria-hidden="true" />
                )}
                {busy ? "Creating durable run…" : "Plan and build"}
              </button>
            </form>
          ) : (
            <>
              <div className="mt-4 rounded-2xl border border-[#26303e] bg-[#0d131c] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#7f8b9d]">
                      Current task
                    </p>
                    <h2 className="mt-1 text-lg font-semibold">
                      {projection.activeAgent ?? (terminal ? "Run finished" : "Mike is coordinating")}
                    </h2>
                    <p className="mt-1 line-clamp-2 text-sm leading-5 text-[#98a5b7]">
                      {projection.activeAgent === undefined
                        ? run.prompt
                        : projection.tasks[projection.activeAgent].description ?? run.prompt}
                    </p>
                  </div>
                  <div className="grid size-11 shrink-0 place-items-center rounded-xl border border-[#315347] bg-[#10241e] font-semibold text-[#8af0c9]">
                    {(projection.activeAgent ?? "M").slice(0, 1)}
                  </div>
                </div>
              </div>

              <div className="mt-4 rounded-2xl border border-[#252d3a] bg-[#0c1118] p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Dependency graph</h3>
                  <span className="text-xs tabular-nums text-[#8f9bad]">
                    {completedTasks}/{AGENT_ORDER.length}
                  </span>
                </div>
                <ol className="mt-4 space-y-1">
                  {AGENT_ORDER.map((agent, index) => (
                    <AgentRow
                      key={agent}
                      agent={agent}
                      status={projection.tasks[agent].status}
                      description={projection.tasks[agent].description}
                      last={index === AGENT_ORDER.length - 1}
                    />
                  ))}
                </ol>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <MetricCard icon={Gauge} label="Progress" value={`${String(progress)}%`}>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#202936]">
                    <div
                      className="h-full rounded-full bg-[#78e6bd]"
                      style={{ width: `${String(progress)}%` }}
                    />
                  </div>
                </MetricCard>
                <MetricCard
                  icon={Clock3}
                  label="Elapsed"
                  value={formatElapsed(run, now)}
                />
                <MetricCard icon={ShieldCheck} label="Budget" value="CAD 4 max">
                  <p className="mt-1 text-[11px] leading-4 text-[#7f8b9d]">
                    Usage is metered server-side; a public cost endpoint is not yet exposed.
                  </p>
                </MetricCard>
                <MetricCard
                  icon={Activity}
                  label="Events"
                  value={String(projection.events.length)}
                />
              </div>

              {projection.approvalReason !== undefined ? (
                <div className="mt-4 rounded-2xl border border-[#6d5a32] bg-[#211b0f] p-4" role="alert">
                  <div className="flex gap-3">
                    <AlertTriangle className="mt-0.5 shrink-0 text-[#f4c76b]" size={18} aria-hidden="true" />
                    <div>
                      <h3 className="font-semibold text-[#ffe1a4]">Approval required</h3>
                      <p className="mt-1 text-sm leading-5 text-[#d1bd92]">
                        {projection.approvalReason}
                      </p>
                      <button
                        className="mt-3 inline-flex items-center gap-2 rounded-lg bg-[#f4c76b] px-3 py-2 text-xs font-bold text-[#2c210b] disabled:opacity-60"
                        type="button"
                        disabled={actionBusy !== undefined}
                        onClick={() => void applyRunAction("approve")}
                      >
                        {actionBusy === "approve" ? (
                          <LoaderCircle className="animate-spin" size={14} />
                        ) : (
                          <Check size={14} />
                        )}
                        Approve {projection.approvalScope ?? "request"}
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              <RunControls
                status={effectiveStatus ?? run.status}
                requiresApproval={projection.approvalReason !== undefined}
                busy={actionBusy}
                onAction={(action) => void applyRunAction(action)}
              />

              <div className="mt-4 rounded-2xl border border-[#252d3a] bg-[#0c1118] p-4">
                <h3 className="text-sm font-semibold">Activity history</h3>
                {projection.events.length === 0 ? (
                  <EmptyInline text="Waiting for the first durable event…" />
                ) : (
                  <ol className="mt-3 max-h-72 space-y-1 overflow-auto pr-1">
                    {[...projection.events].reverse().map((event) => (
                      <li
                        key={event.sequence}
                        className="flex items-start gap-2 rounded-lg px-2 py-2 text-xs hover:bg-[#111821]"
                      >
                        <span className="w-7 shrink-0 font-mono text-[#687587]">
                          {String(event.sequence).padStart(3, "0")}
                        </span>
                        <span className="min-w-0 flex-1 text-[#c0cad8]">
                          {humanizeEvent(event)}
                        </span>
                        <time className="shrink-0 text-[#657183]" dateTime={event.occurredAt}>
                          {new Date(event.occurredAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </time>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </>
          )}

          <div className="sr-only" aria-live="polite" aria-atomic="true">
            {notice ?? error ?? (effectiveStatus === undefined ? "Ready" : `Run ${effectiveStatus}`)}
          </div>
          {error !== undefined ? <Feedback kind="error" message={error} onClose={() => setError(undefined)} /> : null}
          {notice !== undefined ? <Feedback kind="notice" message={notice} onClose={() => setNotice(undefined)} /> : null}
        </section>

        <section className="workspace-scroll bg-[#080b10]" data-pane="project" aria-label="Project Workspace">
          <div className="sticky top-0 z-20 border-b border-[#202734] bg-[#0a0e14]/95 px-3 pt-3 backdrop-blur md:px-5">
            <div className="flex items-start justify-between gap-3 pb-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#708096]">
                  Project workspace
                </p>
                <h1 className="mt-0.5 truncate text-lg font-semibold">
                  {project?.name ?? "No project yet"}
                </h1>
              </div>
              {project !== undefined ? (
                <div className="hidden text-right text-xs text-[#768397] sm:block">
                  <p className="font-mono">{project.slug}</p>
                  <p className="mt-1">immutable revisions enabled</p>
                </div>
              ) : null}
            </div>
            <div
              className="flex gap-1 overflow-x-auto pb-2"
              role="tablist"
              aria-label="Project workspace views"
            >
              {WORKSPACE_TABS.map((tab) => {
                const Icon = tab.icon;
                const selected = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    id={`tab-${tab.id}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={`panel-${tab.id}`}
                    tabIndex={selected ? 0 : -1}
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition ${
                      selected
                        ? "bg-[#1a2925] text-[#8df1cc]"
                        : "text-[#8995a6] hover:bg-[#111720] hover:text-[#d7dee8]"
                    }`}
                    onClick={() => setActiveTab(tab.id)}
                  >
                    <Icon size={14} aria-hidden="true" />
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="p-4 md:p-5">
            <div
              id={`panel-${activeTab}`}
              role="tabpanel"
              aria-labelledby={`tab-${activeTab}`}
            >
              {activeTab === "preview" ? (
                <PreviewPanel
                  preview={projection.preview}
                  safe={previewReady}
                  hasRun={run !== undefined}
                />
              ) : null}
              {activeTab === "code" ? (
                <CodePanel
                  files={filteredFiles}
                  totalFiles={files.length}
                  query={fileSearch}
                  selectedFile={selectedFile}
                  editorValue={editorValue}
                  saving={saving}
                  onQuery={setFileSearch}
                  onOpen={(file) => void openFile(file)}
                  onEditorChange={setEditorValue}
                  onSave={() => void saveFile()}
                />
              ) : null}
              {activeTab === "diff" ? (
                <DiffPanel selectedFile={selectedFile} previousContent={previousContent} />
              ) : null}
              {activeTab === "tests" ? (
                <TestsPanel validations={projection.validations} />
              ) : null}
              {activeTab === "artifacts" ? (
                <ArtifactsPanel artifacts={artifacts} />
              ) : null}
              {activeTab === "data" ? <DataPanel database={projection.database} /> : null}
              {activeTab === "deployments" ? <DeploymentsPanel /> : null}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function PreviewPanel({
  preview,
  safe,
  hasRun,
}: {
  readonly preview: ReturnType<typeof createWorkspaceProjection>["preview"];
  readonly safe: boolean;
  readonly hasRun: boolean;
}) {
  if (preview?.status === "READY" && preview.url !== undefined && safe) {
    return (
      <div className="overflow-hidden rounded-2xl border border-[#26303d] bg-white shadow-2xl shadow-black/30">
        <div className="flex items-center justify-between border-b border-[#d7dce3] bg-[#f4f6f8] px-3 py-2 text-xs text-[#4c5665]">
          <div className="flex items-center gap-1.5" aria-hidden="true">
            <span className="size-2 rounded-full bg-[#ff6f75]" />
            <span className="size-2 rounded-full bg-[#f2c45f]" />
            <span className="size-2 rounded-full bg-[#62cc8c]" />
          </div>
          <span className="max-w-[70%] truncate font-mono">{preview.url}</span>
          <ShieldCheck size={14} aria-label="Signed isolated preview" />
        </div>
        <iframe
          className="preview-frame"
          src={preview.url}
          title="Generated application preview"
          sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
          referrerPolicy="no-referrer"
          allow="clipboard-read; clipboard-write"
        />
      </div>
    );
  }
  if (preview?.status === "READY" && !safe) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="Preview origin rejected"
        description="The URL did not match the configured signed preview domain, so it was not embedded."
      />
    );
  }
  return (
    <EmptyState
      icon={MonitorPlay}
      title={hasRun ? "Preview is not ready yet" : "Your generated app will appear here"}
      description={
        hasRun
          ? "Atoms starts the isolated iframe only after install, Prisma validation, lint, type-check, tests, build, and health checks pass."
          : "Create a project and start a run to stream a real E2B-backed preview."
      }
    />
  );
}

function CodePanel({
  files,
  totalFiles,
  query,
  selectedFile,
  editorValue,
  saving,
  onQuery,
  onOpen,
  onEditorChange,
  onSave,
}: {
  readonly files: readonly ProjectFileSummary[];
  readonly totalFiles: number;
  readonly query: string;
  readonly selectedFile: FileContentResponse | undefined;
  readonly editorValue: string;
  readonly saving: boolean;
  readonly onQuery: (value: string) => void;
  readonly onOpen: (file: ProjectFileSummary) => void;
  readonly onEditorChange: (value: string) => void;
  readonly onSave: () => void;
}) {
  return (
    <div className="file-tree-grid overflow-hidden rounded-2xl border border-[#252d3a] bg-[#0b1017]">
      <aside className="border-b border-[#252d3a] bg-[#0d121a] p-3 lg:border-r lg:border-b-0">
        <label className="relative block">
          <Search className="absolute left-3 top-2.5 text-[#6f7c8d]" size={14} aria-hidden="true" />
          <span className="sr-only">Search generated files</span>
          <input
            className="w-full rounded-lg border border-[#2a3442] bg-[#090d13] py-2 pr-3 pl-9 text-xs text-[#d8e0ea] placeholder:text-[#657184]"
            value={query}
            placeholder="Search files"
            onChange={(event) => onQuery(event.target.value)}
          />
        </label>
        <div className="mt-3 flex items-center justify-between px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6f7d90]">
          <span>Files</span>
          <span>{totalFiles}</span>
        </div>
        {files.length === 0 ? (
          <EmptyInline text={totalFiles === 0 ? "Files appear after Alex commits a revision." : "No matching files."} />
        ) : (
          <ul className="mt-2 max-h-72 space-y-0.5 overflow-auto lg:max-h-[590px]">
            {files.map((file) => (
              <li key={file.filePath}>
                <button
                  type="button"
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs ${
                    selectedFile?.filePath === file.filePath
                      ? "bg-[#193028] text-[#91efd0]"
                      : "text-[#aeb9c8] hover:bg-[#141b25]"
                  }`}
                  onClick={() => onOpen(file)}
                >
                  <FileCode2 className="shrink-0" size={14} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{file.filePath}</span>
                  <span className="text-[10px] text-[#718095]">v{file.version}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <div className="min-w-0 p-3">
        {selectedFile === undefined ? (
          <EmptyState
            icon={FolderTree}
            title="Select a file"
            description="The editor loads only a selected immutable revision. Saving appends a new version with compare-and-swap protection."
            compact
          />
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-mono text-xs text-[#c7d0dd]">{selectedFile.filePath}</p>
                <p className="mt-1 text-[11px] text-[#6f7d90]">Revision v{selectedFile.version}</p>
              </div>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#78e6bd] px-3 py-2 text-xs font-bold text-[#06281e] disabled:cursor-not-allowed disabled:opacity-45"
                disabled={saving || editorValue === selectedFile.content}
                onClick={onSave}
              >
                {saving ? <LoaderCircle className="animate-spin" size={14} /> : <Save size={14} />}
                Save revision
              </button>
            </div>
            <CodeEditor
              path={selectedFile.filePath}
              language={languageForPath(selectedFile.filePath)}
              value={editorValue}
              onChange={onEditorChange}
            />
          </>
        )}
      </div>
    </div>
  );
}

function DiffPanel({
  selectedFile,
  previousContent,
}: {
  readonly selectedFile: FileContentResponse | undefined;
  readonly previousContent: string | undefined;
}) {
  if (selectedFile === undefined) {
    return <EmptyState icon={FileDiff} title="No file selected" description="Select a file in Code to compare its latest two immutable revisions." />;
  }
  if (previousContent === undefined) {
    return <EmptyState icon={FileDiff} title="First revision" description={`${selectedFile.filePath} has no earlier revision to compare.`} />;
  }
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div>
        <p className="mb-2 text-xs font-semibold text-[#8f9bad]">Previous · v{selectedFile.version - 1}</p>
        <CodeEditor path={`previous/${selectedFile.filePath}`} language={languageForPath(selectedFile.filePath)} value={previousContent} readOnly />
      </div>
      <div>
        <p className="mb-2 text-xs font-semibold text-[#8f9bad]">Current · v{selectedFile.version}</p>
        <CodeEditor path={`current/${selectedFile.filePath}`} language={languageForPath(selectedFile.filePath)} value={selectedFile.content} readOnly />
      </div>
    </div>
  );
}

function TestsPanel({ validations }: { readonly validations: ReturnType<typeof createWorkspaceProjection>["validations"] }) {
  if (validations.length === 0) {
    return <EmptyState icon={FlaskConical} title="Validation has not started" description="Deterministic command evidence will appear here in pipeline order." />;
  }
  return (
    <div className="space-y-3">
      {validations.map((validation, index) => (
        <details key={validation.step} className="group rounded-xl border border-[#26303d] bg-[#0d1219]" open={validation.status === "FAILED"}>
          <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
            <span className={`grid size-7 place-items-center rounded-lg ${validation.status === "SUCCEEDED" ? "bg-[#10291f] text-[#78e6bd]" : "bg-[#35171c] text-[#ff8a96]"}`}>
              {validation.status === "SUCCEEDED" ? <Check size={15} /> : <XCircle size={15} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{String(index + 1).padStart(2, "0")} · {validation.step}</span>
              <span className="mt-0.5 block text-xs text-[#788598]">exit {validation.exitCode} · {formatDuration(validation.durationMs)}</span>
            </span>
            <ChevronRight className="text-[#657286] transition group-open:rotate-90" size={16} />
          </summary>
          <div className="border-t border-[#202936] p-3">
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-[#070a0f] p-3 font-mono text-xs leading-5 text-[#aeb9c8]">{validation.stdout || validation.stderr || "Command completed without output."}</pre>
          </div>
        </details>
      ))}
    </div>
  );
}

function ArtifactsPanel({
  artifacts,
}: {
  readonly artifacts: readonly RunArtifactResponse[];
}) {
  if (artifacts.length === 0) {
    return (
      <EmptyState
        icon={FileCode2}
        title="No artifacts yet"
        description="Typed agent outputs, SEO packages, and content packages appear here as soon as they are committed."
      />
    );
  }
  return (
    <div className="space-y-3">
      {artifacts.map((artifact) => (
        <details
          key={`${String(artifact.sequence)}:${artifact.payload.artifactType}`}
          className="group rounded-xl border border-[#26303d] bg-[#0d1219]"
          open={
            artifact.payload.artifactType === "seo-package" ||
            artifact.payload.artifactType === "content-package"
          }
        >
          <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
            <span className="grid size-7 place-items-center rounded-lg bg-[#10291f] text-[#78e6bd]">
              <FileCode2 size={15} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">
                {artifact.payload.artifactType}
              </span>
              <span className="mt-0.5 block text-xs text-[#788598]">
                {artifact.payload.agent} · event {String(artifact.sequence)}
              </span>
            </span>
            <ChevronRight className="text-[#657286] transition group-open:rotate-90" size={16} />
          </summary>
          <div className="border-t border-[#202936] p-3">
            <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg bg-[#070a0f] p-3 font-mono text-xs leading-5 text-[#aeb9c8]">
              {artifact.content === null
                ? "Artifact content is unavailable for this historical event."
                : JSON.stringify(artifact.content, null, 2)}
            </pre>
          </div>
        </details>
      ))}
    </div>
  );
}

function DataPanel({ database }: { readonly database: ReturnType<typeof createWorkspaceProjection>["database"] }) {
  if (database === undefined) {
    return <EmptyState icon={Database} title="No generated database" description="David can produce a migration artifact, but provisioning remains lazy and requires an explicit confirmed API action." />;
  }
  return (
    <div className="rounded-2xl border border-[#26303d] bg-[#0d1219] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#728095]">Supabase adapter</p>
          <h2 className="mt-1 text-xl font-semibold">{database.status}</h2>
        </div>
        <span className="rounded-full border border-[#305345] bg-[#10251e] px-2.5 py-1 text-xs text-[#8cefc9]">operation v{database.operationVersion}</span>
      </div>
      <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
        <DataItem label="Database ID" value={database.databaseInstanceId} mono />
        <DataItem label="Credentials" value="Opaque vault reference only" />
      </dl>
      {database.message !== undefined ? <p className="mt-4 rounded-xl bg-[#111923] p-3 text-sm leading-6 text-[#aeb9c8]">{database.message}</p> : null}
    </div>
  );
}

function DeploymentsPanel() {
  return <EmptyState icon={Rocket} title="Deployment is confirmation-gated" description="Vercel export, rollback, GitHub sync, billing, and custom domains remain later roadmap slices. No production action is available without a confirmation screen." />;
}

function RunControls({ status, requiresApproval, busy, onAction }: { readonly status: AgentRunStatus; readonly requiresApproval: boolean; readonly busy: RunAction | undefined; readonly onAction: (action: RunAction) => void }) {
  const actions = availableRunActions(status).filter(
    (action) =>
      action !== "approve" && !(requiresApproval && action === "resume"),
  );
  if (actions.length === 0) return null;
  return (
    <div className="mt-4 flex flex-wrap gap-2" aria-label="Run controls">
      {actions.map((action) => {
        const Icon = actionIcon(action);
        const danger = action === "cancel";
        return (
          <button key={action} type="button" disabled={busy !== undefined} onClick={() => onAction(action)} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold disabled:opacity-50 ${danger ? "border-[#5b3036] bg-[#241216] text-[#ff9ca5]" : "border-[#303a48] bg-[#111720] text-[#c7d0dd] hover:bg-[#17202b]"}`}>
            {busy === action ? <LoaderCircle className="animate-spin" size={14} /> : <Icon size={14} />}
            {capitalize(action)}
          </button>
        );
      })}
    </div>
  );
}

function AgentRow({ agent, status, description, last }: { readonly agent: AgentName; readonly status: TaskStatus; readonly description: string | undefined; readonly last: boolean }) {
  return (
    <li className="relative flex gap-3 pb-3 last:pb-0">
      {!last ? <span className="absolute top-7 bottom-0 left-[13px] w-px bg-[#26303d]" aria-hidden="true" /> : null}
      <TaskIcon status={status} />
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-[#d9e0e9]">{agent}</span>
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6f7d90]">{status}</span>
        </div>
        <p className="mt-0.5 truncate text-xs text-[#758296]">{description ?? agentRole(agent)}</p>
      </div>
    </li>
  );
}

function TaskIcon({ status }: { readonly status: TaskStatus }) {
  const className = "relative z-10 grid size-7 shrink-0 place-items-center rounded-full border";
  if (status === "completed") return <span className={`${className} border-[#356955] bg-[#123024] text-[#83edc5]`}><Check size={14} /></span>;
  if (status === "running") return <span className={`${className} border-[#376a58] bg-[#11291f] text-[#83edc5]`}><LoaderCircle className="animate-spin" size={14} /></span>;
  if (status === "failed") return <span className={`${className} border-[#6a343c] bg-[#2b151a] text-[#ff8f9b]`}><X size={14} /></span>;
  if (status === "waiting") return <span className={`${className} border-[#745f31] bg-[#281f0e] text-[#f4c76b]`}><Pause size={13} /></span>;
  return <span className={`${className} border-[#2b3543] bg-[#0d131b] text-[#5f6d80]`}><Circle size={9} /></span>;
}

function StatusBadge({ status }: { readonly status: AgentRunStatus }) {
  const tone = status === "COMPLETED" ? "border-[#315c4b] bg-[#10271f] text-[#8cefc9]" : status === "FAILED" || status === "CANCELLED" ? "border-[#5c3037] bg-[#251318] text-[#ff9ca6]" : status === "PAUSED" ? "border-[#66552e] bg-[#231d0f] text-[#f1ca78]" : "border-[#304965] bg-[#111d2b] text-[#9fc5ff]";
  return <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-[0.1em] ${tone}`}>{status}</span>;
}

function SectionHeading({ eyebrow, title, trailing }: { readonly eyebrow: string; readonly title: string; readonly trailing?: React.ReactNode }) {
  return <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#728095]">{eyebrow}</p><h1 className="mt-1 text-xl font-semibold tracking-tight">{title}</h1></div>{trailing}</div>;
}

function Field({ label, hint, children }: { readonly label: string; readonly hint?: string; readonly children: React.ReactNode }) {
  return <label className="block"><span className="mb-1.5 flex items-center justify-between gap-3 text-xs font-semibold text-[#b8c2cf]"><span>{label}</span>{hint !== undefined ? <span className="font-normal text-[#6e7a8c]">{hint}</span> : null}</span>{children}</label>;
}

function MetricCard({ icon: Icon, label, value, children }: { readonly icon: typeof Gauge; readonly label: string; readonly value: string; readonly children?: React.ReactNode }) {
  return <div className="rounded-xl border border-[#242d3a] bg-[#0d131b] p-3"><div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#718095]"><Icon size={13} />{label}</div><p className="mt-1.5 text-lg font-semibold tabular-nums">{value}</p>{children}</div>;
}

function DataItem({ label, value, mono = false }: { readonly label: string; readonly value: string; readonly mono?: boolean }) {
  return <div className="rounded-xl border border-[#222b37] bg-[#0a0f16] p-3"><dt className="text-xs text-[#748195]">{label}</dt><dd className={`mt-1 break-all text-[#cbd4df] ${mono ? "font-mono text-xs" : ""}`}>{value}</dd></div>;
}

function EmptyState({ icon: Icon, title, description, compact = false }: { readonly icon: typeof MonitorPlay; readonly title: string; readonly description: string; readonly compact?: boolean }) {
  return <div className={`grid place-items-center rounded-2xl border border-dashed border-[#2a3442] bg-[#0b1017] px-6 text-center ${compact ? "min-h-[420px]" : "min-h-[600px]"}`}><div className="max-w-md"><span className="mx-auto grid size-12 place-items-center rounded-2xl border border-[#2c3f3a] bg-[#10221d] text-[#78e6bd]"><Icon size={22} /></span><h2 className="mt-4 text-lg font-semibold">{title}</h2><p className="mt-2 text-sm leading-6 text-[#8996a8]">{description}</p></div></div>;
}

function EmptyInline({ text }: { readonly text: string }) {
  return <p className="mt-3 rounded-lg bg-[#0a0f16] px-3 py-4 text-center text-xs leading-5 text-[#718095]">{text}</p>;
}

function Feedback({ kind, message, onClose }: { readonly kind: "error" | "notice"; readonly message: string; readonly onClose: () => void }) {
  return <div className={`fixed right-4 bottom-4 z-50 flex max-w-md items-start gap-3 rounded-xl border p-3 shadow-2xl ${kind === "error" ? "border-[#68363d] bg-[#2a151a] text-[#ffc0c6]" : "border-[#315c4b] bg-[#11271f] text-[#aff6d9]"}`} role={kind === "error" ? "alert" : "status"}><span className="mt-0.5">{kind === "error" ? <AlertTriangle size={16} /> : <Check size={16} />}</span><p className="min-w-0 flex-1 text-sm leading-5">{message}</p><button type="button" className="rounded p-0.5 opacity-75 hover:opacity-100" aria-label="Dismiss message" onClick={onClose}><X size={15} /></button></div>;
}

const inputClass = "w-full rounded-xl border border-[#2a3442] bg-[#090d13] px-3 py-2.5 text-sm text-[#e5ebf2] placeholder:text-[#5f6d80] focus:border-[#4c8e77]";

async function waitForCleanAttachments(
  api: ControlApiClient,
  projectId: string,
  attachmentIds: readonly string[],
  onUpdate: (attachments: readonly ProjectAttachment[]) => void,
): Promise<readonly ProjectAttachment[]> {
  const expected = new Set(attachmentIds);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await api.listProjectAttachments(projectId);
    const selected = response.items.filter((item) => expected.has(item.id));
    onUpdate(selected);
    const failed = selected.find((item) =>
      ["REJECTED", "FAILED", "EXPIRED"].includes(item.status),
    );
    if (failed !== undefined) {
      throw new Error(
        `${failed.fileName} did not pass quarantine (${failed.failureCode ?? failed.status}).`,
      );
    }
    if (
      selected.length === attachmentIds.length &&
      selected.every((item) => item.status === "CLEAN")
    ) {
      return selected;
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 750));
  }
  throw new Error("Attachment scanning did not finish within two minutes.");
}

function toMessage(error: unknown): string {
  if (error instanceof ControlApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 100) || "new-project";
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function formatBytes(value: number): string {
  return value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentIdentity(file: File): string {
  return `${file.name}:${String(file.size)}:${String(file.lastModified)}`;
}

function formatDuration(value: number): string {
  return value < 1_000 ? `${String(value)} ms` : `${(value / 1_000).toFixed(1)} s`;
}

function formatElapsed(run: RunResponse, now: number): string {
  const start = new Date(run.startedAt ?? run.createdAt).getTime();
  const end = run.completedAt === null ? run.cancelledAt === null ? now : new Date(run.cancelledAt).getTime() : new Date(run.completedAt).getTime();
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function agentRole(agent: AgentName): string {
  return {
    Mike: "Coordinates policies and approvals",
    Emma: "Produces structured product requirements",
    Bob: "Designs architecture and Prisma schema",
    Alex: "Generates application code and tests",
    David: "Creates database migrations and policy report",
    Sarah: "Builds route-aware SEO artifacts",
    Adrian: "Creates evidence-aware growth content",
  }[agent];
}

function actionIcon(action: RunAction) {
  return action === "pause" ? Pause : action === "cancel" ? Square : action === "retry" ? RefreshCcw : Play;
}

function humanizeEvent(event: RunEventEnvelope): string {
  const payload =
    typeof event.payload === "object" &&
    event.payload !== null &&
    !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : {};
  const agent = typeof payload.agent === "string" ? ` · ${payload.agent}` : "";
  const step = typeof payload.step === "string" ? ` · ${payload.step}` : "";
  return `${event.eventType.replaceAll("_", " ")}${agent}${step}`;
}

function readActiveRunIds(
  value: string | null,
): { readonly projectId: string; readonly runId: string } | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return typeof parsed.projectId === "string" && typeof parsed.runId === "string"
      ? { projectId: parsed.projectId, runId: parsed.runId }
      : undefined;
  } catch {
    return undefined;
  }
}
