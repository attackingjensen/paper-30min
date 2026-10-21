import { fromMarkdown } from "mdast-util-from-markdown";
import { markdownRenderer, markCitationUses } from "../shared/markdown-references.js";
import type { CitationPage, CitationRect } from "../shared/citations.js";
import { citationLink } from "../shared/citations.js";
import type { ParsedBlock } from "../shared/parsing.js";
import type { ResolvedReference } from "../shared/references.js";

function intersects(a: CitationRect, b: CitationRect) {
  return Math.min(a.origin.x + a.size.width, b.origin.x + b.size.width) > Math.max(a.origin.x, b.origin.x) &&
    Math.min(a.origin.y + a.size.height, b.origin.y + b.size.height) > Math.max(a.origin.y, b.origin.y);
}

/** Spatial candidates, never nearest-neighbour guesses. Overlapping candidate blocks remain ambiguous. */
export function matchBlocks(blocks: ParsedBlock[], pages: CitationPage[]) {
  const matched = blocks.filter(block => block.citation.pages.some(b => pages.some(p =>
    p.page === b.page && Math.abs(p.width - b.width) < .01 && Math.abs(p.height - b.height) < .01 &&
    (p.rects.length === 0 || p.rects.some(r => b.rects.some(s => intersects(r, s)))))));
  const ambiguous = matched.some((a, i) => matched.slice(i + 1).some(b =>
    a.citation.pages.some(p => b.citation.pages.some(q => p.page === q.page &&
      p.rects.some(r => q.rects.some(s => intersects(r, s)))))));
  return { blocks: matched, ambiguous };
}

/** Only real Markdown links count. A standalone source link belongs to the preceding top-level block. */
export function manuscriptLocations(text: string, path: string, blocks: ParsedBlock[]): ResolvedReference["manuscript"]["locations"] {
  // Use the same math/table-aware parser as candidate generation and document rendering.
  const tokens = markdownRenderer.parse(text, {});
  const containers = tokens.flatMap((token, index) => token.map && token.level === 0 && token.type !== "inline" ? [{ token, index }] : []);
  const wanted = new Map(blocks.map(block => [block.citation.id, block]));
  const tree = fromMarkdown(text);
  type Node = typeof tree | typeof tree.children[number];
  const walk = (node: Node, visit: (node: Node) => void) => {
    visit(node);
    if ("children" in node) for (const child of node.children) walk(child, visit);
  };
  const definitions = new Map<string, string>();
  walk(tree, node => { if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url); });
  const sourceLinks: { id: string; line: number }[] = [];
  walk(tree, node => {
    const href = node.type === "link" ? node.url : node.type === "linkReference" ? definitions.get(node.identifier) : undefined;
    const id = href && /^paper:\/\/cite\/([a-f0-9]{32})$/.exec(href)?.[1];
    if (id && node.position) sourceLinks.push({ id, line: node.position.start.line });
  });
  const locations: ResolvedReference["manuscript"]["locations"] = [];
  const linkOnly = (token: typeof tokens[number]) => {
    let depth = 0;
    let link = false;
    return !!token.children?.every(child => {
      if (child.type === "link_open") { depth++; link = true; return true; }
      if (child.type === "link_close") { depth--; return true; }
      return depth > 0 || child.type === "text" && !child.content.trim();
    }) && link;
  };
  for (const [index, container] of containers.entries()) {
    const nested = tokens.slice(container.index, containers[index + 1]?.index ?? tokens.length);
    const rendered = markCitationUses(nested);
    const candidates = sourceLinks.filter(link => link.line > container.token.map![0] && link.line <= container.token.map![1]);
    const previous = containers[index - 1];
    const inline = nested.find(t => t.type === "inline");
    const previousInline = previous && tokens.slice(previous.index, container.index).find(t => t.type === "inline");
    const standalone = container.token.type === "paragraph_open" && inline && linkOnly(inline);
    const usePrevious = standalone && previous && previous.token.type !== "hr" && (!previousInline || !linkOnly(previousInline));
    for (const link of candidates) {
      const block = wanted.get(link.id);
      // Source positions preserve newlines collapsed inside code spans. Rendering
      // decides which links are real (including tables, excluding math/code).
      // If the parsers disagree, do not invent an exact occurrence.
      if (!block || rendered.filter(use => use.id === link.id).length !== candidates.filter(use => use.id === link.id).length) continue;
      locations.push({ blockId: block.id, link: citationLink(link.id), path, linkLine: link.line,
        startLine: (usePrevious ? previous.token : container.token).map![0] + 1, endLine: container.token.map![1] });
    }
  }
  return locations;
}
