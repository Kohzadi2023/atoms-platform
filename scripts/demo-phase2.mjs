import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const controlApiUrl = process.env.CONTROL_API_URL ?? "http://localhost:3001";
const workspaceId = process.env.DEMO_WORKSPACE_ID;
const prompt =
  process.env.DEMO_PROMPT ??
  "Build a responsive customer portal with account summary and support requests.";

if (workspaceId === undefined) {
  throw new Error("DEMO_WORKSPACE_ID must reference an existing workspace UUID");
}

const suffix = Date.now().toString(36);
const project = await requestJson(`${controlApiUrl}/v1/projects`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    workspaceId,
    name: `Phase 2 Demo ${suffix}`,
    slug: `phase-2-demo-${suffix}`,
    description: "Prompt to validated E2B preview demonstration",
  }),
});
const run = await requestJson(
  `${controlApiUrl}/v1/projects/${project.id}/runs`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  },
);

console.log(`Project: ${project.id}`);
console.log(`Run: ${run.id}`);
console.log("Streaming ordered events…");

const response = await fetch(`${controlApiUrl}/v1/runs/${run.id}/events`, {
  headers: { accept: "text/event-stream" },
});
if (!response.ok || response.body === null) {
  throw new Error(`SSE request failed (${String(response.status)})`);
}

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let terminal = false;

while (!terminal) {
  const chunk = await reader.read();
  if (chunk.done) break;
  buffer += decoder.decode(chunk.value, { stream: true });
  let boundary = buffer.indexOf("\n\n");
  while (boundary >= 0) {
    const block = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    const event = parseEvent(block);
    if (event !== null) {
      console.log(
        `[${String(event.sequence).padStart(3, "0")}] ${event.eventType}`,
      );
      if (event.eventType === "approval.required") {
        const promptUi = createInterface({ input: stdin, output: stdout });
        const answer = await promptUi.question(
          "Mike requested approval. Continue to code generation? [y/N] ",
        );
        promptUi.close();
        if (answer.trim().toLowerCase() === "y") {
          await requestJson(`${controlApiUrl}/v1/runs/${run.id}/actions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "approve",
              reason: "Approved interactively by the Phase 2 demo operator",
            }),
          });
        } else {
          console.log("Run remains paused; no billable or destructive action was approved.");
          terminal = true;
        }
      }
      if (event.eventType === "preview.updated" && event.payload.status === "READY") {
        console.log(`Preview: ${event.payload.url}`);
      }
      if (["run.completed", "run.failed"].includes(event.eventType)) {
        terminal = true;
      }
    }
    boundary = buffer.indexOf("\n\n");
  }
}

await reader.cancel();

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const value = await response.json();
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${url} failed (${String(response.status)}): ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function parseEvent(block) {
  if (block.startsWith(":")) return null;
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return data.length === 0 ? null : JSON.parse(data);
}
