import type { ProjectType } from "@atoms/contracts";
import type { AcceptanceManifest } from "@atoms/sandbox-provider";

/**
 * G3 (docs/adr/production-execution-gate.md): the fixed, operator-authored
 * scenario set for the one Q1 template (docs/client-portal-reference-architecture.md).
 * Deliberately conservative for v1: only scenarios that need no project-specific
 * login credentials or CSS selectors. AUTH_FLOW and PRIMARY_JOURNEY scenarios are
 * supported by the manifest schema (see acceptance-script.ts) but are not shipped
 * here -- adding them for a real client portal needs its actual route names and
 * selectors, which do not exist as a fixed fact yet, so a fabricated one would
 * assert nothing true. This is a starting point, not a claim that these two
 * scenarios cover the template.
 */
export const CLIENT_PORTAL_ACCEPTANCE_MANIFEST: AcceptanceManifest = {
  schemaVersion: "atoms.acceptance-manifest.v1",
  scenarios: [
    { kind: "HEALTH_CHECK", name: "api-health", path: "/api/health" },
    { kind: "CRITICAL_ROUTE", name: "home-loads", path: "/" },
  ],
};

/**
 * Which of Emma's acceptance criteria (US-xxx:n, see @atoms/quality) each
 * scenario above is evidence for. Deliberately empty: Emma's criterion ids
 * are freeform and positional, generated fresh per run, and cannot be known
 * ahead of time by a manifest written once for a project type. Until a
 * human reviews a given run's actual criteria and assigns specific ids here
 * (or a future change does that mapping automatically), this scenario set
 * produces no ACCEPTANCE evidence and `traceToAcceptance` stays exactly as
 * uncovered as it was before G3 shipped -- what G3 v1 adds is the runner and
 * the adapter that would use this map once it is populated, not a shortcut
 * around per-criterion evidence. See evidenceFromAcceptanceRun in
 * @atoms/quality and its tests for the mechanism proven with a non-empty map.
 */
export const CLIENT_PORTAL_CRITERION_IDS_BY_SCENARIO: Readonly<Record<string, readonly string[]>> = {};

const MANIFESTS_BY_PROJECT_TYPE: Readonly<Record<ProjectType, AcceptanceManifest | null>> = {
  GENERAL: null,
  CLIENT_PORTAL: CLIENT_PORTAL_ACCEPTANCE_MANIFEST,
};

export function getAcceptanceManifest(projectType: ProjectType): AcceptanceManifest | null {
  return MANIFESTS_BY_PROJECT_TYPE[projectType];
}
