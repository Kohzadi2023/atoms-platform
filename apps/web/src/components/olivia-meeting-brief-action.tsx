"use client";

import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ClipboardCopy,
  LockKeyhole,
  Sparkles,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  createMeetingBriefAction,
  completeMeetingBriefAction,
  resolveMeetingPreparationState,
  validateMeetingBriefResponse,
  type MeetingBriefContext,
  type MeetingBriefValidationResult,
  type OliviaAssistedActionStatus,
} from "../lib/olivia-assisted-action";

export interface OliviaMeetingBriefActionProps {
  readonly context: MeetingBriefContext;
  readonly initialMeetingBrief?: string;
  readonly onMeetingBriefApplied?: (meetingBrief: string) => void;
}

export function OliviaMeetingBriefAction({
  context,
  initialMeetingBrief,
  onMeetingBriefApplied,
}: OliviaMeetingBriefActionProps) {
  const normalizedInitialBrief = initialMeetingBrief?.trim() ?? "";
  const [meetingBrief, setMeetingBrief] = useState(normalizedInitialBrief);
  const [response, setResponse] = useState("");
  const [actionStatus, setActionStatus] = useState<OliviaAssistedActionStatus>(
    normalizedInitialBrief.length > 0 ? "COMPLETED" : "PENDING",
  );
  const [dialogOpen, setDialogOpen] = useState(normalizedInitialBrief.length === 0);
  const [validation, setValidation] = useState<MeetingBriefValidationResult | undefined>();
  const [copyNotice, setCopyNotice] = useState<string | undefined>();
  const [completionNotice, setCompletionNotice] = useState<string | undefined>();

  const action = useMemo(
    () => createMeetingBriefAction(context, actionStatus),
    [actionStatus, context],
  );
  const meetingState = resolveMeetingPreparationState(meetingBrief, actionStatus);
  const blocked = meetingState === "OLIVIA_ACTION_REQUIRED";

  async function copyPrompt() {
    setCopyNotice(undefined);
    try {
      await globalThis.navigator.clipboard.writeText(action.prompt);
      setActionStatus((current) =>
        current === "PENDING" ? "PROMPT_COPIED" : current,
      );
      setCopyNotice("Prompt copied. Send it to your AI, then paste the response below.");
    } catch {
      setCopyNotice(
        "Clipboard access is unavailable. Select the prompt text and copy it manually.",
      );
    }
  }

  function updateResponse(value: string) {
    setResponse(value);
    setValidation(undefined);
    setCompletionNotice(undefined);
    setActionStatus(value.trim().length > 0 ? "RESPONSE_RECEIVED" : "PENDING");
  }

  function validateResponse() {
    const result = validateMeetingBriefResponse(response);
    setValidation(result);
    setActionStatus(result.valid ? "VALIDATED" : "RESPONSE_RECEIVED");
  }

  function applyResponse() {
    const completion = completeMeetingBriefAction(response);
    setValidation(completion.validation);

    if (
      completion.actionStatus !== "COMPLETED" ||
      completion.meetingBrief === undefined
    ) {
      setActionStatus(completion.actionStatus);
      return;
    }

    setMeetingBrief(completion.meetingBrief);
    setActionStatus("COMPLETED");
    setDialogOpen(false);
    setCompletionNotice(
      "Meeting Brief added. The meeting can now advance to agent preparation.",
    );
    onMeetingBriefApplied?.(completion.meetingBrief);
  }

  return (
    <main className="min-h-screen bg-[#080b10] px-4 py-8 text-[#edf2f7] sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-col gap-4 border-b border-[#242b36] pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#78e6bd]">
              Meeting preparation
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
              {context.title}
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[#98a5b7]">
              Olivia is an observer, but required AI-assisted preparation steps are surfaced as
              explicit guided actions. The meeting stays gated until each blocking action is
              completed.
            </p>
          </div>
          <MeetingStateBadge blocked={blocked} />
        </header>

        {completionNotice !== undefined ? (
          <div
            className="mt-5 flex items-start gap-3 rounded-xl border border-[#315849] bg-[#0e211a] px-4 py-3 text-sm text-[#a8f0d3]"
            role="status"
          >
            <CheckCircle2 className="mt-0.5 shrink-0" size={18} aria-hidden="true" />
            <span>{completionNotice}</span>
          </div>
        ) : null}

        <div className="mt-6 grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
          <section className="space-y-4" aria-label="Meeting decision context">
            <ContextCard label="Objective" value={context.objective} />
            <ContextCard label="Expected Outcome" value={context.expectedOutcome} />
            <ContextCard label="Decision Question" value={context.decisionQuestion} />
          </section>

          <section className="rounded-2xl border border-[#252d3a] bg-[#0d121a] shadow-2xl shadow-black/20">
            <div className="flex items-start justify-between gap-4 border-b border-[#252d3a] px-5 py-4">
              <div>
                <div className="flex items-center gap-2">
                  <Sparkles className="text-[#78e6bd]" size={18} aria-hidden="true" />
                  <h2 className="font-semibold">Meeting Brief</h2>
                </div>
                <p className="mt-1 text-xs text-[#7f8b9d]">
                  Prepared through a guided Olivia action
                </p>
              </div>
              <span
                className={
                  blocked
                    ? "rounded-full border border-[#6a4d2d] bg-[#24190d] px-2.5 py-1 text-xs font-semibold text-[#f3bd75]"
                    : "rounded-full border border-[#315849] bg-[#0e211a] px-2.5 py-1 text-xs font-semibold text-[#78e6bd]"
                }
              >
                {blocked ? "Action required" : "Ready"}
              </span>
            </div>

            {meetingBrief.length === 0 ? (
              <div className="p-5">
                <div className="rounded-xl border border-dashed border-[#4b5565] bg-[#0a0e14] p-5">
                  <div className="flex items-start gap-3">
                    <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-[#6a4d2d] bg-[#24190d] text-[#f3bd75]">
                      <LockKeyhole size={17} aria-hidden="true" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold">Olivia action required</h3>
                      <p className="mt-1 text-sm leading-6 text-[#98a5b7]">
                        The Meeting Brief is intentionally not an empty editor. Use the prepared
                        prompt, paste the AI response, validate it, and apply it to unlock the next
                        meeting stage.
                      </p>
                    </div>
                  </div>
                  <button
                    className="mt-5 inline-flex items-center gap-2 rounded-xl bg-[#78e6bd] px-4 py-2.5 text-sm font-bold text-[#06281e]"
                    type="button"
                    onClick={() => setDialogOpen(true)}
                  >
                    Complete Olivia Action
                    <ArrowRight size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
            ) : (
              <div className="p-5">
                <pre className="whitespace-pre-wrap font-sans text-sm leading-7 text-[#c8d2df]">
                  {meetingBrief}
                </pre>
                <button
                  className="mt-5 text-xs font-semibold text-[#8fb9ff] underline decoration-[#4d6690] underline-offset-4"
                  type="button"
                  onClick={() => setDialogOpen(true)}
                >
                  Review guided action
                </button>
              </div>
            )}
          </section>
        </div>

        <section className="mt-6 rounded-2xl border border-[#252d3a] bg-[#0d121a] p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold">Next gate: Agent preparation</h2>
              <p className="mt-1 text-sm text-[#8f9bad]">
                {blocked
                  ? "Blocked until the Meeting Brief action is completed."
                  : "Meeting Brief is validated and the next preparation stage is unlocked."}
              </p>
            </div>
            <button
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#315849] bg-[#10251e] px-4 py-2.5 text-sm font-semibold text-[#78e6bd] disabled:cursor-not-allowed disabled:border-[#303744] disabled:bg-[#121720] disabled:text-[#697588]"
              type="button"
              disabled={blocked}
            >
              {blocked ? <LockKeyhole size={16} /> : <Check size={16} />}
              {blocked ? "Waiting for Olivia" : "Ready for agent preparation"}
            </button>
          </div>
        </section>
      </div>

      {dialogOpen ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/75 px-4 py-8"
          role="dialog"
          aria-modal="true"
          aria-labelledby="olivia-action-title"
        >
          <div className="w-full max-w-4xl rounded-2xl border border-[#303846] bg-[#0d121a] shadow-2xl shadow-black/60">
            <div className="border-b border-[#252d3a] px-5 py-4 sm:px-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-[#78e6bd]">
                    <Sparkles size={18} aria-hidden="true" />
                    <span className="text-xs font-semibold uppercase tracking-[0.16em]">
                      Olivia · Blocking action
                    </span>
                  </div>
                  <h2 id="olivia-action-title" className="mt-2 text-xl font-semibold">
                    {action.title}
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-[#98a5b7]">{action.reason}</p>
                </div>
                <span className="rounded-full border border-[#6a4d2d] bg-[#24190d] px-2.5 py-1 text-xs font-semibold text-[#f3bd75]">
                  {actionStatus.replaceAll("_", " ")}
                </span>
              </div>
            </div>

            <div className="space-y-7 px-5 py-5 sm:px-6">
              <ActionStep number="1" title="Copy the prepared prompt">
                <p className="mb-3 text-sm leading-6 text-[#8f9bad]">
                  The prompt is owned by the system. Olivia should not have to decide what to ask.
                </p>
                <textarea
                  className="h-56 w-full resize-y rounded-xl border border-[#303846] bg-[#080c12] p-3 font-mono text-xs leading-5 text-[#c7d2df] outline-none focus:border-[#4e7668]"
                  readOnly
                  value={action.prompt}
                  aria-label="Prepared AI prompt"
                />
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <button
                    className="inline-flex items-center gap-2 rounded-xl bg-[#78e6bd] px-4 py-2.5 text-sm font-bold text-[#06281e]"
                    type="button"
                    onClick={() => void copyPrompt()}
                  >
                    <ClipboardCopy size={16} aria-hidden="true" />
                    Copy Prompt
                  </button>
                  {copyNotice !== undefined ? (
                    <span className="text-xs text-[#9ba8b8]" role="status">
                      {copyNotice}
                    </span>
                  ) : null}
                </div>
              </ActionStep>

              <ActionStep number="2" title="Paste the AI response">
                <textarea
                  className="h-64 w-full resize-y rounded-xl border border-[#303846] bg-[#080c12] p-3 text-sm leading-6 text-[#d7dee8] outline-none placeholder:text-[#586476] focus:border-[#4e7668]"
                  value={response}
                  onChange={(event) => updateResponse(event.target.value)}
                  placeholder="Paste the complete AI response here…"
                  aria-label="AI response for Meeting Brief"
                />
              </ActionStep>

              <ActionStep number="3" title="Validate and apply">
                <div className="flex flex-wrap gap-3">
                  <button
                    className="rounded-xl border border-[#475263] bg-[#141b25] px-4 py-2.5 text-sm font-semibold text-[#d5dde8] disabled:cursor-not-allowed disabled:opacity-50"
                    type="button"
                    disabled={response.trim().length === 0}
                    onClick={validateResponse}
                  >
                    Validate Response
                  </button>
                  <button
                    className="inline-flex items-center gap-2 rounded-xl bg-[#78e6bd] px-4 py-2.5 text-sm font-bold text-[#06281e] disabled:cursor-not-allowed disabled:bg-[#33433e] disabled:text-[#7f948d]"
                    type="button"
                    disabled={validation?.valid !== true}
                    onClick={applyResponse}
                  >
                    <Check size={16} aria-hidden="true" />
                    Apply to Meeting
                  </button>
                </div>

                {validation !== undefined ? (
                  <ValidationFeedback validation={validation} />
                ) : (
                  <p className="mt-3 text-xs leading-5 text-[#758296]">
                    Apply stays disabled until the response contains every required decision-ready
                    section.
                  </p>
                )}
              </ActionStep>
            </div>

            <div className="flex items-center gap-2 border-t border-[#252d3a] px-5 py-4 text-xs text-[#7f8b9d] sm:px-6">
              <LockKeyhole size={14} aria-hidden="true" />
              This popup is blocking. Complete the action to advance the meeting path.
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function MeetingStateBadge({ blocked }: { readonly blocked: boolean }) {
  return (
    <div
      className={
        blocked
          ? "inline-flex items-center gap-2 self-start rounded-full border border-[#6a4d2d] bg-[#24190d] px-3 py-1.5 text-xs font-semibold text-[#f3bd75]"
          : "inline-flex items-center gap-2 self-start rounded-full border border-[#315849] bg-[#0e211a] px-3 py-1.5 text-xs font-semibold text-[#78e6bd]"
      }
    >
      {blocked ? <LockKeyhole size={14} /> : <CheckCircle2 size={14} />}
      {blocked ? "Olivia action required" : "Ready for agent preparation"}
    </div>
  );
}

function ContextCard({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <article className="rounded-2xl border border-[#252d3a] bg-[#0d121a] p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#718095]">{label}</p>
      <p className="mt-2 text-sm leading-6 text-[#c8d2df]">{value}</p>
    </article>
  );
}

function ActionStep({
  number,
  title,
  children,
}: {
  readonly number: string;
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-3">
        <span className="grid size-7 place-items-center rounded-full border border-[#36554b] bg-[#10251e] text-xs font-bold text-[#78e6bd]">
          {number}
        </span>
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <div className="pl-10">{children}</div>
    </section>
  );
}

function ValidationFeedback({
  validation,
}: {
  readonly validation: MeetingBriefValidationResult;
}) {
  if (validation.valid) {
    return (
      <div className="mt-4 flex items-start gap-3 rounded-xl border border-[#315849] bg-[#0e211a] px-4 py-3 text-sm text-[#a8f0d3]">
        <CheckCircle2 className="mt-0.5 shrink-0" size={18} aria-hidden="true" />
        <div>
          <p className="font-semibold">Response validated</p>
          <p className="mt-1 text-xs leading-5 text-[#8ccdb3]">
            All required Meeting Brief sections are present. Apply it to unlock agent preparation.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="mt-4 rounded-xl border border-[#67333a] bg-[#1c1014] px-4 py-3 text-sm text-[#ff9ca6]"
      role="alert"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 shrink-0" size={18} aria-hidden="true" />
        <div>
          <p className="font-semibold">Response needs attention</p>
          {validation.violations.map((violation) => (
            <p className="mt-1 text-xs leading-5 text-[#d98d96]" key={violation}>
              {violation}
            </p>
          ))}
          {validation.missingSections.length > 0 ? (
            <div className="mt-3">
              <p className="text-xs font-semibold text-[#ffb0b8]">Missing sections</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-[#d98d96]">
                {validation.missingSections.map((section) => (
                  <li key={section}>{section}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
