import { rebaseAnnotationLinks } from "../shared/annotation-links";

function metadata(root: string, base: string) {
  const element = document.createElement("span");
  element.dataset.paper30minClipboard = JSON.stringify({ root, base });
  return element.outerHTML;
}

export async function copyAnnotationMarkdown(text: string, root: string, base = "") {
  await navigator.clipboard.write([new ClipboardItem({
    "text/plain": new Blob([text], { type: "text/plain" }),
    "text/html": new Blob([metadata(root, base)], { type: "text/html" }),
  })]);
}

export function copiedAnnotationText(data: DataTransfer, root: string, base: string): string | null {
  const html = new DOMParser().parseFromString(data.getData("text/html"), "text/html");
  const value = html.querySelector<HTMLElement>("[data-paper30min-clipboard]")?.dataset.paper30minClipboard;
  if (!value) return null;
  const origin = JSON.parse(value) as { root: string; base: string };
  if (origin.root !== root) throw new Error("批注链接来自另一工程，请先打开原工程。");
  return rebaseAnnotationLinks(data.getData("text/plain"), origin.base, base);
}

export function setAnnotationClipboard(data: DataTransfer, text: string, root: string, base: string) {
  data.setData("text/plain", text);
  data.setData("text/html", metadata(root, base));
}
