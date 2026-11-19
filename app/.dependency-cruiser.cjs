/** Electron 进程边界；类型导入同样检查，避免单一 tsconfig 漏掉跨层契约。 */
module.exports = {
  forbidden: [
    {
      name: "renderer-cannot-import-main",
      severity: "error",
      from: { path: "^src/renderer/" },
      to: { path: "^src/main/" },
    },
    {
      name: "main-cannot-import-renderer",
      severity: "error",
      from: { path: "^src/main/" },
      to: { path: "^src/renderer/" },
    },
    {
      name: "shared-cannot-import-process-code",
      severity: "error",
      from: { path: "^src/shared/" },
      to: { path: "^src/(main|renderer)/" },
    },
    {
      name: "renderer-cannot-use-privileged-runtime",
      severity: "error",
      from: { path: "^src/renderer/" },
      to: {
        dependencyTypes: ["core"],
      },
    },
    {
      name: "renderer-cannot-import-electron",
      severity: "error",
      from: { path: "^src/renderer/" },
      to: { path: "(^electron$|node_modules/electron/)" },
    },
    {
      name: "shared-cannot-use-privileged-runtime",
      severity: "error",
      from: { path: "^src/shared/" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "shared-cannot-import-electron",
      severity: "error",
      from: { path: "^src/shared/" },
      to: { path: "(^electron$|node_modules/electron/)" },
    },
    {
      name: "preload-cannot-import-main-implementation",
      severity: "error",
      from: { path: "^src/main/preload\\.cts$" },
      to: { path: "^src/main/(?!preload\\.cts$)" },
    },
    {
      name: "preload-cannot-use-node",
      severity: "error",
      from: { path: "^src/main/preload\\.cts$" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "main-cannot-import-preload-bundle",
      severity: "error",
      from: { path: "^src/main/(?!preload\\.cts$)" },
      to: { path: "^src/main/preload\\.cts$" },
    },
    {
      // 通用文档合并不得理解来源语义：核验继承等侧车逻辑由调用方注入 commit 钩子（wp4）。
      name: "document-cannot-import-source-modules",
      severity: "error",
      from: { path: "^src/main/document/" },
      to: { path: "^src/main/(pdf|parsing|arxiv)/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // TS 7.0 的 tsc API 不受支持；SWC 直接解析 TS/TSX，仍保留 type-only import。
    parser: "swc",
    tsPreCompilationDeps: false,
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".cts", ".mts", ".js", ".jsx", ".json"],
    },
  },
};
