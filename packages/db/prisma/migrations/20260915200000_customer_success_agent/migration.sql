-- Add CustomerSuccess as a persisted orchestrator task agent. Contract only:
-- this value is not yet referenced by the run graph, so no task with this
-- agent name is produced by any existing run.
ALTER TYPE "AgentName" ADD VALUE IF NOT EXISTS 'CustomerSuccess';
