import { memo, useMemo } from "react";
import MarkdownIt from "markdown-it";
import katex from "@vscode/markdown-it-katex";
import "katex/dist/katex.min.css";
import { annotationLinkSpans, isAnnotationLink } from "../shared/annotation-links";

const mathPlugin =
  typeof katex === "function"
    ? katex
    : (katex as { default: typeof katex }).default;
const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
}).use(mathPlugin, { throwOnError: false, trust: false });
// Replies may contain arbitrary URLs. Images remain descriptions, never network requests.
markdown.renderer.rules.image = (tokens, index) =>
  markdown.utils.escapeHtml(tokens[index].content || "[图片]");

export const AgentMessage = memo(function AgentMessage({
  text,
  role,
  onError,
  onCitation,
}: {
  text: string;
  role: "user" | "assistant";
  onError: (message: string) => void;
  onCitation: (link: string) => void;
}) {
  const html = useMemo(
    () => role === "assistant" ? markdown.render(text) : "",
    [text, role],
  );
  const userContent = useMemo(() => {
    if (role !== "user") return null;
    let from = 0;
    const content = annotationLinkSpans(text).flatMap((link) => {
      const preceding = text.slice(from, link.from);
      from = link.to;
      return [preceding, <a key={link.from} href={link.href} onClick={(event) => {
        event.preventDefault(); onCitation(link.href);
      }}>{text.slice(link.from, link.to)}</a>];
    });
    return [...content, text.slice(from)];
  }, [text, role, onCitation]);
  if (role === "user") return <div className="message-text">{userContent}</div>;
  return (
    <div
      className="message-text chat-markdown"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(event) => {
        const link = (event.target as HTMLElement).closest("a");
        if (!link) return;
        event.preventDefault();
        const href = link.getAttribute("href") ?? "";
        if (href.startsWith("paper:") || isAnnotationLink(href)) {
          onCitation(href);
        } else if (/^https?:\/\//i.test(href)) {
          void window.desktop
            .openLink(href)
            .catch((error: Error) => onError(error.message));
        } else {
          onError("此链接暂不支持打开，请复制链接后查看。");
        }
      }}
    />
  );
});
