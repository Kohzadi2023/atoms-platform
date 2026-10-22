import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

// @monaco-editor/react loads Monaco from a public CDN unless it is given the
// bundled package. The Content Security Policy only allows script-src 'self', so
// the CDN loader was blocked and the editor stayed on "Loading...". Bundling the
// package keeps the policy strict. The runtime image ships .next/static but not
// public/, so the files must come from the bundler rather than a copied folder.
self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case "json":
        return new Worker(
          new URL("monaco-editor/language/json/json.worker.js", import.meta.url),
          { type: "module" },
        );
      case "css":
      case "scss":
      case "less":
        return new Worker(
          new URL("monaco-editor/language/css/css.worker.js", import.meta.url),
          { type: "module" },
        );
      case "typescript":
      case "javascript":
        return new Worker(
          new URL("monaco-editor/language/typescript/ts.worker.js", import.meta.url),
          { type: "module" },
        );
      default:
        return new Worker(
          new URL("monaco-editor/editor/editor.worker.js", import.meta.url),
          { type: "module" },
        );
    }
  },
};

loader.config({ monaco });
