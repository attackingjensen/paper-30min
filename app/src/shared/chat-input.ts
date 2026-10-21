import { fromMarkdown } from "mdast-util-from-markdown";
import { annotationHref, isAnnotationLink, resolveAnnotationLink } from "./annotation-links.js";

export type ChatAttachment = { kind: "source" | "document" | "skill"; value: string; label: string };
export const isSourceLink = (href: string) => /^paper:\/\/cite\/[a-f0-9]{32}$/.test(href) || isAnnotationLink(href);

/** Parse Markdown before extracting links so code and parenthesized paths keep their meaning. */
export function extractChatSources(text: string) {
  const tree = fromMarkdown(text);
  const attachments: ChatAttachment[] = [];
  const ranges: { from: number; to: number; replacement: string }[] = [];
  const definitions = new Map<string, string>();
  const usedDefinitions = new Set<string>();
  type Node = typeof tree | typeof tree.children[number];
  function walk(node: Node, action: (node: Node) => void) {
    action(node);
    if ("children" in node) for (const child of node.children) walk(child, action);
  }
  walk(tree, node => { if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url); });
  function add(value: string, from: number, to: number, label = value, replacement = "") {
    if (isAnnotationLink(value)) {
      try { value = annotationHref(resolveAnnotationLink(value)); } catch { /* Keep invalid sources visible for preview/send feedback. */ }
    }
    if (!attachments.some(item => item.value === value)) attachments.push({ kind: "source", value, label });
    ranges.push({ from, to, replacement });
  }
  function visit(node: Node) {
    const href = node.type === "link" ? node.url : node.type === "linkReference" ? definitions.get(node.identifier) : undefined;
    if (href && isSourceLink(href) && node.position) {
      if (node.type === "linkReference") usedDefinitions.add(node.identifier);
      const visibleText = (child: Node): string => "value" in child ? String(child.value) : "children" in child ? child.children.map(visibleText).join("") : "";
      const label = "children" in node ? node.children.map(visibleText).join("") : "";
      const first = "children" in node ? node.children[0]?.position?.start.offset : undefined;
      const last = "children" in node ? node.children.at(-1)?.position?.end.offset : undefined;
      const replacement = label === href ? "" : first !== undefined && last !== undefined ? text.slice(first, last) : label;
      add(href, node.position.start.offset!, node.position.end.offset!, label || href, replacement);
      return;
    }
    if (node.type === "text" && node.position) {
      const start = node.position.start.offset!;
      const raw = text.slice(start, node.position.end.offset!);
      for (const match of raw.matchAll(/[^\s<>`]+/g))
        if (isSourceLink(match[0])) add(match[0], start + match.index, start + match.index + match[0].length);
    } else if ("children" in node) for (const child of node.children) visit(child);
  }
  visit(tree);
  walk(tree, node => {
    if (node.type === "definition" && usedDefinitions.has(node.identifier) && node.position)
      ranges.push({ from: node.position.start.offset!, to: node.position.end.offset!, replacement: "" });
  });
  for (const range of ranges.sort((a, b) => b.from - a.from)) text = text.slice(0, range.from) + range.replacement + text.slice(range.to);
  return { text, attachments };
}
