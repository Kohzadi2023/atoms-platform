import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { classifyCiChanges } from "./classify-ci-changes.mjs";

const classifierPath = fileURLToPath(
  new URL("./classify-ci-changes.mjs", import.meta.url),
);

test("uses the fast path for pull requests isolated to apps/web", () => {
  assert.deepEqual(
    classifyCiChanges(
      [
        "apps/web/src/components/workspace-shell.tsx",
        "apps/web/src/lib/control-api.ts",
      ],
      "pull_request",
    ),
    {
      fastPath: true,
      fullCi: false,
      reason: "pull request changes are isolated to apps/web",
    },
  );
});

test("fails closed to full CI when a shared contract changes", () => {
  const result = classifyCiChanges(
    ["apps/web/app/page.tsx", "packages/contracts/src/api.ts"],
    "pull_request",
  );
  assert.equal(result.fastPath, false);
  assert.equal(result.fullCi, true);
});

test("fails closed to full CI when workflow or scripts change", () => {
  for (const path of [".github/workflows/ci.yml", "scripts/check-local-development.mjs"]) {
    const result = classifyCiChanges([path], "pull_request");
    assert.equal(result.fastPath, false);
    assert.equal(result.fullCi, true);
  }
});

test("pushes to main always run full CI even for web-only changes", () => {
  const result = classifyCiChanges(["apps/web/app/page.tsx"], "push");
  assert.equal(result.fastPath, false);
  assert.equal(result.fullCi, true);
  assert.match(result.reason, /always run full CI/u);
});

test("empty input fails closed to full CI", () => {
  const result = classifyCiChanges([], "pull_request");
  assert.equal(result.fastPath, false);
  assert.equal(result.fullCi, true);
});

test("CLI reads changed paths from stdin on the supported Node runtime", () => {
  const result = spawnSync(process.execPath, [classifierPath], {
    input: "apps/web/app/page.tsx\napps/web/src/lib/control-api.ts\n",
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_OUTPUT: "",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fast_path=true/u);
  assert.match(result.stdout, /full_ci=false/u);
});
