# 正式客户端本地能力 Rust/JavaScript 接口边界

来源：[Wayfinder：正式客户端本地能力的 Rust/JavaScript 接口边界](https://github.com/attackingjensen/paper-30min/issues/23)

## 总则

- Tauri Rust 是本地持久化、文件、客户端网络和任务生命周期的唯一实现方；JavaScript 负责论文领域规则、流程编排和界面。
- JavaScript 不访问 SQLite、绝对文件路径或客户端网络；所有接口均版本化并返回领域 DTO。
- Rust 不复制论文切分、章节类型判断、精读编排、阅读进度计算等领域规则。

## Rust 能力组

1. 书库与迁移：SQLite 记录、事务、迁移、整库 JSON 预检与提交。
2. 文件与 PDF：应用数据根目录、附件读写、流式/按页读取、路径安全和临时文件清理。
3. 网络与云端同步：HTTPS、分块传输、重试、断点、同步操作状态。
4. 模型调用：Windows 本地模型请求和流式响应；API Key 仅本地保存。
5. 任务与生命周期：任务持久化、取消、恢复、关闭前状态查询。

## 接口形状

- `invoke(command, input) -> result` 用于短时、幂等或事务性操作。
- `start(taskKind, input) -> { taskId }` 用于生成、同步、导入、下载等长任务。
- `subscribe(taskId) -> events` 返回进度、流式内容和状态事件；最终状态可由 `getTask(taskId)` 查询。
- 每个响应包含 `schemaVersion`。错误统一为 `{ code, message, retryable, details }`。
- 任务状态为 `queued`、`running`、`succeeded`、`failed`、`cancel_requested`、`cancelled`、`retry_waiting`。取消请求幂等，只在安全检查点停止。

## 数据与文件边界

- 论文、原文章节、精读部分、精读结果、翻译、回想卡片、论文问答和阅读位置以稳定 DTO 暴露；SQLite 表结构不是前端契约。
- 日期使用 ISO 8601 UTC；正文保持 Markdown/LaTeX 字符串。
- Rust 管理逻辑分区 `database/`、`attachments/{paperId}/`、`operations/{taskId}/`、`exports/`，并通过路径 API 返回平台根目录。
- 同一论文的写操作串行化；跨论文可并行。论文记录、附件元数据、阅读位置和任务状态使用 SQLite 事务一致提交。
- 长任务中间输出先存任务状态；达到该任务保存条件后才提交精读结果。任务完成或取消后清理临时文件。

## 迁移接口

- `migration.inspect` 读取现有整库 JSON 导出，返回格式版本、论文数量、冲突统计和错误，不修改书库。
- `migration.commit` 仅接受对应预检令牌；源文件变化或令牌过期必须重新预检。提交在 Rust 事务中按论文 ID 合并。
- 导入文件有大小限制；API Key 不进入迁移数据。提交确认前由用户保留原书库备份。

## 阅读位置与网络

JavaScript 提交结构化阅读位置（视图、精读部分或 PDF 页码及内容版本）；Rust 负责节流、本地落库、自动同步和冲突响应。模型流式输出、云端同步和 PDF 按需读取均通过 Rust 任务事件流返回 JavaScript。

