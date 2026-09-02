# 📚 论文精读 App

每天精读一篇论文，积累对领域的深刻理解。一个跑在本地浏览器里的论文精读工作台，电脑和手机（同一 Wi-Fi）都能用。

## 核心功能

从 arXiv 结构化 HTML 或本地 PDF 导入论文后，自动识别摘要和正文一级大标题，按原始顺序切分为多个精读部分，并用大模型逐一精读。论文不含 Method 时也可正常工作。arXiv HTML 可用时优先使用它，PDF 则作为任意本地论文的通用入口：

| 章节 | 精读关注点 |
|---|---|
| **Abstract** | 英文原文 + 规范中文翻译 + 一句话总结 |
| **Introduction** | 领域背景 / 相关工作与现状 / 要解决的问题 / 本文贡献（含点评） |
| **Method**（最关注） | 核心创新点 / 方法详解 / **为什么有效**（作者的论证 + 缺失时的合理推测） / 设计细节 |
| **Experiment** | 评测基准与任务 / 主要结果 / 训练推理细节 / 消融实验 / 结果洞察 |

此外还有：

- **章节切换**：结合编号、字号与版面识别论文实际一级大标题，按原始顺序显示“第 1 部分……第 N 部分”，不要求论文必须包含 Method；
- **精读质量优先**：按真实一级章节切分原文，使用对应或通用技能生成精读，不把图表裁剪和插图混入模型上下文；
- **公式排版**：支持 `$...$`、`$$...$$`、`\(...\)` 与 `\[...\]` LaTeX 公式，本地内置 MathJax；
- 💬 **提问**：内嵌对话面板，把论文内容作为上下文，直接向大模型追问；
- 🧰 **技能库**：每个章节的精读提示词都是独立的「技能」，可在线编辑、恢复默认、导入 `.md` 技能文件覆盖；
- 🔥 **打卡**：记录连续阅读天数与精读进度；
- ⬇ **导出笔记**：把整篇论文的精读结果导出为 Markdown。

## 快速开始

1. 双击 `start.bat`（macOS / Linux 用 `./start.sh`），或直接运行：

   ```bash
   python server.py
   ```

2. 浏览器会自动打开 `http://127.0.0.1:8765`。**手机**与电脑在同一 Wi-Fi 时，访问启动时打印的局域网地址即可。
3. 点击右上角「⚙️ 设置」，填入任意 **OpenAI 兼容** 的大模型接口：

   | 提供商 | Base URL | 模型示例 |
   |---|---|---|
   | DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
   | OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
   | Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
   | 通义 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-max` |
   | Ollama（本地） | `http://127.0.0.1:11434/v1` | `qwen2.5:14b` |

   填完点「测试连接」验证。
4. 输入 arXiv 编号/链接，或选择「导入论文 PDF」「打开示例论文」，然后点「▶ 一键生成全部精读」。

> 没有 API Key 也能体验完整流程：`python tools/mock_llm.py` 启动本地演示模型，设置里填 `http://127.0.0.1:8799/v1`，Key 随意，模型填 `mock-reader-1`。

## 技能库

每个章节对应一个技能（提示词模板），占位符：`{title}` = 论文标题，`{content}` = 章节原文。

- 在 App 内「技能库」面板中编辑、保存、恢复默认；
- `skills/` 目录内置了 4 个基础技能（`.md` + YAML frontmatter），可作为改造起点；
- 找到优秀的开源技能后，把文件放进任意目录，在技能库中「导入 .md」即可。frontmatter 格式：

  ```markdown
  ---
  name: 技能名称
  description: 一句话说明
  section: method        # abstract / introduction / part / method / experiments
  ---
  提示词正文，可用 {title} 与 {content} 占位符……
  ```

## 数据与隐私

- 论文原文、精读结果、对话记录全部保存在**浏览器本地**（IndexedDB），不经过任何第三方服务器；
- 只有生成精读 / 提问时，相关章节文本会发送给你配置的 API；
- 换浏览器或清除站点数据会丢失记录，重要笔记请及时「导出笔记」。

## 目录结构

```
论文30min/
├── server.py            # 本地静态服务器（0.0.0.0，手机可访问）
├── start.bat / start.sh # 一键启动
├── public/              # 前端（纯原生 JS，无需构建）
│   ├── js/parser.js     #   PDF 解析与章节切分（支持双栏排版）
│   ├── js/skills.js     #   技能库（内置提示词 + 自定义覆盖 + .md 导入）
│   ├── js/api.js        #   OpenAI 兼容 API 客户端（流式）
│   ├── js/db.js         #   IndexedDB 本地存储
│   └── js/app.js        #   主界面逻辑
├── skills/              # 技能库基础模板（可改造、可新增）
├── tools/
│   ├── make_sample_pdf.py  # 生成示例论文
│   └── mock_llm.py         # 本地演示用 mock 模型
└── public/samples/sample_paper.pdf
```

## 已知限制（路线图）

- PDF 章节切分依赖版面与标题启发式，扫描版或特殊排版仍可能需要手动粘贴章节原文；
- 计划：阅读计划与提醒、标签/搜索、多设备同步（导出/导入库文件已可手动迁移）。
