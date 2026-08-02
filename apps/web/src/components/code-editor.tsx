"use client";

import dynamic from "next/dynamic";

const MonacoEditor = dynamic(
  () => import("@monaco-editor/react").then((module) => module.Editor),
  {
    ssr: false,
    loading: () => (
      <div
        className="grid h-full place-items-center bg-[#090d13] text-sm text-[#98a5b7]"
        role="status"
      >
        Loading editor…
      </div>
    ),
  },
);

export interface CodeEditorProps {
  readonly path: string;
  readonly language: string;
  readonly value: string;
  readonly readOnly?: boolean;
  readonly onChange?: (value: string) => void;
}

export function CodeEditor({
  path,
  language,
  value,
  readOnly = false,
  onChange,
}: CodeEditorProps) {
  return (
    <div className="workspace-editor overflow-hidden rounded-xl border border-[#252d3a]">
      <MonacoEditor
        path={`${readOnly ? "readonly:" : "project:"}${path}`}
        language={language}
        value={value}
        theme="vs-dark"
        onChange={(next) => onChange?.(next ?? "")}
        options={{
          readOnly,
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 13,
          fontLigatures: true,
          lineHeight: 21,
          padding: { top: 14, bottom: 14 },
          renderWhitespace: "selection",
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          tabSize: 2,
          wordWrap: "on",
          ariaLabel: `${readOnly ? "Read-only" : "Editable"} source for ${path}`,
        }}
      />
    </div>
  );
}
