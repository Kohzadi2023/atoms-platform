-- Adds SKIPPED to AgentTaskStatus so a premium agent's ordinal that the
-- entitlement gate (apps/orchestrator-worker/src/graph.ts) bypassed is
-- recorded as an explicit task row, not silently absent.

-- AlterEnum
ALTER TYPE "AgentTaskStatus" ADD VALUE 'SKIPPED';
