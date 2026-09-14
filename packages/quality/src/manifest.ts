/** Package capability metadata; not a registered AgentManifest or an AgentName enum value. */
export const qualityEvaluatorManifest = Object.freeze({
  name: "QA_RELEASE",
  version: "1.0.0",
  mode: "OBSERVE_ONLY",
  objective: "Assess supplied validation evidence and acceptance coverage for one immutable run snapshot.",
  allowedInputs: Object.freeze(["ACCEPTANCE_SNAPSHOT", "QUALITY_EVIDENCE", "TRUSTED_POLICY"]),
  outputSchemaVersion: "quality.assessment.v1",
  forbiddenActions: Object.freeze(["SOURCE_WRITE", "DATABASE_WRITE", "PROVIDER_EXECUTION", "RUN_TRANSITION", "DEPLOYMENT", "HUMAN_OVERRIDE"]),
} as const);
