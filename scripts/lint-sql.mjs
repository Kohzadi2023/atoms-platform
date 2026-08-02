import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const roots = [
  "packages/db/prisma/migrations",
  "examples/generated-app-database/prisma/migrations",
];
const forbidden = [
  { pattern: /\bALTER\s+SYSTEM\b/iu, reason: "host-level configuration" },
  { pattern: /\bCOPY\b[\s\S]*\bPROGRAM\b/iu, reason: "host command execution" },
  { pattern: /\bDROP\s+DATABASE\b/iu, reason: "database destruction" },
  { pattern: /\bDROP\s+SCHEMA\s+(?:IF\s+EXISTS\s+)?public\b/iu, reason: "public schema destruction" },
  { pattern: /postgres(?:ql)?:\/\/[^\s"']+/iu, reason: "embedded database credential" },
  { pattern: /\b(?:password|secret|token)\s*=\s*'[^']+'/iu, reason: "embedded secret" },
];

const files = [];
for (const root of roots) await walk(root, files);

const failures = [];
for (const file of files) {
  const sql = await readFile(file, "utf8");
  for (const rule of forbidden) {
    if (rule.pattern.test(sql)) failures.push(`${file}: ${rule.reason}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`SQL/security lint passed for ${String(files.length)} migration files`);
}

async function walk(directory, output) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, output);
    else if (entry.isFile() && entry.name.endsWith(".sql")) output.push(path);
  }
}
