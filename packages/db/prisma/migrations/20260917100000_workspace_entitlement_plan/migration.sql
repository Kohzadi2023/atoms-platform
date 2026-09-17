-- Adds a workspace subscription plan used to gate premium agents (Sophia,
-- Sarah, Adrian) in apps/orchestrator-worker/src/graph.ts. Every existing
-- and new workspace defaults to FREE -- deliberately, per user decision --
-- until a Billing route can upgrade it.

-- CreateEnum
CREATE TYPE "WorkspacePlan" AS ENUM ('FREE', 'PRO', 'MAX');

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "plan" "WorkspacePlan" NOT NULL DEFAULT 'FREE';
