import type { ArxivReference, ImportDiagnostic } from "../../shared/arxiv.js";

// 显式 arXiv host 允许清单（SPEC-arxiv-import §1.3）。
const ARXIV_ALLOWED_HOSTS: Record<string, true> = { "arxiv.org": true };
// 回环端点仅用于受控本地 fixtures（http），生产 arXiv 来源始终 https://arxiv.org。
const FIXTURE_LOOPBACK_HOSTS: Record<string, true> = {
  "127.0.0.1": true,
  localhost: true,
  "::1": true,
};

function isAllowedArxivHost(hostname: string): boolean {
  return ARXIV_ALLOWED_HOSTS[hostname.toLowerCase()] === true;
}

export function isAllowedSourceHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ARXIV_ALLOWED_HOSTS[host] === true || FIXTURE_LOOPBACK_HOSTS[host] === true;
}

export type ArxivEndpoint = "abs" | "html" | "pdf";

export type ArxivReferenceParseResult =
  | { ok: true; reference: ArxivReference }
  | { ok: false; diagnostic: ImportDiagnostic };

const NEW_STYLE = /^(\d{2}(?:0[1-9]|1[0-2])\.\d{4,5})(?:v([1-9]\d*))?$/;
const OLD_STYLE = /^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v([1-9]\d*))?$/;
const ARXIV_PREFIX = /^arxiv:/i;
const URL_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//i;

function invalid(messageKey: string): ArxivReferenceParseResult {
  return {
    ok: false,
    diagnostic: {
      code: "arxiv-reference-invalid",
      severity: "fatal",
      stage: "resolve",
      messageKey,
    },
  };
}

function reference(baseId: string, versionText: string | undefined): ArxivReferenceParseResult {
  const version = versionText === undefined ? null : Number(versionText);
  return {
    ok: true,
    reference: {
      baseId,
      version,
      canonicalId: version === null ? baseId : `${baseId}v${version}`,
    },
  };
}

function parseIdentifier(text: string): ArxivReferenceParseResult {
  const match = NEW_STYLE.exec(text) ?? OLD_STYLE.exec(text);
  if (!match) return invalid("arxiv.reference.unrecognized");
  return reference(match[1], match[2]);
}

function parseUrl(input: string): ArxivReferenceParseResult {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return invalid("arxiv.reference.urlMalformed");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return invalid("arxiv.reference.protocol");
  if (url.username !== "" || url.password !== "") return invalid("arxiv.reference.credentials");
  if (!isAllowedArxivHost(url.hostname)) return invalid("arxiv.reference.host");
  // 编码斜杠、点段与百分号编码一律拒绝，杜绝路径穿越与编码绕过。
  // WHATWG URL 会静默归一化点段，因此穿越检查必须作用于原始输入路径。
  const rawPath = input.slice(input.indexOf("://") + 3).replace(/^[^/?#]*/, "");
  if (rawPath.includes("%") || rawPath.split(/[/?#]/).some((segment) => segment === ".." || segment === "."))
    return invalid("arxiv.reference.path");
  // query/fragment 不得静默改变来源含义：出现即拒绝。
  if (url.search !== "" || url.hash !== "") return invalid("arxiv.reference.queryOrFragment");
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) return invalid("arxiv.reference.endpoint");
  const [endpoint, ...idSegments] = segments;
  if (endpoint !== "abs" && endpoint !== "html" && endpoint !== "pdf") return invalid("arxiv.reference.endpoint");
  let text = idSegments.join("/");
  if (endpoint === "pdf" && text.endsWith(".pdf")) text = text.slice(0, -4);
  return parseIdentifier(text);
}

/**
 * 严格解析完整输入：裸新旧式 ID、`arXiv:` 前缀或官方 abs/html/pdf URL。
 * 绝不从任意字符串中搜出类 ID；非法输入在网络与工程写入前拒绝。
 */
export function parseArxivReference(input: string): ArxivReferenceParseResult {
  const text = input.trim();
  if (text === "") return invalid("arxiv.reference.empty");
  if (URL_PREFIX.test(text)) return parseUrl(text);
  return parseIdentifier(text.replace(ARXIV_PREFIX, ""));
}

/** 构造规范化 HTTPS 端点 URL；已固定版本必须携带 vN。 */
export function arxivEndpointUrl(referenceValue: ArxivReference, endpoint: ArxivEndpoint): string {
  const id = referenceValue.version === null ? referenceValue.baseId : referenceValue.canonicalId;
  return `https://arxiv.org/${endpoint}/${id}`;
}
