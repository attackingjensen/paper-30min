# v1 客户端归档

`app/` 保存旧版 Tauri 客户端，供迁移、升级兼容和行为对照；新版 Electron 在仓库根目录 `app/` 开发，由 STE-76 建立。不将归档代码直接作为新版运行依赖。

旧版源码的仓库路径由 `app/` 改为 `legacy/v1/app/`。历史发布说明及研究记录中的旧路径按此映射，不重写历史证据。原型工作树、用户旧书库及备份不在本次归档范围。

从仓库根目录运行旧版检查：

```powershell
cd legacy/v1/app
node --test
npm run smoke
cd src-tauri
cargo test
```

根目录 `tools/release_manifest.mjs` 仍服务旧版签名与更新清单，默认读取归档版本信息；不能将其输出误当成 v2 发布产物。STE-90 实施新旧升级兼容时调整，STE-91 清理时保留所需信任链与迁移能力。现有 CI 指向归档客户端，不代表新版覆盖。

根目录 `skills/` 的旧阅读提示词仍被归档 Rust 编译嵌入，`tools/` 的旧版测试和解析工具保持可查阅。新版验收后按 STE-91 清理，不提前删除这些共享资源。
