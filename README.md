# Paper30Min

论文精读专精 agent harness：用大模型把一篇完整论文压缩成约 30 分钟可读完的形态——先拿到一屏阅读地图，再定向深挖你关心的章节，最后让复述稿把全篇讲清楚。

## 下载安装（Windows）

从 [GitHub Releases](https://github.com/attackingjensen/paper-30min/releases) 下载最新的 `Paper30Min_x.x.x_x64-setup.exe`，双击安装即可（免管理员权限）。安装包内置文档解析引擎与全部模型，装完即用，无需联网下载组件。

当前正式版为 v1.1.0。v1.2.0-beta.1 用于安装版验收，本地解析组件改为按需安装；进度及限制见 [docs/current.md](docs/current.md)。

首次启动书库内置一份「使用说明」。使用前打开右上角「设置」，填入任意 **OpenAI 兼容** 的大模型接口并「连接测试」：

| 提供商 | Base URL | 模型示例 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 阿里云百炼（通义） | `https://dashscope.aliyuncs.com/compatible-mode/v1`（直接填裸域名 `https://dashscope.aliyuncs.com` 也可以，会自动改写） | `qwen-max` |
| Ollama（本地） | `http://127.0.0.1:11434/v1` | `qwen2.5:14b` |

然后导入论文（本地 PDF / arXiv 编号 / 示例论文），解析与预渲染会自动在后台完成，点「开始建图」即可开始精读。

没有 API Key 时，可运行 `python tools/mock_llm.py` 启动本地演示模型；在客户端设置中填入 `http://127.0.0.1:8799/v1`、任意 Key 和模型名 `mock-reader-1`。

## 阅读协议

- **建图**：一次建图生成一屏阅读地图（问题、方法、贡献、关键证据位置、术语表）+ 全部章节薄摘要；导入后解析与预渲染自动排队，建图一键直达；
- **深挖**：对单个章节按需发起细致分析，模型可用只读工具越过本节取证，取证轨迹随任务可查；
- **复述稿**：综合阶段把全篇按「问题 → 方法 → 证据 → 边界」重讲一遍，未深挖的部分明确标注；
- **出处定位**：产物中的论断都带出处指针，点击跳到原文块、节页图表或 PDF 页；
- **提问**：@节绑定提问、原文选中片段提问、全文提问三形态共用一条会话流；
- **阅读积累**：手动「已读完」标记驱动进度、连续打卡统计、阅读位置跨会话恢复；任务中心统一管理解析/建图/深挖/下载任务，支持取消与重试。

## 技能库

精读各阶段的提示词都是可调整的「技能」：

- `skills/` 顶层是新阅读协议的技能库（四段协议提示词 `map-l2` / `map-l1` / `deep-dive` / `synthesize` + 章节关注点数据 `section-focus.json`），Windows 客户端使用；
- `skills/legacy/` 保留旧五技能，供 Windows 客户端的旧精读路径和存量技能覆盖使用；
- 应用内「技能库」面板可在线编辑、恢复默认、导入 `.md` 技能文件覆盖。

## 数据与隐私

- Windows 客户端的书库（论文、PDF、精读产物、问答、设置）全部保存在本机数据目录，不经过任何第三方服务器；
- 只有建图 / 深挖 / 提问时，相关论文内容会发送给你配置的模型 API；
- API Key 只保存在本机设置表，不进入任何导出文件；
- 支持整库 JSON 导出/导入备份迁移（按论文 id 合并）。

## 平台与限制

- 当前仅 Windows 10/11 x64；Linux / macOS 暂未适配（卡在文档解析侧车的平台构建）；
- 任务列表为会话内记录，重启后不保留历史任务；
- 云端同步服务与 Android 阅读伴侣在路线图中，本版未包含。

## 目录结构

```
paper-30min/
├── skills/              # 技能库：顶层为新协议提示词与关注点数据，legacy/ 为旧五技能留档
├── app/                 # Windows 正式客户端（Tauri 外壳 + Rust/JavaScript 桥接 + Docling 侧车）
├── tools/               # 侧车构建、示例论文与 mock 模型等工具
└── docs/                # CE 产物与文档
    ├── plans/           #   按需生成的统一计划
    └── solutions/       #   经验证的项目经验
```

## 开发协作

使用已安装的 Compound Engineering（CE）技能，按任务直接调用，不另设仓库工作流。当前进度见 [docs/current.md](docs/current.md)，产品方向见 [STRATEGY.md](STRATEGY.md)，概念与关键取舍见 [CONCEPTS.md](CONCEPTS.md)，项目事实和测试入口见 [AGENTS.md](AGENTS.md)。其他资料从 [docs/README.md](docs/README.md) 查找。产品阅读提示词与 CE 开发技能分开维护。
