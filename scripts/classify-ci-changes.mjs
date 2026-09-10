import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function classifyCiChanges(paths, eventName = "pull_request") {
  const normalized = paths
    .map((path) => path.trim().replaceAll("\\", "/"))
    .filter((path) => path.length > 0);

  const webOnly =
    normalized.length > 0 &&
    normalized.every((path) => path.startsWith("apps/web/"));
  const fastPath = eventName === "pull_request" && webOnly;

  return {
    fastPath,
    fullCi: !fastPath,
    reason: fastPath
      ? "pull request changes are isolated to apps/web"
      : eventName !== "pull_request"
        ? "non-PR events always run full CI"
        : normalized.length === 0
          ? "no changed paths were supplied"
          : "changes reach outside apps/web",
  };
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
  }
  return input;
}

async function main() {
  const input = await readStdin();
  const paths = input.split(/\r?\n/u);
  const eventName = process.env.GITHUB_EVENT_NAME ?? "pull_request";
  const result = classifyCiChanges(paths, eventName);
  const output = [
    `fast_path=${String(result.fastPath)}`,
    `full_ci=${String(result.fullCi)}`,
  ].join("\n");

  if (process.env.GITHUB_OUTPUT !== undefined) {
    await appendFile(process.env.GITHUB_OUTPUT, `${output}\n`, "utf8");
  }

  console.log(`CI classification: ${result.reason}.`);
  console.log(output);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
