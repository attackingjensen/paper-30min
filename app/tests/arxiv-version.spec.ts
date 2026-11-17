import { test, expect } from "@playwright/test";
import { parseArxivReference } from "../src/main/arxiv/reference";
import {
  arxivLatestVersion,
  assertArxivVersionConsistent,
  resolveArxivVersion,
} from "../src/main/arxiv/version";
import { absHtml } from "./fixtures/arxiv-abs";

function reference(input: string) {
  const result = parseArxivReference(input);
  if (!result.ok) throw new Error(`fixture reference rejected: ${input}`);
  return result.reference;
}

test("arxiv-import 无版本引用从 abs 提交历史按整数取最新并固定", async () => {
  const html = absHtml({ id: "2401.01234", versions: [1, 2, 10] });
  const urls: string[] = [];
  const pinned = await resolveArxivVersion(reference("2401.01234"), async (url) => {
    urls.push(url);
    return html;
  });
  expect(pinned).toEqual({
    ok: true,
    reference: { baseId: "2401.01234", version: 10, canonicalId: "2401.01234v10" },
    absUrl: "https://arxiv.org/abs/2401.01234",
  });
  expect(urls).toEqual(["https://arxiv.org/abs/2401.01234"]);
});

test("arxiv-import 显式版本只读取该版本 abs，绝不改取最新版", async () => {
  const html = absHtml({ id: "2401.01234", versions: [1, 2, 10] });
  const urls: string[] = [];
  const pinned = await resolveArxivVersion(reference("2401.01234v2"), async (url) => {
    urls.push(url);
    return html;
  });
  expect(pinned).toEqual({
    ok: true,
    reference: { baseId: "2401.01234", version: 2, canonicalId: "2401.01234v2" },
    absUrl: "https://arxiv.org/abs/2401.01234v2",
  });
  expect(urls).toEqual(["https://arxiv.org/abs/2401.01234v2"]);
});

test("arxiv-import 显式版本在提交历史中不存在时明确失败，不回退其他版本", async () => {
  const html = absHtml({ id: "2401.01234", versions: [1, 2] });
  const result = await resolveArxivVersion(reference("2401.01234v3"), async () => html);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostic.code).toBe("arxiv-version-missing");
});

test("arxiv-import 无版本引用固定撤稿的最新版时报告撤稿，不自动采用上一版", async () => {
  const html = absHtml({ id: "2401.01234", versions: [1, 2], withdrawn: [2] });
  const result = await resolveArxivVersion(reference("2401.01234"), async () => html);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.diagnostic.code).toBe("arxiv-version-withdrawn");
    expect(result.diagnostic.messageKey).toBe("arxiv.version.withdrawn");
  }
});

test("arxiv-import 用户显式选择的历史版本即使标记撤稿也按该版本固定", async () => {
  const html = absHtml({ id: "2401.01234", versions: [1, 2], withdrawn: [2] });
  const result = await resolveArxivVersion(reference("2401.01234v2"), async () => html);
  expect(result).toEqual({
    ok: true,
    reference: { baseId: "2401.01234", version: 2, canonicalId: "2401.01234v2" },
    absUrl: "https://arxiv.org/abs/2401.01234v2",
  });
});

test("arxiv-import abs 无法确定版本时失败，不进入正文可读状态", async () => {
  const result = await resolveArxivVersion(
    reference("2401.01234"),
    async () => "<html><body>Service unavailable</body></html>",
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostic.code).toBe("arxiv-version-unresolved");
});

test("arxiv-import abs 身份与目标 base ID 不一致时拒绝，不冒充同论文", async () => {
  const html = absHtml({ id: "2401.99999", versions: [1] });
  const result = await resolveArxivVersion(reference("2401.01234"), async () => html);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostic.code).toBe("arxiv-identity-mismatch");
});

test("arxiv-import abs 获取失败时诊断保留在 resolve 阶段", async () => {
  const result = await resolveArxivVersion(reference("2401.01234"), async () => {
    throw new Error("socket hang up");
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.diagnostic.code).toBe("arxiv-abs-fetch-failed");
    expect(result.diagnostic.stage).toBe("resolve");
    expect(result.diagnostic.severity).toBe("fatal");
  }
});

