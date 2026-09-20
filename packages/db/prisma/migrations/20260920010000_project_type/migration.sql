-- Adds a project type that decides which agents a run needs. Every existing and
-- new project defaults to GENERAL, which keeps every agent, so behavior is
-- unchanged until a project is created with another type.

-- CreateEnum
CREATE TYPE "ProjectType" AS ENUM ('GENERAL', 'CLIENT_PORTAL');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "project_type" "ProjectType" NOT NULL DEFAULT 'GENERAL';
