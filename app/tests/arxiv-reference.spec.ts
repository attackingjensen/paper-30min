import { test, expect } from "@playwright/test";
import { arxivEndpointUrl, parseArxivReference } from "../src/main/arxiv/reference";

test("arxiv-import 解析新式裸 ID（4 位与 5 位序号、可选版本）", () => {
  expect(parseArxivReference("2401.01234")).toEqual({
    ok: true,
    reference: { baseId: "2401.01234", version: null, canonicalId: "2401.01234" },
  });
  expect(parseArxivReference("2401.01234v2")).toEqual({
    ok: true,
    reference: { baseId: "2401.01234", version: 2, canonicalId: "2401.01234v2" },
  });
  expect(parseArxivReference(" 2401.01234v10 ")).toEqual({
    ok: true,
    reference: { baseId: "2401.01234", version: 10, canonicalId: "2401.01234v10" },
  });
  expect(parseArxivReference("arXiv:2401.01234")).toEqual({
    ok: true,
    reference: { baseId: "2401.01234", version: null, canonicalId: "2401.01234" },
  });
});

test("arxiv-import 解析旧式 archive/YYMMNNN 标识符", () => {
  expect(parseArxivReference("hep-th/9901001")).toEqual({
    ok: true,
    reference: { baseId: "hep-th/9901001", version: null, canonicalId: "hep-th/9901001" },
  });
  expect(parseArxivReference("arXiv:hep-th/9901001v3")).toEqual({
    ok: true,
    reference: {
      baseId: "hep-th/9901001",
      version: 3,
      canonicalId: "hep-th/9901001v3",
    },
  });
  expect(parseArxivReference("math.GT/0309136v1")).toEqual({
    ok: true,
    reference: { baseId: "math.GT/0309136", version: 1, canonicalId: "math.GT/0309136v1" },
  });
});

test("arxiv-import 解析官方 abs/html/pdf URL 并规范化为 HTTPS 来源", () => {
  const expected = {
    ok: true,
    reference: { baseId: "2401.01234", version: 2, canonicalId: "2401.01234v2" },
  };
  expect(parseArxivReference("https://arxiv.org/abs/2401.01234v2")).toEqual(expected);
  expect(parseArxivReference("http://arxiv.org/html/2401.01234v2")).toEqual(expected);
  expect(parseArxivReference("https://arxiv.org/pdf/2401.01234v2")).toEqual(expected);
  expect(parseArxivReference("https://arxiv.org/pdf/2401.01234v2.pdf")).toEqual(expected);
  expect(parseArxivReference("https://ARXIV.ORG/abs/2401.01234v2")).toEqual(expected);
  expect(parseArxivReference("https://arxiv.org/html/2401.01234v2/")).toEqual(expected);
  expect(parseArxivReference("https://arxiv.org/abs/hep-th/9901001v3")).toEqual({
    ok: true,
    reference: {
      baseId: "hep-th/9901001",
      version: 3,
      canonicalId: "hep-th/9901001v3",
    },
  });
});

test("arxiv-import 拒绝从任意字符串中搜出类 ID", () => {
  expect(parseArxivReference("see 2401.01234 for details").ok).toBe(false);
  expect(parseArxivReference("x2401.01234").ok).toBe(false);
  expect(parseArxivReference("2401.01234 extra").ok).toBe(false);
});

test("arxiv-import 拒绝非法 host、凭据与非 HTTP(S) 协议", () => {
  expect(parseArxivReference("https://arxiv.org.evil.com/abs/2401.01234").ok).toBe(false);
  expect(parseArxivReference("https://evil.com/abs/2401.01234").ok).toBe(false);
  expect(parseArxivReference("https://user:pass@arxiv.org/abs/2401.01234").ok).toBe(false);
  expect(parseArxivReference("ftp://arxiv.org/abs/2401.01234").ok).toBe(false);
  expect(parseArxivReference("javascript:2401.01234").ok).toBe(false);
});

test("arxiv-import 拒绝路径穿越、编码绕过与不支持的端点", () => {
  expect(parseArxivReference("https://arxiv.org/abs/../pdf/2401.01234").ok).toBe(false);
  expect(parseArxivReference("https://arxiv.org/abs/2401.01234%2F..").ok).toBe(false);
  expect(parseArxivReference("https://arxiv.org/abs/%32%34%30%31.01234").ok).toBe(false);
  expect(parseArxivReference("https://arxiv.org/abs/2401.01234/../../etc").ok).toBe(false);
  expect(parseArxivReference("https://arxiv.org/list/2401.01234").ok).toBe(false);
  expect(parseArxivReference("https://arxiv.org/abs/").ok).toBe(false);
});

test("arxiv-import 拒绝伪造后缀与不支持的 query/fragment", () => {
  expect(parseArxivReference("2401.01234.pdf").ok).toBe(false);
  expect(parseArxivReference("2401.01234v2x").ok).toBe(false);
  expect(parseArxivReference("https://arxiv.org/pdf/2401.01234v2.exe").ok).toBe(false);
  expect(parseArxivReference("https://arxiv.org/abs/2401.01234v2.html").ok).toBe(false);
  expect(parseArxivReference("https://arxiv.org/abs/2401.01234?download=1").ok).toBe(false);
  expect(parseArxivReference("https://arxiv.org/abs/2401.01234#page2").ok).toBe(false);
});

test("arxiv-import 拒绝非法版本与非法日期序号", () => {
  expect(parseArxivReference("2401.01234v0").ok).toBe(false);
  expect(parseArxivReference("2401.01234v01").ok).toBe(false);
  expect(parseArxivReference("2413.01234").ok).toBe(false);
  expect(parseArxivReference("2400.01234").ok).toBe(false);
  expect(parseArxivReference("2401.012").ok).toBe(false);
  expect(parseArxivReference("hep-th/990101").ok).toBe(false);
});

test("arxiv-import 空输入被拒绝并给出稳定诊断", () => {
  const result = parseArxivReference("   ");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.diagnostic.code).toBe("arxiv-reference-invalid");
    expect(result.diagnostic.stage).toBe("resolve");
    expect(result.diagnostic.severity).toBe("fatal");
  }
});

test("arxiv-import 端点 URL 构造使用固定版本且 html/pdf 不改变来源身份", () => {
  const pinned = { baseId: "2401.01234", version: 2, canonicalId: "2401.01234v2" };
  expect(arxivEndpointUrl(pinned, "abs")).toBe("https://arxiv.org/abs/2401.01234v2");
  expect(arxivEndpointUrl(pinned, "html")).toBe("https://arxiv.org/html/2401.01234v2");
  expect(arxivEndpointUrl(pinned, "pdf")).toBe("https://arxiv.org/pdf/2401.01234v2");
  const unpinned = { baseId: "hep-th/9901001", version: null, canonicalId: "hep-th/9901001" };
  expect(arxivEndpointUrl(unpinned, "abs")).toBe("https://arxiv.org/abs/hep-th/9901001");
});
