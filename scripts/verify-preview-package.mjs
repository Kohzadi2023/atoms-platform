import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Legacy pnpm deploy may re-resolve transitive ranges. Require the portable
// production graph to be exactly the graph built from the frozen source lock.
export function productionGraph(manifestPath) {
  const graph = {};
  function visit(path) {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const id = manifest.name + "@" + manifest.version;
    if (graph[id]) return id;
    const dependencies = {};
    graph[id] = dependencies;
    const require = createRequire(path);
    for (const name of Object.keys(manifest.dependencies ?? {}).sort()) {
      let directory = dirname(realpathSync(require.resolve(name)));
      let dependency;
      for (;;) {
        const candidate = join(directory, "package.json");
        if (existsSync(candidate)) {
          const parsed = JSON.parse(readFileSync(candidate, "utf8"));
          if (parsed.name === name) { dependency = candidate; break; }
        }
        const parent = dirname(directory);
        if (parent === directory) throw new Error("Production dependency manifest missing");
        directory = parent;
      }
      dependencies[name] = visit(dependency);
    }
    return id;
  }
  visit(resolve(manifestPath));
  return graph;
}
export function verifyPreviewPackage(sourceManifest, deployedManifest) {
  assert.deepEqual(productionGraph(deployedManifest), productionGraph(sourceManifest));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 4);
    verifyPreviewPackage(process.argv[2], process.argv[3]);
    console.log("ATOMS_PREVIEW_PACKAGE_LOCKED_GRAPH_OK");
  } catch {
    console.error("ATOMS_PREVIEW_PACKAGE_LOCKED_GRAPH_FAILED");
    process.exitCode = 1;
  }
}
