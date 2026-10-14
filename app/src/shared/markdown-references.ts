import MarkdownIt from "markdown-it";
import katex from "@vscode/markdown-it-katex";
import type { CitationUse } from "./citations.js";

// Vite and NodeNext expose this CommonJS package through different interop shapes.
type MathPlugin = (md: InstanceType<typeof MarkdownIt>, options: { throwOnError: boolean; trust: boolean }) => void;
const mathPlugin = (typeof katex === "function" ? katex : (katex as unknown as { default: MathPlugin }).default) as MathPlugin;
export const markdownRenderer = new MarkdownIt({ html: false, linkify: true })
  .use(mathPlugin, { throwOnError: false, trust: false });

/** Shared token walk keeps the usage index and rendered link targets identical. */
export function markCitationUses(tokens: ReturnType<typeof markdownRenderer.parse>): Omit<CitationUse, "path" | "title" | "version">[] {
  const counts = new Map<string, number>();
  const uses: Omit<CitationUse, "path" | "title" | "version">[] = [];
  let line = 1;
  for (const block of tokens) {
    if (block.map) line = block.map[0] + 1;
    for (const token of block.children ?? []) {
      if (token.type !== "link_open") continue;
      const match = /^paper:\/\/cite\/([a-f0-9]{32})$/.exec(String(token.attrGet("href") ?? ""));
      if (!match) continue;
      const id = match[1];
      const occurrence = counts.get(id) ?? 0;
      counts.set(id, occurrence + 1);
      token.attrSet("data-citation-use", `${id}:${occurrence}`);
      uses.push({ id, occurrence, line,
        context: (block.children ?? []).map((child) =>
          child.type === "softbreak" || child.type === "hardbreak" ? " " : child.content)
          .join("").replace(/\s+/g, " ").slice(0, 240) });
    }
  }
  return uses;
}
