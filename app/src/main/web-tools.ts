import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { Type } from "typebox";
import {
  McpClient,
  McpHttpError,
  StreamableHttpTransport,
  type McpFetch,
} from "@earendil-works/pi-mcp";
import {
  defineTool,
  type SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { redact, redactData } from "./agent-tools.js";

const endpoint =
  "https://mcp.exa.ai/mcp?tools=web_search_advanced_exa,web_fetch_exa";
const inlineLimit = 12000;
const contentLimit = 100000;
interface StoredContent {
  responseId: string;
  text: string;
  kind: "search-excerpts" | "page-content";
}

function publicUrl(value: string) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    isIP(host) ||
    !host.includes(".") ||
    /\.(localhost|local|internal|test|invalid)$/.test(host)
  )
    throw new Error("网页读取仅支持不含凭据的公开 HTTP/HTTPS 域名。");
  return url.href;
}

function resultText(result: {
  content: unknown[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
}) {
  const text = result.content
    .flatMap((block: any) => (block.type === "text" ? [block.text] : []))
    .join("\n\n");
  if (
    result._meta?.["ai.exa/rateLimited"] ||
    /^You've hit Exa's free MCP rate limit/i.test(text.trim()) ||
    (result.isError && /rate.limit|quota exceeded/i.test(text))
  )
    throw new Error(
      "Exa 搜索服务限流，请稍后重试或在设置中配置自己的 Exa API key。",
    );
  if (result.isError) {
    if (/401|403|unauthori[sz]ed|invalid.*key|authentication/i.test(text))
      throw new Error("Exa 认证失败，请检查或移除设置中的 Exa API key。");
    throw new Error("Exa 无法获取结果，请调整查询或网页地址后重试。");
  }
  if (!text.trim()) throw new Error("Exa 返回空响应，请稍后重试。");
  return text;
}

// The full, bounded response lives in Pi's tool result, so reopening and branching
// use the same session history as the model. No shared plugin cache or credentials.
export function createWebTools(
  manager: SessionManager,
  fetch: McpFetch,
  credentials: { key?: string; keyError?: boolean },
  secrets: string[],
  active: () => boolean,
): ToolDefinition[] {
  async function call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (credentials.keyError)
      throw new Error("Exa 密钥无法读取，请在设置中替换或移除。");
    const deadline = AbortSignal.timeout(25000);
    const bounded = AbortSignal.any([deadline, ...(signal ? [signal] : [])]);
    const client = new McpClient({
      name: "Paper30Min",
      version: "2.0.0",
      requestTimeoutMs: 25000,
    });
    const stop = () => {
      void client.close();
    };
    bounded.addEventListener("abort", stop, { once: true });
    try {
      bounded.throwIfAborted();
      await client.connect(
        new StreamableHttpTransport({
          url: endpoint,
          headers: credentials.key ? { "x-api-key": credentials.key } : {},
          fetch: (url, init) =>
            fetch(url, {
              ...init,
              signal: AbortSignal.any([
                bounded,
                ...(init?.signal ? [init.signal] : []),
              ]),
            }),
          openGetStream: false,
          maxMessageBytes: 2 * 1024 * 1024,
          reconnect: { maxRetries: 0 },
        }),
      );
      const result = await client.callTool(name, redactData(args, secrets), {
        signal: bounded,
      });
      bounded.throwIfAborted();
      if (!active()) throw new Error("任务已停止：网络调研已停止。");
      return redact(resultText(result), secrets);
    } catch (error) {
      if (signal?.aborted || !active())
        throw new Error("任务已停止：网络调研已停止。");
      if (deadline.aborted || /timeout/i.test((error as Error).name))
        throw new Error("Exa 请求超时，请稍后重试。");
      const message = (error as Error).message;
      const status = error instanceof McpHttpError ? error.status : undefined;
      if (/^Exa /.test(message)) throw new Error(redact(message, secrets));
      if (status === 401 || status === 403)
        throw new Error("Exa 认证失败，请检查或移除设置中的 Exa API key。");
      if (status === 429)
        throw new Error(
          "Exa 搜索服务限流，请稍后重试或配置自己的 Exa API key。",
        );
      throw new Error("网络调研请求失败，请检查网络和代理后重试。");
    } finally {
      bounded.removeEventListener("abort", stop);
      await client.close();
    }
  }
  function stored(text: string, kind: StoredContent["kind"]) {
    const webContent: StoredContent = {
      responseId: randomUUID(),
      text: text.slice(0, contentLimit),
      kind,
    };
    const intro =
      kind === "search-excerpts"
        ? "以下仅为搜索摘录；需要论证时使用 fetch_content 读取相关网页。"
        : "以下为 Exa 实际提取的网页正文，最多 100000 字符；可能缺失动态、受限或超长内容，不代表已读网页全文。";
    return {
      content: [
        {
          type: "text" as const,
          text: `${intro}\nresponseId: ${webContent.responseId}\n${webContent.text.slice(0, inlineLimit)}\n${webContent.text.length > inlineLimit ? "内容未全部显示，请用 get_search_content 分段或查找。" : ""}`,
        },
      ],
      details: { webContent },
    };
  }
  return [
    defineTool({
      name: "web_search",
      label: "网络搜索",
      description:
        "Search external facts and research with Exa. Returns titles, URLs and excerpts, not proof that pages were fully read. Follow with fetch_content for relevant pages; synthesize findings rather than paste all links.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 2000 }),
        numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      }),
      async execute(_id, params, signal, update) {
        update?.({
          content: [{ type: "text", text: "正在搜索外部资料…" }],
          details: {},
        });
        const text = await call(
          "web_search_advanced_exa",
          {
            query: params.query,
            numResults: params.numResults ?? 5,
            textMaxCharacters: 1500,
            enableHighlights: true,
            highlightsMaxCharacters: 1500,
          },
          signal,
        );
        let data: any;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error("Exa 搜索响应格式无法识别，请稍后重试。");
        }
        if (!Array.isArray(data.results))
          throw new Error("Exa 搜索响应缺少结果，请稍后重试。");
        const results = data.results
          .slice(0, params.numResults ?? 5)
          .map((item: any) => ({
            title: String(item.title ?? ""),
            url: publicUrl(String(item.url)),
            excerpt: String(item.text ?? "").slice(0, 1500),
            highlights: Array.isArray(item.highlights)
              ? item.highlights.map(String).join("\n").slice(0, 1500)
              : "",
            publishedDate: item.publishedDate,
          }));
        return stored(
          results.length
            ? JSON.stringify(results, null, 2)
            : "没有找到匹配的外部资料。",
          "search-excerpts",
        );
      },
    }),
    defineTool({
      name: "fetch_content",
      label: "阅读网页",
      description:
        "Read clean page content from a public HTTP(S) URL using Exa. Does not upload project files. Use get_search_content to inspect long results. Extraction may be incomplete; cite only content actually read.",
      parameters: Type.Object({
        url: Type.String({ minLength: 1, maxLength: 4096 }),
      }),
      async execute(_id, params, signal, update) {
        const url = publicUrl(params.url);
        update?.({
          content: [{ type: "text", text: "正在读取网页正文…" }],
          details: {},
        });
        return stored(
          await call(
            "web_fetch_exa",
            { urls: [url], maxCharacters: contentLimit },
            signal,
          ),
          "page-content",
        );
      },
    }),
    defineTool({
      name: "get_search_content",
      label: "查阅网络资料",
      description:
        "Inspect previously returned web content in THIS session, including reopened sessions. Use offset/limit to read a slice or findText to locate a passage. Only the last 32 responses in the current branch are available.",
      parameters: Type.Object({
        responseId: Type.String(),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: inlineLimit }),
        ),
        findText: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      }),
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        if (!active()) throw new Error("任务已停止：网络调研已停止。");
        const records = manager
          .getBranch()
          .flatMap((entry): StoredContent[] => {
            if (
              entry.type !== "message" ||
              entry.message.role !== "toolResult" ||
              !["web_search", "fetch_content"].includes(
                entry.message.toolName,
              ) ||
              entry.message.isError
            )
              return [];
            const record = (
              entry.message.details as { webContent?: StoredContent }
            )?.webContent;
            return record ? [record] : [];
          })
          .slice(-32);
        const record = records.find(
          (item) => item.responseId === params.responseId,
        );
        if (!record)
          throw new Error("当前会话中找不到此网络资料，请重新搜索或读取网页。");
        if (
          params.findText &&
          (params.offset !== undefined || params.limit !== undefined)
        )
          throw new Error("查找文字时不能同时指定 offset 或 limit。");
        const match = params.findText
          ? record.text.search(
              new RegExp(
                params.findText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                "i",
              ),
            )
          : undefined;
        if (match === -1)
          return {
            content: [{ type: "text", text: "实际获取的内容中未找到该文字。" }],
            details: {
              responseId: record.responseId,
              offset: 0,
              nextOffset: null as number | null,
            },
          };
        const offset =
          match !== undefined ? Math.max(0, match - 500) : (params.offset ?? 0);
        const limit =
          match !== undefined ? 2000 : (params.limit ?? inlineLimit);
        if (offset > record.text.length)
          throw new Error("offset 超出实际获取内容的长度。");
        const end = Math.min(offset + limit, record.text.length);
        return {
          content: [
            {
              type: "text",
              text: `${record.kind}\nresponseId: ${record.responseId}\n字符 ${offset}-${end}/${record.text.length}\n${record.text.slice(offset, end)}\n${end < record.text.length ? `nextOffset: ${end}` : "已到实际获取内容末尾。"}`,
            },
          ],
          details: {
            responseId: record.responseId,
            offset,
            nextOffset: end < record.text.length ? end : null,
          },
        };
      },
    }),
  ];
}
