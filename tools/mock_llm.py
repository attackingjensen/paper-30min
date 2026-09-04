#!/usr/bin/env python3
"""本地 mock LLM 服务（OpenAI 兼容，流式输出）。
用于在没有真实 API Key 时演示/验证精读流程：
    python tools/mock_llm.py            # 默认端口 8799
然后在 App「设置」中填写：
    Base URL: http://127.0.0.1:8799/v1    API Key: mock    模型: mock-reader-1

可选参数：
    --port N                监听端口（默认 8799；0 = 由系统分配，见启动横幅）
    --unterminated-tail     复现「最后一个 data 行没有换行符」的 SSE 场景：
                            末尾内容事件不带 \\n\\n、不发送 data: [DONE]，
                            直接关闭连接（Issue #7，用于浏览器端端到端验证）
"""
import argparse
import json
import re
import time
from http.server import BaseHTTPRequestHandler
from socketserver import ThreadingTCPServer

PORT = 8799
MODEL_ID = 'mock-reader-1'
UNTERMINATED_TAIL = False

REPLIES = {
    'abstract': """**【规范中文翻译】**

科学论文的自动摘要仍然十分困难，因为模型倾向于复制表面文字，而不是捕捉核心贡献。我们提出了 SampleNet，一种将对比学习（Contrastive Learning）与来自大型「教师阅读器」的知识蒸馏（Knowledge Distillation）相结合的摘要框架。SampleNet 首先用结构感知编码器（Structure-aware Encoder）对各章节编码，然后通过可学习的门控挑选关键句子，最后将教师的「理由（rationale）」蒸馏进紧凑的摘要中。在三个基准上，SampleNet 将 ROUGE-L 相对最强基线提升了 4.2 分，人类评估者在 68% 的情况下更偏好它的摘要。

**【一句话总结】**

SampleNet 用结构感知编码 + 对比筛选 + 理由蒸馏，让论文摘要更抓核心贡献，ROUGE-L 提升 4.2 分。
""",
    'introduction': """## 领域背景

论文数量与篇幅持续增长，研究者难以跟上领域进展；自动论文摘要因此成为重要方向。理解本文需要的基础概念：抽取式（extractive）与生成式（abstractive）摘要的区别，以及大语言模型带来的流畅性提升与幻觉（hallucination）风险。

## 相关工作与现状

- **抽取式方法**：以显著性打分挑选句子，忠实但摘要不连贯；
- **生成式方法**：序列到序列与预训练语言模型带来流畅性，但幻觉率上升，且普遍忽略章节结构。

两派共同的局限是：无法说明"为什么这个结果重要"——而这正是读者最关心的。

## 要解决的问题

能否让模型像专家读者一样做摘要，按合理比例突出 **问题、方法与证据**？已有方法要么碎片化（抽取式），要么失实且无结构感（生成式），都无法回答这个问题。

## 本文贡献

1. 面向论文的结构感知编码方案 —— 点评：针对"忽略章节结构"的痛点，是实质性设计；
2. 区分核心贡献与背景的对比学习目标 —— 点评：与"抓核心"的动机自洽，含金量较高；
3. 蒸馏配方：12 倍小的学生模型产出更好的摘要 —— 点评：工程价值明确，但"更好"需看后文消融支持。
""",
    'method': """## 核心创新点

SampleNet 把论文摘要拆成「结构感知编码 → 门控句子选择 → 理由蒸馏」三阶段，最关键的新意是第三阶段：让大型教师阅读器生成"为什么这句重要"的理由（rationale），再蒸馏给学生模型，使学生关注论文中因果相关的部分，而非高频套话。

## 方法详解

1. **结构感知编码器**：按章节（abstract / introduction / method / experiment）分别读入，为每个 token 附加章节类型标签，输出带"出处意识"的上下文向量；
2. **门控句子选择器**：为每个句子计算显著性门控 g；对比目标把摘要表示拉近"核心贡献句"、推远"背景句"；
3. **蒸馏阶段**：教师产出理由 + 摘要，学生同时模仿两者；学生模型比教师小 12 倍。
4. **训练损失**：$L = L_{ce} + \\lambda L_{cl}$，其中 $L_{ce}$ 是摘要生成的交叉熵，$L_{cl}$ 是对比项，$\\lambda$ 经网格搜索取 0.5。

## 为什么有效

作者给出的论证：理由蒸馏迫使学生关注论文中起因果作用的部分，而不是高频表面短语；对比项防止模型坍缩到模板化表达。此外实验观察到收益集中在 related work 很长的论文上，间接支持"结构意识而非模型容量驱动提升"的解释。

## 值得注意的设计细节

- λ = 0.5 来自小规模网格搜索，说明两项损失的平衡比较敏感；
- 学生模型缩小 12 倍仍更优，提示教师的价值在"理由质量"而非容量；
- 按章节分别编码意味着超长论文的截断策略会直接影响效果。
""",
    'experiments': """## 评测设置

三个基准：arXiv-Abst、PubMed-Intro、SciSumm-100（覆盖机器学习与生物医学论文）。基线：Lead-3、TextRank、BertSumExt，以及单样本指令提示的大语言模型。

## 主要结果

| 基准 | SampleNet | 最强基线 | 提升 |
|---|---|---|---|
| arXiv-Abst (ROUGE-L) | 41.7 | 37.5 | +4.2 |
| PubMed-Intro | — | — | +3.1 |
| SciSumm-100 | — | — | +2.8 |

人类评估（3 位专家标注者，成对比较）中，SampleNet 在 **68%** 的情况下被偏好，主要原因是忠实性与贡献覆盖度。

## 训练与推理细节

AdamW 训练 60,000 步，学习率 3e-5，batch size 32，4×A100 约 14 小时；单 GPU 推理每篇论文 1.2 秒。

## 消融实验

| 移除组件 | 影响 |
|---|---|
| 对比项 | ROUGE-L −2.4 |
| 章节感知编码 | ROUGE-L −1.6 |
| 理由蒸馏 | 人类偏好 −11 分（最大单项影响） |

理由蒸馏是最关键组件——它影响的不是 ROUGE，而是人类偏好，说明其价值在"读起来像专家"。

## 结果洞察

- 作者指出：收益集中在 related work 较长的论文 → 说明结构意识（而非容量）是主要驱动力；
- 作者承认约 6% 的摘要仍会抄错数字；
- 数字背后的隐含信息：ROUGE 提升约 3~4 分而人类偏好达 68%，提示该方法的真实价值更多体现在可读性与忠实性上，单看 ROUGE 会低估它。
""",
    'chat': "",
}


