"use client";

import type { WorkspaceAdminProjectsResponse, WorkspaceSummary } from "@atoms/contracts";
import { AlertTriangle, ArrowLeft, LoaderCircle, LogOut, RefreshCw, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  describeListCoverage,
  describeRunStatus,
  formatAdminTimestamp,
  formatRunDuration,
  type RunTone,
} from "../lib/admin-projects";
import { ControlApiClient, ControlApiError } from "../lib/control-api";
import { AuthenticatedPage, type AuthenticatedSession } from "./authenticated-page";

const CONTROL_API_URL =
  process.env.NEXT_PUBLIC_CONTROL_API_URL ?? "http://localhost:3001";

const TONE_CLASS: Record<RunTone, string> = {
  active: "border-[#3d5a86] bg-[#101b2d] text-[#9cc1ff]",
  done: "border-[#36554b] bg-[#10251e] text-[#78e6bd]",
  problem: "border-[#67333a] bg-[#1c1014] text-[#ff9ca6]",
  idle: "border-[#252d3a] bg-[#0d121a] text-[#98a5b7]",
};

type LoadState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly data: WorkspaceAdminProjectsResponse }
  | { readonly kind: "forbidden" }
  | { readonly kind: "error"; readonly message: string };

export function AdminProjectsPage() {
  return (
    <AuthenticatedPage
      title="Admin"
      signInPrompt="Sign in with Microsoft Entra to see every project in your workspace."
    >
      {(session) => <AdminProjectsSurface session={session} />}
    </AuthenticatedPage>
  );
}

function AdminProjectsSurface({ session }: { readonly session: AuthenticatedSession }) {
  const api = useMemo(
    () =>
      new ControlApiClient({
        baseUrl: CONTROL_API_URL,
        accessTokenProvider: session.accessTokenProvider,
      }),
    [session.accessTokenProvider],
  );
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [workspaceError, setWorkspaceError] = useState<string | undefined>();
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let active = true;
    void api
      .listWorkspaces()
      .then((response) => {
        if (!active) return;
        setWorkspaces(response.items);
        setWorkspaceId((current) => current || response.items[0]?.id || "");
        setWorkspacesLoaded(true);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setWorkspaceError(`Could not load workspaces: ${describeError(caught)}`);
        setWorkspacesLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [api]);

  const load = useCallback(() => setReloads((count) => count + 1), []);

  useEffect(() => {
    if (workspaceId === "") {
      setState({ kind: "idle" });
      return;
    }
    let active = true;
    setState({ kind: "loading" });
    void api
      .getWorkspaceAdminProjects(workspaceId)
      .then((data) => {
        if (active) setState({ kind: "loaded", data });
      })
      .catch((caught: unknown) => {
        if (!active) return;
        // 403: signed in but not an owner/admin. 404: the workspace is not theirs.
        // Neither is an app failure, so neither is shown as an error.
        if (caught instanceof ControlApiError && (caught.status === 403 || caught.status === 404)) {
          setState({ kind: "forbidden" });
          return;
        }
        setState({ kind: "error", message: describeError(caught) });
      });
    return () => {
      active = false;
    };
  }, [api, workspaceId, reloads]);

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-8 text-white">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <a
            className="inline-flex items-center gap-1.5 text-xs text-[#98a5b7] hover:text-white"
            href="/"
          >
            <ArrowLeft size={13} aria-hidden="true" />
            Back to workspace
          </a>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Admin · Projects</h1>
        </div>
        <div className="flex items-center gap-2 text-xs text-[#98a5b7]">
          <span>{session.identityLabel}</span>
          {session.onSignOut !== undefined ? (
            <button
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#252d3a] px-2.5 py-1.5 hover:text-white disabled:opacity-60"
              type="button"
              disabled={session.signingOut}
              onClick={session.onSignOut}
            >
              <LogOut size={13} aria-hidden="true" />
              Sign out
            </button>
          ) : null}
        </div>
      </header>

      <section className="mt-6 flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs text-[#98a5b7]">
          Workspace
          <select
            className="min-w-56 rounded-xl border border-[#252d3a] bg-[#0d121a] px-3 py-2 text-sm text-white"
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
            disabled={workspaces.length === 0}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name} ({workspace.slug})
              </option>
            ))}
          </select>
        </label>
        <button
          className="inline-flex items-center gap-2 rounded-xl border border-[#252d3a] px-3 py-2 text-sm hover:text-[#78e6bd] disabled:opacity-50"
          type="button"
          onClick={load}
          disabled={workspaceId === "" || state.kind === "loading"}
        >
          <RefreshCw size={14} className={state.kind === "loading" ? "animate-spin" : ""} aria-hidden="true" />
          Refresh
        </button>
      </section>

      <section className="mt-5" aria-live="polite">
        {workspaceError !== undefined ? <Notice tone="error" text={workspaceError} /> : null}
        {workspacesLoaded && workspaces.length === 0 && workspaceError === undefined ? (
          <Notice tone="info" text="You do not belong to any workspace yet." />
        ) : null}
        {!workspacesLoaded || state.kind === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-[#98a5b7]">
            <LoaderCircle className="animate-spin text-[#78e6bd]" size={16} aria-hidden="true" />
            Loading projects…
          </p>
        ) : null}
        {state.kind === "forbidden" ? (
          <div className="flex items-start gap-3 rounded-2xl border border-[#4d4426] bg-[#1b180e] p-4 text-sm text-[#e6d08a]" role="status">
            <ShieldAlert size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
            <p>Only workspace owners and admins can see this page. Ask an owner or admin of this workspace for access.</p>
          </div>
        ) : null}
        {state.kind === "error" ? <Notice tone="error" text={`Could not load projects: ${state.message}`} /> : null}
        {state.kind === "loaded" ? <ProjectsTable data={state.data} /> : null}
      </section>
    </main>
  );
}

