import { randomUUID } from "node:crypto";

const controlApiUrl = process.env.DEMO_CONTROL_API_URL ?? "http://127.0.0.1:3001";
const projectId = requireUuid("DEMO_PROJECT_ID");
const migrationArtifactId =
  process.env.DEMO_MIGRATION_ARTIFACT_ID === undefined
    ? (await request(`/v1/projects/${projectId}/migration-artifacts/latest`)).id
    : requireUuid("DEMO_MIGRATION_ARTIFACT_ID");

if (process.env.DEMO_ALLOW_BILLABLE_DATABASE !== "true") {
  throw new Error(
    "Set DEMO_ALLOW_BILLABLE_DATABASE=true to explicitly confirm Supabase provisioning",
  );
}

const created = await request(
  `/v1/projects/${projectId}/databases`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key":
        process.env.DEMO_IDEMPOTENCY_KEY ?? `phase3-demo-${randomUUID()}`,
    },
    body: JSON.stringify({
      provider: "SUPABASE",
      region: process.env.DEMO_DATABASE_REGION ?? "americas",
      migrationArtifactId,
      approveDestructiveChanges:
        process.env.DEMO_APPROVE_DESTRUCTIVE_CHANGES === "true",
      confirmation: "PROVISION_DATABASE",
    }),
  },
);

console.log(
  JSON.stringify(
    {
      databaseInstanceId: created.id,
      operationId: created.operationId,
      status: created.status,
    },
    null,
    2,
  ),
);

let current = created;
for (let attempt = 0; attempt < 180; attempt += 1) {
  if (["READY", "FAILED", "DELETED"].includes(current.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  current = await request(
    `/v1/projects/${projectId}/databases/${created.id}`,
  );
  console.log(`${new Date().toISOString()} ${current.status}`);
}

if (current.status !== "READY") {
  throw new Error(`Database operation ended in ${current.status}`);
}

console.log("Provision -> health -> migrate -> seed -> connect completed.");

if (process.env.DEMO_DESTROY_DATABASE === "true") {
  const destroyed = await request(
    `/v1/projects/${projectId}/databases/${created.id}/actions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "destroy",
        confirmation: "DESTROY_DATABASE",
      }),
    },
  );
  console.log(`Confirmed teardown queued: ${destroyed.status}`);
}

async function request(path, init) {
  const response = await fetch(`${controlApiUrl}${path}`, init);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(body)}`,
    );
  }
  return body;
}

function requireUuid(name) {
  const value = process.env[name];
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new Error(`${name} must be a UUID`);
  }
  return value;
}
