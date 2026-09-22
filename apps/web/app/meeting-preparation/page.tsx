import { notFound } from "next/navigation";

import { OliviaMeetingBriefAction } from "../../src/components/olivia-meeting-brief-action";

export default function MeetingPreparationPage() {
  // The durable Meeting backend does not exist yet. Keep this review surface
  // development-only so a browser-local prototype cannot be mistaken for a
  // production meeting record.
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <OliviaMeetingBriefAction
      context={{
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
      }}
    />
  );
}