function ProjectsTable({ data }: { readonly data: WorkspaceAdminProjectsResponse }) {
  return (
    <div>
      <p className="mb-3 text-sm text-[#98a5b7]">
        {data.workspace.name} · {describeListCoverage(data.projects.length, data.total)}
      </p>
      {data.projects.length === 0 ? null : (
        <div className="overflow-x-auto rounded-2xl border border-[#252d3a] bg-[#0b0f16]">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-[#718095]">
              <tr className="border-b border-[#252d3a]">
                <th className="px-4 py-3 font-medium">Project</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Latest run</th>
                <th className="px-4 py-3 font-medium">Runs</th>
                <th className="px-4 py-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {data.projects.map((project) => {
                const status =
                  project.latestRun === null
                    ? undefined
                    : describeRunStatus(project.latestRun.status);
                const duration =
                  project.latestRun === null ? undefined : formatRunDuration(project.latestRun);
                return (
                  <tr key={project.id} className="border-b border-[#1a2230] last:border-0">
                    <td className="px-4 py-3">
                      <p className="font-medium text-white">{project.name}</p>
                      <p className="mt-0.5 font-mono text-[11px] text-[#718095]">{project.slug}</p>
                    </td>
                    <td className="px-4 py-3 text-[#c7d0dd]">
                      {project.projectType === "CLIENT_PORTAL" ? "Client portal" : "General"}
                    </td>
                    <td className="px-4 py-3">
                      {status === undefined || project.latestRun === null ? (
                        <span className="text-[#718095]">No runs</span>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASS[status.tone]}`}
                          >
                            {status.label}
                          </span>
                          {duration !== undefined ? (
                            <span className="text-xs text-[#98a5b7]">{duration}</span>
                          ) : null}
                          <span className="font-mono text-[11px] text-[#718095]">
                            {project.latestRun.id.slice(0, 8)}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-[#c7d0dd]">{project.runCount}</td>
                    <td className="px-4 py-3 text-xs text-[#98a5b7]">
                      {formatAdminTimestamp(project.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Notice({ tone, text }: { readonly tone: "error" | "info"; readonly text: string }) {
  const classes =
    tone === "error"
      ? "border-[#67333a] bg-[#1c1014] text-[#ff9ca6]"
      : "border-[#252d3a] bg-[#0d121a] text-[#98a5b7]";
  return (
    <div className={`mb-3 flex items-start gap-2 rounded-xl border px-3 py-2 text-sm ${classes}`} role={tone === "error" ? "alert" : "status"}>
      <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
      <p>{text}</p>
    </div>
  );
}

function describeError(caught: unknown): string {
  return caught instanceof Error ? caught.message : "unexpected error";
}
