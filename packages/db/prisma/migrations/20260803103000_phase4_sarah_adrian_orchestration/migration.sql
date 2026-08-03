-- Phase 4: wire Sarah and Adrian as persisted orchestrator task agents.
ALTER TYPE "AgentName" ADD VALUE IF NOT EXISTS 'Sarah';
ALTER TYPE "AgentName" ADD VALUE IF NOT EXISTS 'Adrian';
