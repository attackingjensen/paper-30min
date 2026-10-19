import { fromMarkdown } from "mdast-util-from-markdown";

export interface AnnotationTarget { path: string; id: string }
export const isAnnotationLink = (href: string) => !/^[a-z][a-z0-9+.-]*:/i.test(href) && /#annotation=/.test(href);

const encode = (value: string) => encodeURIComponent(value)
  .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** An empty base denotes the project root (chat and the PDF clipboard). */
export function resolveAnnotationLink(href: string, base = ""): AnnotationTarget {
  if (base && (base.startsWith("/") || base.split("/").some((part) => !part || part === "." || part === ".." || /[\\:?#\x00-\x1f]/.test(part))))
    throw new Error("来源文档必须使用工程内路径。");
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/") || href.includes("\\"))
    throw new Error("批注链接必须使用工程内相对路径。");
  const hash = href.indexOf("#");
  if (hash < 0 || !href.slice(hash + 1).startsWith("annotation="))
    throw new Error("批注链接格式无效。");
  let id: string;
  let parts: string[];
  try {
    id = decodeURIComponent(href.slice(hash + 12));
    parts = href.slice(0, hash).split("/").map(decodeURIComponent);
  } catch { throw new Error("批注链接编码无效。"); }
  if (!id || id.length > 512 || /[\x00-\x1f\x7f]/.test(id)) throw new Error("批注 ID 无效。");
  const resolved = base ? base.split("/").slice(0, -1) : [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!resolved.length) throw new Error("批注链接超出工程目录。");
      resolved.pop();
    } else {
      if (/[\\/:?#\x00-\x1f]/.test(part)) throw new Error("批注链接路径无效。");
      resolved.push(part);
    }
  }
  const path = resolved.join("/");
  if (!/\.pdf$/i.test(path)) throw new Error("批注链接未指向 PDF。");
  return { path, id };
}

export function annotationHref(target: AnnotationTarget, base = ""): string {
  const directory = base ? base.split("/").slice(0, -1) : [];
  const parts = target.path.split("/");
  while (directory.length && parts.length && directory[0] === parts[0]) { directory.shift(); parts.shift(); }
  const relative = [...directory.map(() => ".."), ...parts].map(encode).join("/");
  return `${relative}#annotation=${encode(target.id)}`;
}

export function annotationKey(target: AnnotationTarget) { return annotationHref(target); }

/** Rewrite only parsed link/definition nodes; code spans and ordinary text stay byte-for-byte intact. */
export function rewriteAnnotationLinks(text: string, transform: (href: string) => string): string {
  const changes: { from: number; to: number; text: string }[] = [];
  function visit(node: ReturnType<typeof fromMarkdown> | ReturnType<typeof fromMarkdown>["children"][number]) {
    if ((node.type === "link" || node.type === "definition") && isAnnotationLink(node.url)) {
      const href = transform(node.url);
      if (href !== node.url && node.position) {
        const from = node.position.start.offset!;
        const to = node.position.end.offset!;
        const title = node.title ? ` "${node.title.replace(/[\\"]/g, "\\$&")}"` : "";
        if (node.type === "definition") {
          const label = /^\[(?:\\[\s\S]|[^\]\\])*\]:/.exec(text.slice(from, to))![0];
          changes.push({ from, to, text: `${label} ${href}${title}` });
        } else {
          const last = node.children.at(-1)?.position?.end.offset ?? from + 1;
          const label = text.slice(from + 1, last);
          changes.push({ from, to, text: `[${label}](${href}${title})` });
        }
        return;
      }
    }
    if ("children" in node) for (const child of node.children) visit(child);
  }
  visit(fromMarkdown(text));
  for (const change of changes.sort((a, b) => b.from - a.from))
    text = text.slice(0, change.from) + change.text + text.slice(change.to);
  return text;
}

/** Link source ranges also resolve reference-style definitions, without treating code as links. */
export function annotationLinkSpans(text: string): { from: number; to: number; href: string }[] {
  if (!text.includes("#annotation=")) return [];
  const tree = fromMarkdown(text);
  const definitions = new Map<string, string>();
  const links: { from: number; to: number; href: string }[] = [];
  type Node = typeof tree | typeof tree.children[number];
  const visit = (node: Node, action: (node: Node) => void) => {
    action(node);
    if ("children" in node) for (const child of node.children) visit(child, action);
  };
  visit(tree, (node) => {
    if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  });
  visit(tree, (node) => {
    const href = node.type === "link" ? node.url : node.type === "linkReference" ? definitions.get(node.identifier) : undefined;
    if (href && isAnnotationLink(href) && node.position)
      links.push({ from: node.position.start.offset!, to: node.position.end.offset!, href });
  });
  return links;
}

export function rebaseAnnotationLinks(text: string, from: string, to: string): string {
  return rewriteAnnotationLinks(text, (href) => annotationHref(resolveAnnotationLink(href, from), to));
}
