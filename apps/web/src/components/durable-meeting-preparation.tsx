"use client";

import { WorkspaceMeetingPreparation } from "./workspace-meeting-experience";

// Standalone, non-production review route (gated by app/meeting-preparation/page.tsx).
// Renders the same durable Meeting preparation flow as the authenticated workspace
// shell instead of re-implementing its own find-or-create logic, so there is exactly
// one place that lists/creates the workspace's Meeting record.
export function DurableMeetingPreparation() {
  return <WorkspaceMeetingPreparation onBack={() => undefined} />;
}