test("arxiv-import 版本守卫：v10 按整数高于 v2，URL 版本后缀与元数据一致才放行", () => {
  const pinned = reference("2401.01234v10");
  expect(
    assertArxivVersionConsistent(pinned, "https://arxiv.org/html/2401.01234v10", {
      citationId: "2401.01234v10",
    }).ok,
  ).toBe(true);
  const mixedUrl = assertArxivVersionConsistent(
    pinned,
    "https://arxiv.org/html/2401.01234v2",
  );
  expect(mixedUrl.ok).toBe(false);
  if (!mixedUrl.ok) expect(mixedUrl.diagnostic.code).toBe("arxiv-version-mixed");
  const mixedMeta = assertArxivVersionConsistent(
    pinned,
    "https://arxiv.org/html/2401.01234v10",
    { citationId: "2401.01234v2" },
  );
  expect(mixedMeta.ok).toBe(false);
  if (!mixedMeta.ok) expect(mixedMeta.diagnostic.code).toBe("arxiv-version-mixed");
});

test("arxiv-import 版本守卫：不同 base ID 的响应是另一来源，不是版本混杂", () => {
  const result = assertArxivVersionConsistent(
    reference("2401.01234v2"),
    "https://arxiv.org/html/2401.99999v2",
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostic.code).toBe("arxiv-identity-mismatch");
});

test("arxiv-import 版本守卫：非允许 host 的最终 URL 被拒绝", () => {
  const result = assertArxivVersionConsistent(
    reference("2401.01234v2"),
    "https://cdn.example.com/html/2401.01234v2",
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostic.code).toBe("arxiv-source-host-rejected");
});

test("arxiv-import arxivLatestVersion 只信提交历史中的版本链接，忽略页面其他数字", () => {
  const html = absHtml({ id: "2401.01234", versions: [2, 10] });
  expect(arxivLatestVersion(html, "2401.01234")).toBe(10);
  expect(arxivLatestVersion("<html>v99 引用文字 2401.01234v88</html>", "2401.01234")).toBeNull();
});

test("arxiv-import 版本守卫 fail-closed：URL 与元数据都无版本时拒绝发布", () => {
  const pinned = reference("2401.01234v2");
  // 最终 URL 无版本后缀，元数据缺失。
  const noEvidence = assertArxivVersionConsistent(pinned, "https://arxiv.org/html/2401.01234");
  expect(noEvidence.ok).toBe(false);
  if (!noEvidence.ok) expect(noEvidence.diagnostic.code).toBe("arxiv-version-unproven");
  // 元数据存在但不带版本，同样无法证明。
  const unversionedMeta = assertArxivVersionConsistent(pinned, "https://arxiv.org/html/2401.01234", {
    citationId: "2401.01234",
  });
  expect(unversionedMeta.ok).toBe(false);
  if (!unversionedMeta.ok) expect(unversionedMeta.diagnostic.code).toBe("arxiv-version-unproven");
  // URL 无版本但元数据明确等于固定 vN：可证明，放行。
  const metaProves = assertArxivVersionConsistent(pinned, "https://arxiv.org/html/2401.01234", {
    citationId: "2401.01234v2",
  });
  expect(metaProves.ok).toBe(true);
  // URL 带版本且一致、无元数据：放行。
  expect(assertArxivVersionConsistent(pinned, "https://arxiv.org/html/2401.01234v2").ok).toBe(true);
});

test("arxiv-import resolve 阶段区分 404/403/429/取消，不折叠成同一诊断", async () => {
  const { ArxivFetchError } = await import("../src/main/arxiv/fetch");
  const cases: Array<[InstanceType<typeof ArxivFetchError>, string]> = [
    [new ArxivFetchError("arxiv-fetch-status", "https://arxiv.org/abs/2401.01234", 404), "arxiv.abs.notFound"],
    [new ArxivFetchError("arxiv-fetch-status", "https://arxiv.org/abs/2401.01234", 403), "arxiv.abs.forbidden"],
    [new ArxivFetchError("arxiv-fetch-status", "https://arxiv.org/abs/2401.01234", 429), "arxiv.abs.rateLimited"],
    [new ArxivFetchError("arxiv-fetch-tls", "https://arxiv.org/abs/2401.01234"), "arxiv.abs.tls"],
    [new ArxivFetchError("arxiv-fetch-stalled", "https://arxiv.org/abs/2401.01234"), "arxiv.abs.stalled"],
    [new ArxivFetchError("arxiv-fetch-cancelled", "https://arxiv.org/abs/2401.01234"), "arxiv.fetch.cancelled"],
  ];
  for (const [error, messageKey] of cases) {
    const result = await resolveArxivVersion(reference("2401.01234"), async () => { throw error; });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.stage).toBe("resolve");
      expect(result.diagnostic.messageKey).toBe(messageKey);
    }
  }
});
