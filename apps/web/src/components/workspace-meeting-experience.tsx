"use client";

import type {
  CreateMeetingInput,
  MeetingResponse,
  WorkspaceSummary,
} from "@atoms/contracts";
import {
  AlertTriangle,
  ArrowLeft,
  LoaderCircle,
  RefreshCcw,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { createDevelopmentAccessTokenProvider } from "../lib/browser-auth";
import {
  ControlApiClient,
  type ControlApiAccessTokenProvider,
} from "../lib/control-api";
import { OliviaMeetingBriefAction } from "./olivia-meeting-brief-action";
import {
  WorkspaceShell,
  type WorkspaceShellProps,
} from "./workspace-shell";

const CONTROL_API_URL =
  process.env.NEXT_PUBLIC_CONTROL_API_URL ?? "http://localhost:3001";
const DEVELOPMENT_ACCESS_TOKEN_PROVIDER = createDevelopmentAccessTokenProvider({
  nodeEnv: process.env.NODE_ENV,
  configuredToken: process.env.NEXT_PUBLIC_CONTROL_API_ACCESS_TOKEN,
});

const GENESISCO_MEETING: CreateMeetingInput = {
  title: "Genesisco production execution readiness",
  objective:
    "Determine the safe path from the current parked staging state to production-ready live execution for Genesisco.",
  expectedOutcome:
    "A concrete prioritized plan for closing the remaining production execution gates, with explicit decisions, owners, and safety controls.",
  decisionQuestion:
    "Can Genesisco proceed toward live execution and activation of real provider credentials (#14) now? If not, which prerequisites must be completed first?",
  relevantProjectContext:
    "Genesisco is currently intentionally parked in staging. This meeting is intended to decide the safe path toward live execution; unverified production-readiness claims must not be invented by the brief generator.",
  knownOpenItems: [
    "Identify every remaining production execution gate and the evidence required to close it.",
    "Define the approval and safety controls required before activation of real provider credentials (#14).",
    "Assign explicit owners and dependencies for prerequisites that remain open.",
  ],
};

type WorkspaceView = "workspace" | "meeting";

export function WorkspaceExperience(props: WorkspaceShellProps = {}) {
  const [view, setView] = useState<WorkspaceView>("workspace");

  if (view === "meeting") {
    return (
      <WorkspaceMeetingPreparation
        {...(props.accessTokenProvider === undefined
          ? {}
          : { accessTokenProvider: props.accessTokenProvider })}
        onBack={() => setView("workspace")}
      />
    );
  }

  return (
    <>
      <WorkspaceShell {...props} />
      <button
        className="fixed right-5 bottom-5 z-40 inline-flex items-center gap-2 rounded-full border border-[#376454] bg-[#10271f] px-4 py-3 text-sm font-bold text-[#8df1cc] shadow-2xl shadow-black/50 transition hover:border-[#4b806e] hover:bg-[#153329] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#78e6bd] disabled:cursor-not-allowed disabled:opacity-60"
        type="button"
        disabled={props.signingOut === true}
        onClick={() => setView("meeting")}
        aria-label="Open Meeting preparation"
      >
        <Sparkles size={17} aria-hidden="true" />
        Meeting
      </button>
    </>
  );
}

function WorkspaceMeetingPreparation({
  accessTokenProvider = DEVELOPMENT_ACCESS_TOKEN_PROVIDER,
  onBack,
}: {
  readonly accessTokenProvider?: ControlApiAccessTokenProvider;
  readonly onBack: () => void;
}) {
  const api = useMemo(
    () =>
      new ControlApiClient({
        baseUrl: CONTROL_API_URL,
        accessTokenProvider,
      }),
    [accessTokenProvider],
  );
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [meeting, setMeeting] = useState<MeetingResponse>();
  const [error, setError] = useState<string>();
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  const [loadingMeeting, setLoadingMeeting] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    let active = true;
    setLoadingWorkspaces(true);
    setError(undefined);
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
      })
      .finally(() => {
        if (active) setLoadingWorkspaces(false);
      });
    return () => {
      active = false;
    };
  }, [api, reloadVersion]);

  useEffect(() => {
    if (workspaceId === "") {
      setMeeting(undefined);
      return;
    }

    let active = true;
    setMeeting(undefined);
    setLoadingMeeting(true);
    setError(undefined);
    void (async () => {
      try {
        const meetings = await api.listMeetings(workspaceId);
        const existing = meetings.items.find(
          (candidate) => candidate.title === GENESISCO_MEETING.title,
        );
        const resolved =
          existing ?? (await api.createMeeting(workspaceId, GENESISCO_MEETING));
        if (active) setMeeting(resolved);
      } catch (caught) {
        if (active) setError(`Could not load Meeting preparation: ${toMessage(caught)}`);
      } finally {
        if (active) setLoadingMeeting(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [api, reloadVersion, workspaceId]);

  return (
    <div className="min-h-screen bg-[#080b10] text-[#edf2f7]">
      <div className="sticky top-0 z-40 flex min-h-16 items-center justify-between gap-3 border-b border-[#202734] bg-[#0a0e14]/95 px-4 py-3 backdrop-blur md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <button
            className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-[#39414d] bg-[#11161e] px-3 py-2 text-xs font-semibold text-[#c0cad8] hover:border-[#4a5565] hover:text-white"
            type="button"
            onClick={onBack}
          >
            <ArrowLeft size={14} aria-hidden="true" />
            Workspace
          </button>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">Meeting preparation</p>
            <p className="truncate text-xs text-[#7f8b9d]">
              Durable workspace context · Olivia-assisted brief gate
            </p>
          </div>
        </div>

        {workspaces.length > 1 ? (
          <label className="flex shrink-0 items-center gap-2 text-xs text-[#8f9bad]">
            <span className="hidden sm:inline">Workspace</span>
            <select
              className="max-w-56 rounded-lg border border-[#303846] bg-[#0d121a] px-2.5 py-2 text-xs text-[#d6dee8]"
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {error !== undefined ? (
        <main className="grid min-h-[calc(100vh-4rem)] place-items-center px-4 py-10">
          <div className="w-full max-w-xl rounded-2xl border border-[#67333a] bg-[#1c1014] p-5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 shrink-0 text-[#ff9ca6]" size={20} />
              <div className="min-w-0 flex-1">
                <h1 className="font-semibold">Meeting preparation could not be loaded</h1>
                <p className="mt-2 text-sm leading-6 text-[#d6aeb3]">{error}</p>
                <button
                  className="mt-4 inline-flex items-center gap-2 rounded-lg border border-[#5b4d52] bg-[#24171b] px-3 py-2 text-xs font-semibold text-[#ffc1c7]"
                  type="button"
                  onClick={() => setReloadVersion((value) => value + 1)}
                >
                  <RefreshCcw size={14} aria-hidden="true" />
                  Retry
                </button>
              </div>
            </div>
          </div>
        </main>
      ) : loadingWorkspaces || loadingMeeting || meeting === undefined ? (
        <main className="grid min-h-[calc(100vh-4rem)] place-items-center px-4 py-10">
          <div className="flex items-center gap-3 rounded-2xl border border-[#252d3a] bg-[#0d121a] px-5 py-4 text-sm text-[#aab5c5]">
            <LoaderCircle className="animate-spin text-[#78e6bd]" size={18} />
            {workspaceId === ""
              ? "Restoring workspace context…"
              : "Restoring durable Meeting preparation…"}
          </div>
        </main>
      ) : (
        <OliviaMeetingBriefAction
          context={{
            title: meeting.title,
            objective: meeting.objective,
            expectedOutcome: meeting.expectedOutcome,
            decisionQuestion: meeting.decisionQuestion,
            ...(meeting.relevantProjectContext === null
              ? {}
              : { relevantProjectContext: meeting.relevantProjectContext }),
            knownOpenItems: meeting.knownOpenItems,
          }}
          preparedPrompt={meeting.oliviaAction.prompt}
          {...(meeting.meetingBrief === null
            ? {}
            : { initialMeetingBrief: meeting.meetingBrief })}
          initialActionStatus={meeting.oliviaAction.status}
          onMeetingBriefApplied={async (meetingBrief) => {
            const updated = await api.completeMeetingBriefAction(
              meeting.id,
              meetingBrief,
            );
            setMeeting(updated);
          }}
        />
      )}
    </div>
  );
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
