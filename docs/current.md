# 当前进度

v1.1.0 已发布，客户端实际使用验收通过；安装包见 [GitHub Release](https://github.com/attackingjensen/paper-30min/releases/tag/v1.1.0)。下一次交付定为 `v1.2.0-beta.1` 预发布，供隔离云主机验收；是否发布 v1.2.0 正式版待验收后决定。Beta 的更新器、建图续跑、正文建图范围和可选本地解析组件已在 `steven123397/dev` 实现。设置页现有服务、网络代理、技能库、关于四项；网络代理页仍为界面预览，更新器使用系统代理。

[v1.2.0 首轮发布审查](reviews/2026-09-24-v1.2-pre-release.md)的 4 个 P1 已修复。后续[复审](reviews/2026-09-24-v1.2-beta-followup.md)补齐了签名文件名核对、停流取消响应和重试提示；更新检查/下载无超时属既有问题，见 [#97](https://github.com/attackingjensen/paper-30min/issues/97)。Beta 发布前仍须重新构建并验证签名安装包，正式版还须完成云主机安装验收。客户端代码品质基线见[审查记录](reviews/2026-09-24-client-quality.md)。

修复后的 JavaScript 229 项、Rust 全量、语法检查 128 个文件、组件打包 6 项及发布清单 15 项测试通过；Beta 版本的桌面桥接 smoke 14/14、签名主程序构建、组件 ZIP 完整性和 `latest-beta.json` 复验通过。Windows 安装版的 v1.1.0 默认/自选路径升级、签名更新、组件安装及旧书库副本走查尚未完成，交由云主机预发布验收；更新器私钥及公钥已由用户确认独立备份。GitHub CI 因账户问题暂不可用，不记为通过。

## 待处理

- 发布门槛及验证步骤见 [v1.2.0 计划](plans/2026-09-24-1153-feat-v1-2-updater-map-recovery-plan.md)。v1.1.0 用户需手动安装 Beta；预发布不进入稳定版更新端点。
- 批量重挖的覆盖确认、编辑原文入口、PDF 按页懒加载、移除卡片后的附件清理。
- 存量 readMarks 孤儿与旧记录 parts 形态尚未迁移，语义见 [CONCEPTS.md](../CONCEPTS.md) 中的「阅读积累」。
- 解析组件仅支持 Windows；任务注册表为内存态，重启不恢复。云同步 [#25](https://github.com/attackingjensen/paper-30min/issues/25) 与 Android [#26](https://github.com/attackingjensen/paper-30min/issues/26) 尚未启动。
