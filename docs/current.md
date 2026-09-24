# 当前进度

v1.1.0 已发布，客户端实际使用验收通过；安装包见 [GitHub Release](https://github.com/attackingjensen/paper-30min/releases/tag/v1.1.0)。v1.2.0 的更新器、建图续跑、正文建图范围和可选本地解析组件已在 `steven123397/dev` 实现，尚未发布。设置页现有服务、网络代理、技能库、关于四项；网络代理页仍为界面预览，更新器使用系统代理。

[v1.2.0 发布前代码审查](reviews/2026-09-24-v1.2-pre-release.md) 发现 4 个 P1 阻断项（[#93](https://github.com/attackingjensen/paper-30min/issues/93) 至 [#96](https://github.com/attackingjensen/paper-30min/issues/96)）及组件生命周期、界面并发问题。修复、复审及重新构建签名安装包之前不得发布。客户端代码品质基线与分批修复见[审查记录](reviews/2026-09-24-client-quality.md)。

本次提交前 JavaScript 224/224、语法检查 128 个文件、桌面桥接 smoke 14/14、组件打包测试 6/6、发布清单测试 3/3 通过。Rust 全量测试有 1 项常驻解析用例失败，单独复跑通过；全量测试不能标为通过，后续需排查并重跑。Windows 安装版的 v1.1.0 默认/自选路径升级、签名更新、组件安装及旧书库副本走查尚未完成；更新器私钥的独立备份尚未确认。GitHub CI 因账户问题暂不可用，不记为通过。

## 待处理

- 发布门槛及验证步骤见 [v1.2.0 计划](plans/2026-09-24-1153-feat-v1-2-updater-map-recovery-plan.md)。v1.1.0 用户仍需手动安装 v1.2.0。
- 批量重挖的覆盖确认、编辑原文入口、PDF 按页懒加载、移除卡片后的附件清理。
- 存量 readMarks 孤儿与旧记录 parts 形态尚未迁移，语义见 [CONCEPTS.md](../CONCEPTS.md) 中的「阅读积累」。
- 解析组件仅支持 Windows；任务注册表为内存态，重启不恢复。云同步 [#25](https://github.com/attackingjensen/paper-30min/issues/25) 与 Android [#26](https://github.com/attackingjensen/paper-30min/issues/26) 尚未启动。
