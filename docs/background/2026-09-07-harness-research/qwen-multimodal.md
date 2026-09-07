# 调研：多模态调用的接口形态与图像成本（qwen3.8-flash）

- 来源票据：[#38](https://github.com/attackingjensen/paper-30min/issues/38)（父地图 [#35](https://github.com/attackingjensen/paper-30min/issues/35)）
- 实测日期：2026-09-07
- 对象：`qwen3.8-flash`，DashScope OpenAI 兼容模式（`https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`），配置来自仓库 `.local/api.json`（不入库）
- 实测脚本与原始数据：[`2026-09-07-qwen-multimodal/probe.py`](2026-09-07-qwen-multimodal/probe.py)、[`2026-09-07-qwen-multimodal/results.jsonl`](2026-09-07-qwen-multimodal/results.jsonl)

## 结论摘要

1. **接口形态就是 OpenAI 标准多模态消息**：`content` 数组里混放 `image_url` 与 `text` 部件，`image_url.url` 同时接受公网 `https://` URL 与 `data:image/...;base64,...` data URI，文本与图像任意顺序、多图混放均可；响应 `usage` 直接拆出 `prompt_tokens_details.image_tokens / text_tokens / cached_tokens`，图像成本可精确观测。
2. **单请求图像数量上限 = 250 个 data URI**，超限返回干净的 HTTP 400（`Exceeded limit on max data-uri per request: 250`）。但"能收"不等于"能用"：16 张同质图起事实判断已出错，24 张起推理 token 暴涨，批量送图有质量衰减。
3. **图像 token 计量可预测**：按 32×32 像素 patch 计费，`image_tokens = round32(宽)×round32(高)/1024 + 2`，下限 66 token/图（约 6.5 万像素地板，小图被放大），上限 2502 token/图（约 256 万像素封顶，大图被缩小）。PDF 页图（1224×1584 @2x 渲染）= **1902 token/页**。
4. **"1M 上下文"实测硬顶是 983,616 输入 token**：超限直接 HTTP 400（`Range of input length should be [1, 983616]`），不降级、不截断。943,452 token 实测通过，开头埋入的事实被正确召回（总耗时 56s）。上下文预算必须按 ≤983K 算，不能按 1M 算。
5. **两条服务端体积限制**：纯文本请求体上限 6 MiB（6,291,456 字节）；JSON 单字符串值上限 28,000,000 字符（base64 大图撞此限）。图像请求 11.26 MB base64 负载通过、30.56 MB 被拒；中文长文必须 `ensure_ascii=False` 直发 UTF-8，否则 6 字节/字的转义会让文本请求提前撞 6 MiB 墙。
6. **多模态对 TTFT 的影响为秒级**：文本基线约 1.1s；1 张小图约 2.2s；1 张页图（1902 图像 token）约 2.4s；8 张小图约 4.2s。交互可接受，但图像张数比单图分辨率更拖首 token。

## 实测数据表

### 图像 token 计量（固定提示词"描述这张图。"，文本 52 token）

| 输入 | 像素 | 文件大小 | image_tokens | 说明 |
|---|---|---|---|---|
| 纯文本 | — | — | 0 | prompt 共 65 token |
| tiny16.png | 16×16 | 175 B | **66** | 撞下限地板 |
| s224.jpg | 224×224 | 33 KB | **66** | 与 16×16 同价 |
| s448.jpg | 448×448 | 147 KB | 198 | 14×14 patch + 2 |
| s896.jpg | 896×896 | 489 KB | 786 | 28×28 patch + 2 |
| s1024.jpg | 1024×1024 | 683 KB | 1026 | 32×32 patch + 2 |
| s1792.jpg | 1792×1792 | 865 KB | **2502** | 撞封顶 |
| s2048 / s3584 / s4096 | ≤4096² | ≤3.8 MB | **2502** | 封顶不变 |
| s8192.jpg | 8192×8192 | 5.7 MB | **2502** | 维度本身不报错 |
| huge10000.jpg | 10000×10000 | 2.4 MB | **2502** | 1 亿像素同样封顶 |
| strip50x2000.jpg | 50×2000 | 83 KB | 126 | 极端宽高比正常 |
| **page1.png（论文页图）** | **1224×1584** | 290 KB | **1902** | 38×50 patch + 2 |
| 公网示例图（https） | — | — | 2503 | 撞封顶（+1 为取整差） |

计量公式（与全部 13 个数据点吻合）：图像先按宽高比不变缩放进 `[约6.5万, 约256万]` 像素区间，宽高各取整到 32 的倍数，`image_tokens = 宽/32 × 高/32 + 2`（+2 为视觉包裹符）。下限 66、上限 2502 token/图。

### 单请求图像数量

| 张数 | 图像 | 结果 | image_tokens |
|---|---|---|---|
| 1 / 4 / 8 / 16 / 24 / 32 / 48 / 64 / 96 / 128 | 224×224 | 全部通过 | 严格 = 张数 × 66 |
| **250** | 16×16 | 通过 | 16,500 |
| **256** | 16×16 | **HTTP 400**：`Exceeded limit on max data-uri per request: 250` | — |

质量观察：16 张同质图起"内容是否一致"判断出错（答"否"）；24 张那次推理 token 冲到 2,223、耗时 31s（其余同档请求 2–9s）。接口放行不代表注意力够用。

### 体积限制

| 探测 | 结果 |
|---|---|
| 纯文本请求体 5.5 MB（UTF-8 直发，943K token） | 通过 |
| 纯文本请求体约 11 MB（`ensure_ascii=True` 转义后） | **HTTP 400**：`Exceeded limit on max bytes to request body : 6291456`（6 MiB） |
| 单图 base64 负载 9.63 MB / 11.26 MB | 通过 |
| 单图 base64 负载 30.56 MB | **HTTP 400**：`String value length (28049408) exceeds the maximum allowed (28000000, StreamReadConstraints)` |
| 单图 base64 负载 92 MB | 连接被直接掐断（SSL EOF），非干净 400 |

即：纯文本路由请求体硬顶 6 MiB；任何单个 JSON 字符串值硬顶 28,000,000 字符（base64 约 21 MB 原始文件）。图像路由在 11 MB 级负载下未见 6 MiB 限制，实用约束是 28M 字符。

### 1M 上下文实际行为（中文填充 1.93 字/token 校准）

| 用例 | 目标 | 实际 prompt_tokens | 结果 |
|---|---|---|---|
| 欠限 | 950K | **943,452** | 通过；开头第 0 位埋入的"魔法数字 739241"被正确召回；总耗时 56.2s |
| 超限 | 1,050K | — | **HTTP 400**：`InternalError.Algo.InvalidParameter: Range of input length should be [1, 983616]` |

**超限不降级、不静默截断，直接报错**。实际可用输入上限 983,616 token（比标称 1M 少约 6.2%）。

### 首 token 延迟（流式，3 次重复，本机至阿里云含网络往返）

| 用例 | prompt_tokens | TTFT（s，3 次） | 均值 |
|---|---|---|---|
| 纯文本 | 66 | 0.91 / 1.08 / 1.20 | **1.1** |
| 1 张小图（66 图像 token） | 122 | 2.14 / 1.91 / 2.47 | **2.2** |
| 4 张小图 | 321 | 4.75 / 1.55 / 1.62 | 2.6 |
| 8 张小图 | 585 | 3.94 / 5.92 / 2.86 | **4.2** |
| 1 张页图（1902 图像 token） | 1958 | 2.67 / 2.45 / 2.16 | **2.4** |

方差较大（推理模型 + 排队），但形态清晰：首张图固定加收约 1–1.5s，之后张数比单图分辨率更拖 TTFT；单图 66 与 1902 token 的 TTFT 几乎无差（2.2s vs 2.4s）。

## 接口形态样例

请求（OpenAI 兼容，`image_url` 部件；文本与图像可任意顺序混放）：

```python
import base64, json, urllib.request

cfg = json.load(open('.local/api.json', encoding='utf-8'))  # baseUrl/apiKey/model，不入库

def page_image_part(path):
    b64 = base64.b64encode(open(path, 'rb').read()).decode('ascii')
    return {'type': 'image_url', 'image_url': {'url': f'data:image/png;base64,{b64}'}}

body = {
    'model': cfg['model'],
    'messages': [{
        'role': 'user',
        'content': [
            page_image_part('page1.png'),                      # 或 {'type':'image_url','image_url':{'url':'https://...'}}
            {'type': 'text', 'text': '这是一页论文截图，请给出它的标题。'},
        ],
    }],
    'max_tokens': 64,
    # 中文长文务必 ensure_ascii=False，否则每字 6 字节转义，提前撞 6MiB 请求体上限
}
req = urllib.request.Request(
    cfg['baseUrl'].rstrip('/') + '/chat/completions',
    data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
    headers={'Authorization': f"Bearer {cfg['apiKey']}", 'Content-Type': 'application/json'},
    method='POST')
resp = json.loads(urllib.request.urlopen(req, timeout=180).read().decode('utf-8'))
```

响应（实测摘录，注意 usage 的图像 token 拆分；该模型为推理模型，思考计入 completion）：

```json
{
  "choices": [{"message": {"content": "SampleNet: Contrastive Distillation for Neural Paper Summarization"}}],
  "usage": {
    "prompt_tokens": 1960,
    "prompt_tokens_details": {"cached_tokens": 0, "image_tokens": 1902, "text_tokens": 58},
    "completion_tokens": 78,
    "completion_tokens_details": {"reasoning_tokens": 61},
    "total_tokens": 2038
  }
}
```

流式（`"stream": true`）为标准 SSE，结尾有 `data: [DONE]`，用量在末尾空 choices 的统计块中返回。

## 限制与建议

对三层阅读协议（L1 地图 / L2 节薄摘要 / L3 深挖）的直接含义：

1. **页图预算可精确规划**：1224×1584@2x 页图 = 1902 token/页。30 页论文全页图 ≈ 5.7 万 token，相对 983,616 的输入上限很便宜；L2 一次调用带全页图在 token 层面毫无压力。
2. **但批量送图有质量衰减**：16 张起同质判断出错、24 张起推理暴涨。这直接回应地图待定项"页图全送 vs 按节送"——**实测支持按节送（±1 页）**，既符合深挖配方雏形，也避开多图注意力衰减；全量页图只应在确有必要时送。
3. **渲染分辨率别超过 1600×1600（约 256 万像素）**：超过即被服务端缩到 2502 token 封顶，多传的字节全是浪费；低于约 256×256 也省不了 token（66 地板）。PDF 2x 渲染（1224×1584，1902 token）接近性价比甜区；3x/4x 渲染不增加任何信息摄入。
4. **批处理上限 250 图/请求**：整篇论文页图一次送没有接口障碍（250 页以内），但受第 2 条质量约束不建议这么做。
5. **上下文按 ≤983K 输入 token 设计**：超限是硬 400 不是截断，客户端必须自己管住窗口，不能指望服务端兜底。针尖召回在 943K 处完好，窗口内可信任。
6. **JSON 序列化必须 `ensure_ascii=False`**：默认转义让中文每字 6 字节，约 105 万字（约 54 万 token）就撞 6 MiB 纯文本请求体上限，远未到模型上下文顶。
7. **成本观测用 `usage.prompt_tokens_details.image_tokens`**：服务端逐图如实计量（张数 ×66 严格吻合），客户端无需自己估算，可逐请求落账。另注意 `cached_tokens` 会命中重复前缀/重复图（实测重复图大量命中缓存），重复发送相同页图的成本比账面低。
8. **TTFT 预算**：文本约 1.1s，带页图约 2.4s，8 图约 4.2s。交互式深挖（1–3 张页图）首 token 在 2–3s 可接受；若做"全文页图 + 提问"，首 token 会到 4s 以上，需要流式 UI 兜底。

## 测试方法

- 脚本：`docs/research/2026-09-07-qwen-multimodal/probe.py`（本分支），从仓库根目录运行，读取 `.local/api.json` 配置（密钥不入库）；阶段：`assets / shape / count / size / tokens / context / latency`。
- 测试素材：`app/ui/samples/sample_paper.pdf` 经 PyMuPDF 2x 渲染的页图（1224×1584 PNG），以及 Pillow 生成的 16×16 至 10000×10000 各档合成图（含噪点与尺寸标注文字，避免纯色图被特殊处理）。
- 原始记录：`docs/research/2026-09-07-qwen-multimodal/results.jsonl`，逐请求保存 usage、TTFT、错误原文（含 request_id，可回溯）。
- 方法要点：token 计量用"固定文本 + 变分辨率"隔离变量；数量上限用 16×16 极小图排除负载体积干扰；上下文用 2 万字校准字/token 比后按目标 token 数构造填充文本，开头埋针验证召回；延迟用流式请求测首 chunk 到达时间，每用例 3 次。
- 局限：TTFT 样本量小（每档 3 次）且含家庭网络往返，只宜看量级；质量衰减只测了"同质图一致性"一个任务；`min_pixels/max_pixels` 等 extra_body 调参未测（默认档已覆盖协议需求）；多模态路由请求体在 11–30 MB 之间的确切上限未逐点二分（实用约束已被 28M 字符限决定）。
