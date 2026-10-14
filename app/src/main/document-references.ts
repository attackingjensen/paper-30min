import MarkdownIt from "markdown-it";

export type DocumentReferenceProcessor = (
  root: string,
  text: string,
) => Promise<string>;
const markdown = new MarkdownIt({ html: false });

// The source dictionary slice supplies the resolver here. Until then, fail closed
// for source links rather than saving an unresolved Agent-generated identifier.
export const prepareDocumentReferences: DocumentReferenceProcessor = async (
  _root,
  text,
) => {
  for (const block of markdown.parse(text, {})) {
    for (const token of block.children ?? []) {
      if (
        token.type === "link_open" &&
        /^(paper30min-source:|paper30min:\/\/source\/)/i.test(
          String(token.attrGet("href") ?? ""),
        )
      )
        throw new Error("出处 ID 尚未接入字典校验，不能保存未验证的出处链接。");
    }
  }
  return text;
};
