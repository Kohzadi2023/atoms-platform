import { readdir, readFile } from "node:fs/promises";
import { extname, relative } from "node:path";

const repositoryRoot = new URL("../", import.meta.url);
const ignoredDirectories = new Set([
  ".git",
  ".pnpm-store",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);
const ignoredFiles = new Set([".env.example"]);
const textExtensions = new Set([
  "",
  ".cjs",
  ".dockerignore",
  ".env",
  ".json",
  ".js",
  ".md",
  ".mjs",
  ".prisma",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const signatures = [
  {
    name: "private key",
    pattern: new RegExp("-----BEGIN " + "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
  },
  {
    name: "AWS access key",
    pattern: new RegExp("A" + "KIA[0-9A-Z]{16}"),
  },
  {
    name: "GitHub token",
    pattern: new RegExp("g" + "h[pousr]_[A-Za-z0-9]{30,}"),
  },
  {
    name: "OpenAI-style secret",
    pattern: new RegExp("s" + "k-[A-Za-z0-9_-]{24,}"),
  },
  {
    name: "Stripe live secret",
    pattern: new RegExp("s" + "k_live_[A-Za-z0-9]{16,}"),
  },
];

const files = await collectFiles(repositoryRoot);
const findings = [];
for (const url of files) {
  const content = await readFile(url, "utf8");
  for (const signature of signatures) {
    if (signature.pattern.test(content)) {
      findings.push({
        file: relative(repositoryRoot.pathname, url.pathname),
        signature: signature.name,
      });
    }
  }
}

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`${finding.file}: possible ${finding.signature}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed (${String(files.length)} text files checked)`);
}

async function collectFiles(directoryUrl) {
  const entries = await readdir(directoryUrl, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    if (entry.isFile() && ignoredFiles.has(entry.name)) continue;
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directoryUrl);
    if (entry.isDirectory()) {
      found.push(...(await collectFiles(child)));
    } else if (
      entry.isFile() &&
      textExtensions.has(extname(entry.name).toLowerCase())
    ) {
      found.push(child);
    }
  }
  return found;
}
