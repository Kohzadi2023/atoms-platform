import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("authenticated workspace exposes the durable Meeting preparation flow", async () => {
  const source = await readFile(
    resolve(process.cwd(), "src/components/workspace-meeting-experience.tsx"),
    "utf8",
  );

  assert.match(source, /WorkspaceShell/u);
  assert.match(source, /OliviaMeetingBriefAction/u);
  assert.match(source, /\.listMeetings\s*\(/u);
  assert.match(source, /\.createMeeting\s*\(/u);
  assert.match(source, /\.completeMeetingBriefAction\s*\(/u);
  assert.doesNotMatch(source, /\.createRun\s*\(/u);
});

test("Entra gate routes authenticated users through the workspace Meeting experience", async () => {
  const source = await readFile(
    resolve(process.cwd(), "src/components/entra-auth-gate.tsx"),
    "utf8",
  );

  assert.match(source, /WorkspaceExperience/u);
  assert.doesNotMatch(source, /import \{ WorkspaceShell \}/u);
});
