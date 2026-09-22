"use client";

import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ClipboardCopy,
  LoaderCircle,
  LockKeyhole,
  Sparkles,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

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
  readonly preparedPrompt?: string;
  readonly initialMeetingBrief?: string;
  readonly initialActionStatus?: OliviaAssistedActionStatus;
  readonly onMeetingBriefApplied?: (
    meetingBrief: string,
  ) => void | Promise<void>;
}

export function OliviaMeetingBriefAction({
  context,
  preparedPrompt,
  initialMeetingBrief,
  initialActionStatus,
  onMeetingBriefApplied,
}: OliviaMeetingBriefActionProps) {
  const normalizedInitialBrief = initialMeetingBrief?.trim() ?? "";
  const [meetingBrief, setMeetingBrief] = useState(normalizedInitialBrief);
  const [response, setResponse] = useState("");
  const [actionStatus, setActionStatus] = useState<OliviaAssistedActionStatus>(
    initialActionStatus ?? (normalizedInitialBrief.length > 0 ? "COMPLETED" : "PENDING"),
  );
  const [dialogOpen, setDialogOpen] = useState(
    normalizedInitialBrief.length === 0 || initialActionStatus !== "COMPLETED",
  );
  const [validation, setValidation] = useState<MeetingBriefValidationResult>();
  const [copyNotice, setCopyNotice] = useState<string>();
  const [completionNotice, setCompletionNotice] = useState<string>();
  const [applyError, setApplyError] = useState<string>();
  const [applying, setApplying] = useState(false);

  const action = useMemo(() => {
    const generated = createMeetingBriefAction(context, actionStatus);
    return preparedPrompt === undefined ? generated : { ...generated, prompt: preparedPrompt };
  }, [actionStatus, context, preparedPrompt]);

  const meetingState = resolveMeetingPreparationState(meetingBrief, actionStatus);
  const blocked = meetingState === "OLIVIA_ACTION_REQUIRED";

  async function copyPrompt() {
    setCopyNotice(undefined);
    try {
      await globalThis.navigator.clipboard.writeText(action.prompt);
      setActionStatus((current) => (current === "PENDING" ? "PROMPT_COPIED" : current));
      setCopyNotice("Prompt copied. Send it to your AI, then paste the response below.");
    } catch {
      setCopyNotice("Clipboard access is unavailable. Select the prompt text and copy it manually.");
    }
  }

  function updateResponse(value: string) {
    setResponse(value);
    setValidation(undefined);
    setApplyError(undefined);
    setCompletionNotice(undefined);
    setActionStatus(value.trim().length > 0 ? "RESPONSE_RECEIVED" : "PENDING");
  }

  function validateResponse() {
    const result = validateMeetingBriefResponse(response);
    setValidation(result);
    setActionStatus(result.valid ? "VALIDATED" : "RESPONSE_RECEIVED");
  }

  async function applyResponse() {
    const completion = completeMeetingBriefAction(response);
    setValidation(completion.validation);
    setApplyError(undefined);

    if (completion.actionStatus !== "COMPLETED" || completion.meetingBrief === undefined) {
      setActionStatus(completion.actionStatus);
      return;
    }

    setApplying(true);
    try {
      await onMeetingBriefApplied?.(completion.meetingBrief);
      setMeetingBrief(completion.meetingBrief);
      setActionStatus("COMPLETED");
      setDialogOpen(false);
      setCompletionNotice(
        "Meeting Brief saved. The meeting can now advance to agent preparation.",
      );
    } catch (error) {
      setApplyError(toMessage(error));
      setActionStatus("VALIDATED");
    } finally {
      setApplying(false);
    }
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
              Required AI-assisted preparation is explicit and gated. The Meeting Brief must be
              validated and durably saved before agent preparation unlocks.
            </p>
          </div>
          <MeetingStateBadge blocked={blocked} />
        </header>

        {completionNotice !== undefined ? (
          <Notice tone="success" icon={<CheckCircle2 size={18} />}>
            {completionNotice}
          </Notice>
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
                <p className="mt-1 text-xs text-[#7f8b9d]">Prepared through Olivia Assisted Action</p>
              </div>
              <span className={blocked ? badgeClass("warning") : badgeClass("success")}>
                {blocked ? "Action required" : "Durably saved"}
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
                        Copy the system-owned prompt, paste the AI response, validate it, and save
                        it to the meeting record to unlock the next stage.
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
                  ? "Blocked until the durable Meeting Brief action is completed."
                  : "The validated Meeting Brief is stored and agent preparation is unlocked."}
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
                <span className={badgeClass(actionStatus === "COMPLETED" ? "success" : "warning")}>
                  {actionStatus.replaceAll("_", " ")}
                </span>
              </div>
            </div>

            <div className="space-y-7 px-5 py-5 sm:px-6">
              <ActionStep number="1" title="Copy the prepared prompt">
                <p className="mb-3 text-sm leading-6 text-[#8f9bad]">
                  This prompt comes from the durable meeting record; Olivia does not have to
                  decide what to ask.
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
                    <span className="text-xs text-[#9ba8b8]" role="status">{copyNotice}</span>
                  ) : null}
                </div>
              </ActionStep>

              <ActionStep number="2" title="Paste the AI response">
                <textarea
                  className="h-64 w-full resize-y rounded-xl border border-[#303846] bg-[#080c12] p-3 text-sm leading-6 text-[#d7dee8] outline-none placeholder:text-[#586476] focus:border-[#4e7668] disabled:opacity-60"
                  value={response}
                  onChange={(event) => updateResponse(event.target.value)}
                  placeholder="Paste the complete AI response here…"
                  aria-label="AI response for Meeting Brief"
                  disabled={actionStatus === "COMPLETED" || applying}
                />
              </ActionStep>

              <ActionStep number="3" title="Validate and save">
                <div className="flex flex-wrap gap-3">
                  <button
                    className="rounded-xl border border-[#475263] bg-[#141b25] px-4 py-2.5 text-sm font-semibold text-[#d5dde8] disabled:cursor-not-allowed disabled:opacity-50"
                    type="button"
                    disabled={response.trim().length === 0 || applying || actionStatus === "COMPLETED"}
                    onClick={validateResponse}
                  >
                    Validate Response
                  </button>
                  <button
                    className="inline-flex items-center gap-2 rounded-xl bg-[#78e6bd] px-4 py-2.5 text-sm font-bold text-[#06281e] disabled:cursor-not-allowed disabled:bg-[#33433e] disabled:text-[#7f948d]"
                    type="button"
                    disabled={validation?.valid !== true || applying || actionStatus === "COMPLETED"}
                    onClick={() => void applyResponse()}
                  >
                    {applying ? <LoaderCircle className="animate-spin" size={16} /> : <Check size={16} />}
                    {applying ? "Saving…" : "Save to Meeting"}
                  </button>
                </div>

                {validation !== undefined ? <ValidationFeedback validation={validation} /> : null}
                {applyError !== undefined ? (
                  <Notice tone="error" icon={<AlertTriangle size={17} />}>
                    {applyError}
                  </Notice>
                ) : null}
                {actionStatus === "COMPLETED" ? (
                  <Notice tone="success" icon={<CheckCircle2 size={17} />}>
                    This action is already completed in the meeting record.
                  </Notice>
                ) : null}
              </ActionStep>
            </div>

            <div className="flex items-center gap-2 border-t border-[#252d3a] px-5 py-4 text-xs text-[#7f8b9d] sm:px-6">
              <LockKeyhole size={14} aria-hidden="true" />
              The gate advances only after the Control API durably saves this action.
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function MeetingStateBadge({ blocked }: { readonly blocked: boolean }) {
  return (
    <div className={blocked ? badgeClass("warning") : badgeClass("success")}>
      {blocked ? <LockKeyhole size={14} /> : <CheckCircle2 size={14} />}
      {blocked ? "Olivia action required" : "Ready for agent preparation"}
    </div>
  );
}

function ContextCard({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <article className="rounded-2xl border border-[#252d3a] bg-[#0d121a] p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#7f8b9d]">{label}</p>
      <p className="mt-2 text-sm leading-6 text-[#c5ceda]">{value}</p>
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
  readonly children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-3">
        <span className="grid size-7 place-items-center rounded-full border border-[#315849] bg-[#10251e] text-xs font-bold text-[#78e6bd]">
          {number}
        </span>
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <div className="pl-10">{children}</div>
    </section>
  );
}

function ValidationFeedback({ validation }: { readonly validation: MeetingBriefValidationResult }) {
  if (validation.valid) {
    return (
      <Notice tone="success" icon={<CheckCircle2 size={17} />}>
        Response contains every required Meeting Brief section and is ready to save.
      </Notice>
    );
  }

  return (
    <Notice tone="error" icon={<AlertTriangle size={17} />}>
      <span>{validation.violations.join(" ")}</span>
      {validation.missingSections.length > 0 ? (
        <span className="mt-1 block text-xs">
          Missing: {validation.missingSections.join(", ")}
        </span>
      ) : null}
    </Notice>
  );
}

function Notice({
  tone,
  icon,
  children,
}: {
  readonly tone: "success" | "error";
  readonly icon: ReactNode;
  readonly children: ReactNode;
}) {
  const className =
    tone === "success"
      ? "mt-4 flex items-start gap-2 rounded-xl border border-[#315849] bg-[#0e211a] px-3 py-2.5 text-sm text-[#a8f0d3]"
      : "mt-4 flex items-start gap-2 rounded-xl border border-[#67333a] bg-[#1c1014] px-3 py-2.5 text-sm text-[#ff9ca6]";
  return (
    <div className={className} role={tone === "error" ? "alert" : "status"}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

function badgeClass(tone: "success" | "warning"): string {
  return tone === "success"
    ? "inline-flex items-center gap-2 self-start rounded-full border border-[#315849] bg-[#0e211a] px-3 py-1.5 text-xs font-semibold text-[#78e6bd]"
    : "inline-flex items-center gap-2 self-start rounded-full border border-[#6a4d2d] bg-[#24190d] px-3 py-1.5 text-xs font-semibold text-[#f3bd75]";
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
