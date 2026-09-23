import { CLIENT_PORTAL_TESTABILITY_CONTRACT } from "@atoms/agents";
import type { ProjectType } from "@atoms/contracts";
import type { AcceptanceManifest } from "@atoms/sandbox-provider";

const { routes, testIds, fixtureAccounts } = CLIENT_PORTAL_TESTABILITY_CONTRACT;

/**
 * G3 (docs/adr/production-execution-gate.md), issue #130: the scenario set for
 * the one Q1 template (CLIENT_PORTAL). Every route, data-testid and fixture
 * credential here comes from CLIENT_PORTAL_TESTABILITY_CONTRACT in
 * @atoms/agents, the same constant Bob's, Alex's and David's instructions
 * quote -- so this file and the live prompts cannot drift apart silently (see
 * the drift test in packages/agents/src/index.test.ts).
 *
 * Two of docs/client-portal-reference-architecture.md's five acceptance-journey
 * points are covered for real: a client can sign in, and a signed-out visitor
 * is kept off the client's dashboard. The remaining three (isolation between
 * two tenants, staff creating and sharing a deliverable, a client approving
 * one) need a further, undecided extension to the fixture-seed contract -- a
 * fixed, known deliverable id per tenant -- and are intentionally left out
 * rather than guessed at. Tracked as a follow-up to issue #130.
 */
export const CLIENT_PORTAL_ACCEPTANCE_MANIFEST: AcceptanceManifest = {
  schemaVersion: "atoms.acceptance-manifest.v1",
  scenarios: [
    { kind: "HEALTH_CHECK", name: "api-health", path: "/api/health" },
    { kind: "CRITICAL_ROUTE", name: "home-loads", path: "/" },
    {
      kind: "AUTH_FLOW",
      name: "client-sign-in",
      loginPath: routes.login,
      usernameSelector: `[data-testid="${testIds.loginEmail}"]`,
      passwordSelector: `[data-testid="${testIds.loginPassword}"]`,
      submitSelector: `[data-testid="${testIds.loginSubmit}"]`,
      username: fixtureAccounts.tenantA.clientEmail,
      password: fixtureAccounts.password,
      expectPathAfterLogin: routes.dashboard,
    },
    {
      kind: "PRIMARY_JOURNEY",
      name: "signed-out-visitor-blocked",
      steps: [
        { action: "goto", path: routes.dashboard },
        { action: "expectPath", path: routes.login },
      ],
    },
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
 * uncovered as it was before G3 shipped -- what G3 adds is the runner and
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
