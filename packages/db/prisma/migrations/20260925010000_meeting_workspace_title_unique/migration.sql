-- Closes a create-meeting race: two concurrent "list, then create if missing" calls for
-- the same well-known meeting title (the only creation path today, see #127/#131) could
-- both observe no existing row and both insert, leaving whichever is newest non-deterministically
-- winning on every subsequent list. Deduplicate any rows already created that way (keep the
-- oldest, cascade its OliviaAssistedAction via FK) before adding the constraint that prevents it
-- going forward; the app now retries the existing row on conflict instead of failing.

DELETE FROM "meetings" a
USING "meetings" b
WHERE a."workspace_id" = b."workspace_id"
  AND a."title" = b."title"
  AND a."created_at" > b."created_at";

-- CreateIndex
CREATE UNIQUE INDEX "meetings_workspace_id_title_key" ON "meetings"("workspace_id", "title");
