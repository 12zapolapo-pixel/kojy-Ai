/// <reference types="vite/client" />
/**
 * Monaco served from our own bundle (not a CDN), with only the languages bot
 * projects use. Loaded only by the project page.
 */
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

const BY_EXT: Record<string, string> = {
  py: "python", js: "javascript", mjs: "javascript", ts: "typescript", json: "json", yml: "yaml", yaml: "yaml",
  md: "markdown", toml: "ini", ini: "ini", cfg: "ini", env: "ini", sh: "shell", txt: "plaintext",
};

export function languageFor(path: string): string {
  return BY_EXT[path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";
}
