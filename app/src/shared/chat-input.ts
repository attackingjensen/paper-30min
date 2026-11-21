import { fromMarkdown } from "mdast-util-from-markdown";

export type ChatAttachment = { kind: "document" | "skill"; value: string; label: string };

const sourceSnapshotLabel = "发送时的来源快照（选区为关注范围；正文请按位置 read，按需 read_pdf）：";
const isLegacySourceLink = (href: string) =>
  /^paper:\/\/cite\/[a-f0-9]{32}$/.test(href) || (!/^[a-z][a-z0-9+.-]*:/i.test(href) && /#annotation=/.test(href));

/** Display projection only: Pi retains the complete evidence, including in old sessions. */
export function userMessageDisplayText(text: string): string {
  const nodes = fromMarkdown(text).children;
  // An unfinished user fence can swallow the appended source. Close it only in
  // the display copy, after independently recognizing a generated snapshot.
  for (const node of nodes) {
    if (node.type !== "code" || !node.position) continue;
    const start = node.position.start.offset!;
    const raw = text.slice(start, node.position.end.offset!);
    const fence = raw.match(/^ {0,3}(`{3,}|~{3,})/);
    const boundary = raw.indexOf("\n\n[来源](<");
    if (!fence || boundary < 0) continue;
    const closing = raw
      .split("\n")
      .at(-1)!
      .match(/^ {0,3}(`{3,}|~{3,})\s*$/)?.[1];
    // Only the generated JSON's exact three-backtick closer can accidentally
    // close a user fence. A real outer closer means this is a code example.
    if (closing?.[0] === fence[1][0] && closing.length >= fence[1].length && !(fence[1] === "```" && closing === "```"))
      continue;
    const sourceStart = start + boundary + 2;
    const suffix = text.slice(sourceStart, node.position.end.offset!);
    const first = fromMarkdown(suffix).children;
    if (
      first[1]?.type !== "paragraph" ||
      first[1].children.length !== 1 ||
      first[1].children[0].type !== "text" ||
      first[1].children[0].value !== sourceSnapshotLabel
    )
      continue;
    const display = userMessageDisplayText(suffix);
    if (display !== suffix)
      return userMessageDisplayText(text.slice(0, sourceStart) + fence[1] + "\n\n" + text.slice(sourceStart));
  }
  const ranges: { from: number; to: number }[] = [];
  for (let i = 0; i < nodes.length - 2; i++) {
    const [source, label, code] = nodes.slice(i, i + 3);
    if (source.type !== "paragraph" || source.children.length !== 1) continue;
    const link = source.children[0];
    if (
      link.type !== "link" ||
      !isLegacySourceLink(link.url) ||
      link.children.length !== 1 ||
      link.children[0].type !== "text" ||
      link.children[0].value !== "来源"
    )
      continue;
    if (
      label.type !== "paragraph" ||
      label.children.length !== 1 ||
      label.children[0].type !== "text" ||
      label.children[0].value !== sourceSnapshotLabel ||
      code.type !== "code" ||
      code.lang !== "json"
    )
      continue;
    try {
      const snapshot = JSON.parse(code.value);
      if (
        !snapshot ||
        !["citation", "annotation"].includes(snapshot.kind) ||
        snapshot.status !== "available" ||
        typeof snapshot.path !== "string" ||
        typeof snapshot.sha256 !== "string" ||
        !Array.isArray(snapshot.pages)
      )
        continue;
    } catch {
      continue;
    }
    ranges.push({ from: label.position!.start.offset!, to: code.position!.end.offset! });
  }
  for (const { from, to } of ranges.reverse()) text = text.slice(0, from) + text.slice(to);
  return text;
}
