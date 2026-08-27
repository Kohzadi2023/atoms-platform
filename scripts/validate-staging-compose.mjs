import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { validateStagingDeployment } from "./check-staging-deployment.mjs";
import { createStagingDeploymentFixture } from "./staging-deployment-fixture.mjs";

const composeFile = fileURLToPath(
  new URL("../deploy/staging/compose.yaml", import.meta.url),
);
const fixture = await createStagingDeploymentFixture();

try {
  const preflight = await validateStagingDeployment({
    environmentFile: fixture.environmentFile,
    secretsDirectory: fixture.secretsDirectory,
  });
  if (!preflight.ok) {
    console.error("The generated staging Compose fixture failed preflight.");
    process.exitCode = 1;
  } else {
    const result = spawnSync(
      "docker",
      [
        "compose",
        "--env-file",
        fixture.environmentFile,
        "-f",
        composeFile,
        "config",
        "--quiet",
      ],
      { encoding: "utf8" },
    );
    if (result.error?.code === "ENOENT") {
      console.error("Docker Compose is required to validate the staging manifest.");
      process.exitCode = 1;
    } else if (result.status !== 0) {
      console.error("Docker Compose rejected the staging manifest.");
      const diagnostics = result.stderr?.trim() ?? "";
      if (diagnostics.length > 0) console.error(diagnostics);
      process.exitCode = 1;
    } else {
      console.log("Staging Docker Compose manifest is valid.");
    }
  }
} finally {
  await fixture.cleanup();
}