def detect_kind(messages):
    last = messages[-1].get('content', '') if messages else ''
    if 'Abstract 原文' in last:
        return 'abstract'
    if 'Introduction 原文' in last:
        return 'introduction'
    if 'Method 原文' in last:
        return 'method'
    if 'Experiment 原文' in last:
        return 'experiments'
    return 'chat'


def build_reply(kind, messages):
    if kind != 'chat':
        return REPLIES[kind]
    question = messages[-1].get('content', '').strip()
    return (
        f"**（mock 演示回复）** 你问的是：{question[:80]}\n\n"
        "基于这篇论文的 Method 与 Experiment 部分：\n"
        "- 方法的核心是 **结构感知编码 + 对比句子选择 + 理由蒸馏** 三阶段；\n"
        "- 消融实验显示 **理由蒸馏** 对人类偏好的影响最大（−11 分），是最关键组件；\n"
        "- 收益集中在 related work 较长的论文，说明结构意识是主要驱动力。\n\n"
        "> 这是本地 mock 模型的固定演示回复。在「设置」中换成真实大模型 API 后，"
        "这里会得到针对你问题的真正回答。"
    )


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

    def _json(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.rstrip('/').endswith('/models'):
            self._json(200, {'data': [{'id': MODEL_ID}]})
        else:
            self._json(404, {'error': {'message': 'not found'}})

    def do_POST(self):
        if not self.path.rstrip('/').endswith('/chat/completions'):
            self._json(404, {'error': {'message': 'not found'}})
            return
        n = int(self.headers.get('Content-Length', 0))
        try:
            req = json.loads(self.rfile.read(n) or b'{}')
        except json.JSONDecodeError:
            self._json(400, {'error': {'message': 'bad json'}})
            return
        messages = req.get('messages', [])
        reply = build_reply(detect_kind(messages), messages)

        if req.get('stream'):
            self.send_response(200)
            self._cors()
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            try:
                chunks = [reply[i:i + 18] for i in range(0, len(reply), 18)]
                for i, chunk in enumerate(chunks):
                    payload = json.dumps({'choices': [{'delta': {'content': chunk}}]}, ensure_ascii=False)
                    # 未终止模式：末尾事件不带 \n\n，复现「最后一个 data 行没有换行符」
                    tail = '' if UNTERMINATED_TAIL and i == len(chunks) - 1 else '\n\n'
                    self.wfile.write(f'data: {payload}{tail}'.encode('utf-8'))
                    self.wfile.flush()
                    time.sleep(0.012)
                if not UNTERMINATED_TAIL:
                    self.wfile.write(b'data: [DONE]\n\n')
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
        else:
            self._json(200, {'choices': [{'message': {'role': 'assistant', 'content': reply},
                                          'finish_reason': 'stop'}]})

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='本地 mock LLM 服务（OpenAI 兼容，流式输出）')
    parser.add_argument('--port', type=int, default=PORT, help='监听端口（默认 %(default)s；0 = 由系统分配）')
    parser.add_argument('--unterminated-tail', action='store_true',
                        help='末尾 SSE 事件不带换行、不发 [DONE]，复现「最后一个 data 行没有换行符」场景')
    args = parser.parse_args()
    UNTERMINATED_TAIL = args.unterminated_tail
    ThreadingTCPServer.allow_reuse_address = True
    server = ThreadingTCPServer(('127.0.0.1', args.port), Handler)
    # flush=True：stdout 被管道捕获时（如自动化测试）也能立刻读到横幅
    print(f'mock LLM 已启动：http://127.0.0.1:{server.server_address[1]}/v1 （模型名：{MODEL_ID}，Key 随意）', flush=True)
    server.serve_forever()
