-- Durable persistence for the Olivia-assisted Meeting Brief gate introduced in #127.
-- The action is one-to-one with a meeting and the meeting cannot become ready until
-- the action is completed by the Control API transaction.

-- CreateEnum
CREATE TYPE "MeetingPreparationState" AS ENUM ('OLIVIA_ACTION_REQUIRED', 'READY_FOR_AGENT_PREPARATION');

-- CreateEnum
CREATE TYPE "OliviaAssistedActionKind" AS ENUM ('PREPARE_MEETING_BRIEF');

-- CreateEnum
CREATE TYPE "OliviaAssistedActionStatus" AS ENUM ('PENDING', 'PROMPT_COPIED', 'RESPONSE_RECEIVED', 'VALIDATED', 'COMPLETED');

-- CreateTable
CREATE TABLE "meetings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "objective" TEXT NOT NULL,
    "expected_outcome" TEXT NOT NULL,
    "decision_question" TEXT NOT NULL,
    "relevant_project_context" TEXT,
    "known_open_items" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "meeting_brief" TEXT,
    "preparation_state" "MeetingPreparationState" NOT NULL DEFAULT 'OLIVIA_ACTION_REQUIRED',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "olivia_assisted_actions" (
    "id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "kind" "OliviaAssistedActionKind" NOT NULL,
    "status" "OliviaAssistedActionStatus" NOT NULL DEFAULT 'PENDING',
    "target_field" VARCHAR(80) NOT NULL DEFAULT 'meetingBrief',
    "prompt" TEXT NOT NULL,
    "response" TEXT,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "olivia_assisted_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meetings_workspace_id_created_at_idx" ON "meetings"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "meetings_project_id_created_at_idx" ON "meetings"("project_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "olivia_assisted_actions_meeting_id_key" ON "olivia_assisted_actions"("meeting_id");

-- CreateIndex
CREATE INDEX "olivia_assisted_actions_status_created_at_idx" ON "olivia_assisted_actions"("status", "created_at");

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "olivia_assisted_actions" ADD CONSTRAINT "olivia_assisted_actions_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
