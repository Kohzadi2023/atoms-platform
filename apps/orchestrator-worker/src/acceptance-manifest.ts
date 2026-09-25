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
 * Which of Emma's acceptance criteria each scenario above is evidence for,
 * keyed by the criterion's stable semantic key (CriterionKeySchema, e.g.
 * "auth.sign_in") rather than its per-run positional id (US-xxx:n): the id
 * is freeform and regenerated fresh every run, so a manifest written once
 * for a project type cannot name it ahead of time, but the key is part of
 * the same contract Emma's instructions already share with Bob/Alex/David
 * (CLIENT_PORTAL_TESTABILITY_CONTRACT.criterionKeys in @atoms/agents), so it
 * is stable across runs for the same conceptual requirement.
 *
 * `resolveCriterionIdsByScenario` (@atoms/quality) turns this into the
 * per-run, id-keyed map `evidenceFromAcceptanceRun` needs, by matching each
 * key against that run's actual Emma output; a key that run's Emma output
 * never produced resolves to nothing for that scenario and is reported back
 * as `unresolvedScenarios` rather than silently behaving like an unmapped
 * scenario. Only the two scenarios with a real key mapping in
 * CLIENT_PORTAL_TESTABILITY_CONTRACT are listed here -- see
 * CLIENT_PORTAL_ACCEPTANCE_MANIFEST's own doc comment for the three
 * acceptance-journey points intentionally left uncovered.
 */
export const CLIENT_PORTAL_CRITERION_KEYS_BY_SCENARIO: Readonly<Record<string, readonly string[]>> = {
  "client-sign-in": [CLIENT_PORTAL_TESTABILITY_CONTRACT.criterionKeys.authSignIn],
  "signed-out-visitor-blocked": [CLIENT_PORTAL_TESTABILITY_CONTRACT.criterionKeys.authUnauthenticatedRedirect],
};

const MANIFESTS_BY_PROJECT_TYPE: Readonly<Record<ProjectType, AcceptanceManifest | null>> = {
  GENERAL: null,
  CLIENT_PORTAL: CLIENT_PORTAL_ACCEPTANCE_MANIFEST,
};

export function getAcceptanceManifest(projectType: ProjectType): AcceptanceManifest | null {
  return MANIFESTS_BY_PROJECT_TYPE[projectType];
}
