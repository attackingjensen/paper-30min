# 当前进度

v1.1.0 是当前正式版，客户端实际使用验收通过；安装包见 [GitHub Release](https://github.com/attackingjensen/paper-30min/releases/tag/v1.1.0)。[v1.2.0-beta.2](https://github.com/attackingjensen/paper-30min/releases/tag/v1.2.0-beta.2) 已作为仅含主程序的预发布版提供，解析组件继续使用 [Beta.1](https://github.com/attackingjensen/paper-30min/releases/tag/v1.2.0-beta.1) 的附件。正式版是否发布待安装版验收后决定。Beta 交付了更新器、建图续跑、正文建图范围和可选本地解析组件。设置页现有服务、网络代理、技能库、关于四项；网络代理页仍为界面预览，更新器使用系统代理。

[v1.2.0 首轮发布审查](reviews/2026-09-24-v1.2-pre-release.md)的 4 个 P1 已修复。后续[复审](reviews/2026-09-24-v1.2-beta-followup.md)补齐了签名文件名核对、停流取消响应和重试提示；更新检查/下载无超时属既有问题，见 [#97](https://github.com/attackingjensen/paper-30min/issues/97)。Beta 已构建并验证签名安装包，正式版仍须完成 Windows 安装版验收。客户端代码品质基线见[审查记录](reviews/2026-09-24-client-quality.md)。

Beta 发布前的 JavaScript 229 项、Rust 全量、语法检查 128 个文件、组件打包 6 项及发布清单 15 项测试通过；Beta 版本的桌面桥接 smoke 14/14、签名主程序构建、组件 ZIP 完整性和 `latest-beta.json` 复验通过。用户已在云主机确认 Beta 安装包下载、安装正常，并自动识别旧侧车；默认/自选路径升级矩阵、签名更新、组件安装及旧书库副本仍待完整走查。更新器私钥及公钥已由用户确认独立备份。GitHub CI 因账户问题暂不可用，不记为通过。

云主机试用发现翻译模型首字响应可能等待数分钟，任务中心也缺少翻译计时与接收进度。Beta.2 已补翻译阶段默认关闭思考，并显示等待、接收和完成耗时；Beta.1 不含此修复。JavaScript 全量 231 项、Rust 模型合同、语法检查及桥接 smoke 14/14 通过。Rust 全量首次运行时建图并发进度测试出现一次非单调回退，单独复跑及再次运行全量测试均通过；云端模型实际响应速度仍待新安装版验证。

Beta.2 主程序单包已完成发布前[代码审查](reviews/2026-09-24-v1.2-beta2-main-only.md)，随后构建、签名并发布。GitHub 仅有主程序安装包、`.sig` 和 `latest-beta.json` 三个附件；远端下载回来的安装包哈希及签名清单均已复验。Beta.2 继续使用 Beta.1 解析组件，已安装组件无需重新下载。发布前 JavaScript 全量 231 项、Rust 全量、语法检查 128 个文件、桥接 smoke 14/14 和发布清单测试 15/15 通过；云主机翻译首字延迟仍待实测。

## 待处理

- 发布门槛及验证步骤见 [v1.2.0 计划](plans/2026-09-24-1153-feat-v1-2-updater-map-recovery-plan.md)。v1.1.0 用户需手动安装 Beta；预发布不进入稳定版更新端点。
- 批量重挖的覆盖确认、编辑原文入口、PDF 按页懒加载、移除卡片后的附件清理。
- 存量 readMarks 孤儿与旧记录 parts 形态尚未迁移，语义见 [CONCEPTS.md](../CONCEPTS.md) 中的「阅读积累」。
- 解析组件仅支持 Windows；任务注册表为内存态，重启不恢复。云同步 [#25](https://github.com/attackingjensen/paper-30min/issues/25) 与 Android [#26](https://github.com/attackingjensen/paper-30min/issues/26) 尚未启动。
