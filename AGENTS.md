# Paper30Min

论文精读应用：Windows Tauri 客户端。开发流程直接使用已安装的 Compound Engineering 技能，不在仓库另定义阶段或文档审批链。

## 项目事实

- Windows 本地书库是论文内容权威来源；Rust 负责存储、文件、网络、模型和阅读协议运行，JavaScript 负责界面与前端状态。
- `app/` 是 Windows 客户端，`skills/` 是产品阅读提示词，不能与 CE 开发技能混用。
- 日常开发直接在 `steven123397/dev` 分支进行，不为每项工作单独开分支；发布前核对目标分支。
- `steven123397` 独立承担全部开发和维护；仓库持有者 [attackingjensen](https://github.com/attackingjensen) 仅作为产品体验者，不参与开发或 PR。

## 验证入口

- Windows JavaScript：`cd app` 后 `node --test`。
- Rust：`cd app/src-tauri` 后 `cargo test`。
- 桌面集成：`cd app` 后 `npm run smoke`；JavaScript 单测不能替代 Tauri 原生桥和窗口验证。
- JavaScript 语法：仓库根目录 `node tools/check_syntax.mjs`。

按改动范围选择检查；构建与运行细节见 `app/README.md`。

## 工作约定

- 文档默认中文；标识符与 CE frontmatter 保留技能自身格式。
- 技能不可用时说明情况，不谎称已调用。
- 无法运行的检查说明原因，不标为通过。
- 小型明确修复不为凑流程创建计划或额外产物。
- 每次提交前核对 [docs/current.md](docs/current.md)，按实际进度更新，并随对应改动同笔提交；不记流水账。

## 项目知识

`STRATEGY.md` 承接已确认的产品定位、用户、边界和方向，供 CE 探索与规划使用。`CONCEPTS.md` 提供阅读模型、关键术语与既有取舍。当前进度见 [docs/current.md](docs/current.md)，历史资料索引见 [docs/README.md](docs/README.md)。

`docs/solutions/` 是 CE 经验库，按类别与 `module`、`tags`、`problem_type` 等 YAML 元数据检索，供相关实现和调试复用。

解决并验证问题后，仅当符合 `ce-compound` 技能的持久经验门槛时，才在收尾以 `mode:non-interactive` 自动调用；产物随对应提交交付。

面向用户的汇报、总结和交接使用 `ce-noslop`；代码、配置和逐字引用不适用。
