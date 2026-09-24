# 当前进度

v1.1.0 已发布，客户端实际使用验收通过；安装包见 [GitHub Release](https://github.com/attackingjensen/paper-30min/releases/tag/v1.1.0)。

v2 前置的 Windows 客户端代码品质工作已开始。[审查记录](reviews/2026-09-24-client-quality.md) 保存改动前基线、已确认问题与未完成的原生验证；尚未达到 v2 放行条件。

## 发布后待补验证

- 升级、干净账户安装和卸载尚未完成走查；安装版解析时侧车无控制台黑窗也需一并确认。

## 待处理

- 批量重挖的覆盖确认、编辑原文入口、PDF 按页懒加载、移除卡片后的附件清理。
- 存量 readMarks 孤儿与旧记录 parts 形态尚未迁移，语义见 [CONCEPTS.md](../CONCEPTS.md) 中的「阅读积累」。
- 解析侧车仅支持 Windows；任务注册表为内存态，重启不恢复。
- 云同步 [#25](https://github.com/attackingjensen/paper-30min/issues/25) 与 Android [#26](https://github.com/attackingjensen/paper-30min/issues/26) 尚未启动。
