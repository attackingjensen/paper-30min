import { memo, useMemo } from "react";
import MarkdownIt from "markdown-it";
import katex from "@vscode/markdown-it-katex";
import "katex/dist/katex.min.css";
import { isSourceLink, userMessageDisplayText } from "../shared/chat-input";

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
    () => markdown.render(role === "user" ? userMessageDisplayText(text) : text),
    [text, role],
  );
  return (
    <div
      className="message-text chat-markdown"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(event) => {
        const link = (event.target as HTMLElement).closest("a");
        if (!link) return;
        event.preventDefault();
        const href = link.getAttribute("href") ?? "";
        if (isSourceLink(href)) {
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
