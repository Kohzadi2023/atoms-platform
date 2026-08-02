-- Secure project attachments: direct-to-object-storage upload intents,
-- quarantine/scan lifecycle, and immutable run snapshots.

CREATE TYPE "ProjectAttachmentStatus" AS ENUM (
  'AWAITING_UPLOAD',
  'QUARANTINED',
  'SCANNING',
  'CLEAN',
  'REJECTED',
  'FAILED',
  'EXPIRED'
);

CREATE TABLE "project_attachments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "file_name" VARCHAR(255) NOT NULL,
  "declared_content_type" VARCHAR(100) NOT NULL,
  "detected_content_type" VARCHAR(100),
  "size_bytes" INTEGER NOT NULL,
  "quarantine_object_key" VARCHAR(1024) NOT NULL,
  "clean_object_key" VARCHAR(1024),
  "etag" VARCHAR(512),
  "sha256" CHAR(64),
  "status" "ProjectAttachmentStatus" NOT NULL DEFAULT 'AWAITING_UPLOAD',
  "scan_version" INTEGER NOT NULL DEFAULT 0,
  "failure_code" VARCHAR(100),
  "scan_metadata" JSONB,
  "upload_expires_at" TIMESTAMPTZ(3) NOT NULL,
  "scanned_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "project_attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_attachments_size_check" CHECK ("size_bytes" > 0 AND "size_bytes" <= 10485760),
  CONSTRAINT "project_attachments_declared_content_type_check" CHECK ("declared_content_type" IN ('application/pdf', 'text/plain', 'image/png', 'image/jpeg', 'image/webp')),
  CONSTRAINT "project_attachments_detected_content_type_check" CHECK ("detected_content_type" IS NULL OR "detected_content_type" IN ('application/pdf', 'text/plain', 'image/png', 'image/jpeg', 'image/webp')),
  CONSTRAINT "project_attachments_sha256_check" CHECK ("sha256" IS NULL OR "sha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "project_attachments_clean_fields_check" CHECK (
    "status" <> 'CLEAN' OR
    ("clean_object_key" IS NOT NULL AND "sha256" IS NOT NULL AND "detected_content_type" IS NOT NULL AND "scanned_at" IS NOT NULL)
  )
);

CREATE TABLE "agent_run_attachments" (
  "run_id" UUID NOT NULL,
  "attachment_id" UUID NOT NULL,
  "file_name" VARCHAR(255) NOT NULL,
  "content_type" VARCHAR(100) NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "object_key" VARCHAR(1024) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_run_attachments_pkey" PRIMARY KEY ("run_id", "attachment_id"),
  CONSTRAINT "agent_run_attachments_size_check" CHECK ("size_bytes" > 0 AND "size_bytes" <= 10485760),
  CONSTRAINT "agent_run_attachments_content_type_check" CHECK ("content_type" IN ('application/pdf', 'text/plain', 'image/png', 'image/jpeg', 'image/webp')),
  CONSTRAINT "agent_run_attachments_sha256_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "project_attachments_quarantine_object_key_key" ON "project_attachments"("quarantine_object_key");
CREATE UNIQUE INDEX "project_attachments_clean_object_key_key" ON "project_attachments"("clean_object_key");
CREATE INDEX "project_attachments_project_id_status_created_at_idx" ON "project_attachments"("project_id", "status", "created_at");
CREATE INDEX "project_attachments_workspace_id_status_upload_expires_at_idx" ON "project_attachments"("workspace_id", "status", "upload_expires_at");
CREATE INDEX "agent_run_attachments_attachment_id_idx" ON "agent_run_attachments"("attachment_id");

ALTER TABLE "project_attachments" ADD CONSTRAINT "project_attachments_project_id_workspace_id_fkey" FOREIGN KEY ("project_id", "workspace_id") REFERENCES "projects"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_run_attachments" ADD CONSTRAINT "agent_run_attachments_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_run_attachments" ADD CONSTRAINT "agent_run_attachments_attachment_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "project_attachments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
