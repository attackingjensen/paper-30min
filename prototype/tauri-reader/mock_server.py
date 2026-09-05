# THROWAWAY PROTOTYPE (issue #20) - 本机模拟服务：SSE 流式 + 双版本内容 + 附件
# 用法: python mock_server.py  (端口 8791；Android 真机经 adb reverse tcp:8791 tcp:8791 访问)
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

PORT = 8791
HERE = Path(__file__).parent

MD_V1 = """# 示例论文：面向移动阅读的原型验证

## 摘要
本文构造一个**最小可行原型**，验证桌面与移动端共享同一份本地能力是否可行。
行内公式示例：质能方程 \(E = mc^2\) 与欧拉公式 $e^{i\\pi} + 1 = 0$。

## 方法
| 方案 | 外壳 | 本地能力 |
| --- | --- | --- |
| A | Tauri | Rust 共享 |
| B | 原生双端 | 两套实现 |

块级公式：
$$
\\frac{\\partial}{\\partial t} \\Psi = \\frac{i\\hbar}{2m} \\nabla^2 \\Psi
$$

```rust
fn main() { println!("v1"); }
```

## 结论（v1）
第一版结论：共享代码可行，待真机验证。
"""

MD_V2 = """# 示例论文：面向移动阅读的原型验证（第二版）

## 摘要
第二版摘要：补充了**版本切换**场景的验证结论。行内公式 \(E = mc^2\) 保持不变。

## 方法（修订）
| 方案 | 外壳 | 本地能力 | 结论 |
| --- | --- | --- | --- |
| A | Tauri | Rust 共享 | 通过 |
| B | 原生双端 | 两套实现 | 放弃 |

$$
\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}
$$

## 结论（v2）
第二版结论：新增本节用于验证版本切换后阅读位置的兜底行为。
"""

STREAM_CHUNKS = [
    "这是对「", "示例论文」的", "流式精读输出，",
    "包含中文分片、", "**加粗** 与公式 ", "\(a^2+b^2=c^2\)。",
    "\n\n第一段结束，", "继续输出第二段：", "中断恢复后旧内容", "不应被重复写入。",
    "\n\n最后一段：", "流式响应正常结束。",
]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[mock] {fmt % args}", flush=True)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def _json(self, obj, fail_mid=False):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if fail_mid:
            # 只写一半就断开，模拟下载中断
            self.wfile.write(body[: len(body) // 2])
            self.wfile.flush()
            self.connection.shutdown(2)
            self.connection.close()
            print("[mock] 故意中断版本下载", flush=True)
            return
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        fail = q.get("fail", [""])[0] == "mid"
        if u.path == "/api/papers/sample":
            v = q.get("v", ["1"])[0]
            md = MD_V2 if v == "2" else MD_V1
            self._json({"id": "demo-paper", "title": "示例论文：面向移动阅读的原型验证",
                        "version": int(v), "markdown": md}, fail_mid=fail)
        elif u.path == "/api/files/sample.pdf":
            data = (HERE / "sample_paper.pdf").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            if q.get("slow", [""])[0] == "1":
                for i in range(0, len(data), 1024):
                    self.wfile.write(data[i : i + 1024])
                    self.wfile.flush()
                    time.sleep(0.2)
            else:
                self.wfile.write(data)
        elif u.path == "/api/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            for i, chunk in enumerate(STREAM_CHUNKS):
                if fail and i == 5:
                    print("[mock] 故意中断流式输出", flush=True)
                    self.connection.shutdown(2)
                    self.connection.close()
                    return
                self.wfile.write(f"data: {chunk}\n\n".encode("utf-8"))
                self.wfile.flush()
                time.sleep(1.0)
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        else:
            self.send_response(404)
            self.end_headers()


if __name__ == "__main__":
    print(f"[mock] 模拟服务 http://127.0.0.1:{PORT} (Ctrl+C 停止)", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
