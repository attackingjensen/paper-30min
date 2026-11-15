import MarkdownIt from "markdown-it";
import katex from "@vscode/markdown-it-katex";

// Vite and NodeNext expose this CommonJS package through different interop shapes.
type MathPlugin = (md: InstanceType<typeof MarkdownIt>, options: { throwOnError: boolean; trust: boolean }) => void;
const mathPlugin = (typeof katex === "function" ? katex : (katex as unknown as { default: MathPlugin }).default) as MathPlugin;
export const markdownRenderer = new MarkdownIt({ html: false, linkify: true })
  .use(mathPlugin, { throwOnError: false, trust: false });
