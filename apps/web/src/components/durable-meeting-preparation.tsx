"use client";

import type { CreateMeetingInput, MeetingResponse } from "@atoms/contracts";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { createDevelopmentAccessTokenProvider } from "../lib/browser-auth";
import { ControlApiClient } from "../lib/control-api";
import { OliviaMeetingBriefAction } from "./olivia-meeting-brief-action";

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

export function DurableMeetingPreparation() {
  const api = useMemo(
    () =>
      new ControlApiClient({
        baseUrl: CONTROL_API_URL,
        accessTokenProvider: DEVELOPMENT_ACCESS_TOKEN_PROVIDER,
      }),
    [],
  );
  const [meeting, setMeeting] = useState<MeetingResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const workspaces = await api.listWorkspaces();
        const workspace = workspaces.items[0];
        if (workspace === undefined) {
          throw new Error("No workspace is available for the Meeting preparation record.");
        }

        const meetings = await api.listMeetings(workspace.id);
        const existing = meetings.items.find(
          (candidate) => candidate.title === GENESISCO_MEETING.title,
        );
        const resolved =
          existing ?? (await api.createMeeting(workspace.id, GENESISCO_MEETING));
        if (active) setMeeting(resolved);
      } catch (caught) {
        if (active) setError(toMessage(caught));
      }
    })();

    return () => {
      active = false;
    };
  }, [api]);

  if (error !== undefined) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#080b10] px-4 text-[#edf2f7]">
        <div className="w-full max-w-xl rounded-2xl border border-[#67333a] bg-[#1c1014] p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 shrink-0 text-[#ff9ca6]" size={20} />
            <div>
              <h1 className="font-semibold">Meeting record could not be loaded</h1>
              <p className="mt-2 text-sm leading-6 text-[#d6aeb3]">{error}</p>
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (meeting === undefined) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#080b10] px-4 text-[#edf2f7]">
        <div className="flex items-center gap-3 rounded-2xl border border-[#252d3a] bg-[#0d121a] px-5 py-4 text-sm text-[#aab5c5]">
          <LoaderCircle className="animate-spin text-[#78e6bd]" size={18} />
          Restoring durable Meeting preparation…
        </div>
      </main>
    );
  }

  return (
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
        const updated = await api.completeMeetingBriefAction(meeting.id, meetingBrief);
        setMeeting(updated);
      }}
    />
  );
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
