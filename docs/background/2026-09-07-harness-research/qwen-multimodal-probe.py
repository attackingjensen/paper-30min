#!/usr/bin/env python3
"""qwen3.8-flash（DashScope OpenAI 兼容模式）多模态接口实测脚本。

用法（从仓库根目录运行，需先配置 .local/api.json，见 .local/llm.py）：
    python docs/research/2026-09-07-qwen-multimodal/probe.py shape
    python docs/research/2026-09-07-qwen-multimodal/probe.py count
    python docs/research/2026-09-07-qwen-multimodal/probe.py size
    python docs/research/2026-09-07-qwen-multimodal/probe.py tokens
    python docs/research/2026-09-07-qwen-multimodal/probe.py context
    python docs/research/2026-09-07-qwen-multimodal/probe.py latency
    python docs/research/2026-09-07-qwen-multimodal/probe.py assets   # 生成测试图片

各阶段把原始结果追加写入 .local/mm_test/results.jsonl（.local 已 git exclude）。
脚本本身不含任何密钥。
"""
import base64
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request

REPO_ROOT = os.getcwd()
CONFIG_PATH = os.path.join(REPO_ROOT, '.local', 'api.json')
OUT_DIR = os.path.join(REPO_ROOT, '.local', 'mm_test')
ASSETS = os.path.join(OUT_DIR, 'assets')
RESULTS = os.path.join(OUT_DIR, 'results.jsonl')

# DashScope 官方示例公开图片（其文档中的样例 URL）
PUBLIC_IMG_URL = 'https://dashscope.oss-cn-beijing.aliyuncs.com/images/dog_and_girl.jpeg'

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, 'reconfigure'):
        stream.reconfigure(encoding='utf-8')


def load_config():
    with open(CONFIG_PATH, encoding='utf-8') as f:
        return json.load(f)


CFG = load_config()
ENDPOINT = CFG['baseUrl'].rstrip('/') + '/chat/completions'
MODEL = CFG['model']


def record(phase, entry):
    os.makedirs(OUT_DIR, exist_ok=True)
    entry = {'phase': phase, 'ts': time.strftime('%H:%M:%S'), **entry}
    with open(RESULTS, 'a', encoding='utf-8') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')
    print(json.dumps(entry, ensure_ascii=False))


def call(messages, max_tokens=64, timeout=180, stream=False, extra=None):
    """返回 dict：{ok, content, usage, ttft, total, error}"""
    body = {'model': MODEL, 'messages': messages, 'max_tokens': max_tokens, 'stream': stream}
    if extra:
        body.update(extra)
    # ensure_ascii=False：中文按 UTF-8 直发（3 字节/字）。默认 ensure_ascii=True 会把
    # 每字转义成   六字节，长上下文请求会无谓撞服务端 6MiB 请求体上限。
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
        headers={'Authorization': f"Bearer {CFG['apiKey']}", 'Content-Type': 'application/json'},
        method='POST',
    )
    t0 = time.monotonic()
    ttft = None
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if not stream:
                data = json.loads(resp.read().decode('utf-8'))
                total = time.monotonic() - t0
                return {'ok': True, 'content': data['choices'][0]['message']['content'],
                        'usage': data.get('usage'), 'ttft': None, 'total': round(total, 2)}
            parts = []
            usage = None
            for line in resp:
                line = line.strip()
                if not line.startswith(b'data:'):
                    continue
                chunk = line[5:].strip()
                if chunk == b'[DONE]':
                    break
                data = json.loads(chunk)
                if data.get('usage'):
                    usage = data['usage']
                choices = data.get('choices') or []
                if not choices:
                    continue
                delta = choices[0].get('delta', {}).get('content')
                if delta:
                    if ttft is None:
                        ttft = time.monotonic() - t0
                    parts.append(delta)
            total = time.monotonic() - t0
            return {'ok': True, 'content': ''.join(parts), 'usage': usage,
                    'ttft': round(ttft, 2) if ttft is not None else None, 'total': round(total, 2)}
    except urllib.error.HTTPError as err:
        body_text = err.read().decode('utf-8', errors='replace')
        return {'ok': False, 'error': f'HTTP {err.code}', 'error_body': body_text[:600],
                'total': round(time.monotonic() - t0, 2)}
    except Exception as err:  # URLError / timeout 等
        return {'ok': False, 'error': f'{type(err).__name__}: {err}',
                'total': round(time.monotonic() - t0, 2)}


def b64_url(path, fmt='PNG'):
    with open(path, 'rb') as f:
        raw = f.read()
    mime = 'image/png' if fmt.upper() == 'PNG' else 'image/jpeg'
    return f'data:{mime};base64,' + base64.b64encode(raw).decode('ascii'), len(raw)


def img_part(url):
    return {'type': 'image_url', 'image_url': {'url': url}}


def mm_messages(text, urls):
    return [{'role': 'user', 'content': [img_part(u) for u in urls] + [{'type': 'text', 'text': text}]}]


def gen_synthetic(path, w, h, fmt='JPEG'):
    """生成带随机噪点与文字的测试图（避免纯色图被特殊处理）。"""
    from PIL import Image, ImageDraw
    import random
    random.seed(w * 100003 + h)
    img = Image.new('RGB', (w, h))
    px = img.load()
    step = max(1, (w * h) // 200000)
    cnt = 0
    for y in range(h):
        for x in range(w):
            cnt += 1
            if cnt % step == 0:
                px[x, y] = (random.randrange(256), random.randrange(256), random.randrange(256))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, min(w, 220), min(h, 40)], fill=(255, 255, 255))
    d.text((8, 8), f'{w}x{h}', fill=(0, 0, 0))
    img.save(path, fmt, quality=85 if fmt == 'JPEG' else None)
    return os.path.getsize(path)


def phase_assets():
    """渲染样本 PDF 页图 + 生成各尺寸合成图。"""
    import pymupdf
    os.makedirs(ASSETS, exist_ok=True)
    doc = pymupdf.open(os.path.join(REPO_ROOT, 'app', 'ui', 'samples', 'sample_paper.pdf'))
    for i, page in enumerate(doc):
        pix = page.get_pixmap(matrix=pymupdf.Matrix(2, 2))
        out = os.path.join(ASSETS, f'page{i + 1}.png')
        pix.save(out)
        print('page:', out, pix.width, 'x', pix.height, os.path.getsize(out))
    for w, h, fmt, name in [
        (16, 16, 'PNG', 'tiny16.png'),
        (224, 224, 'JPEG', 's224.jpg'),
        (448, 448, 'JPEG', 's448.jpg'),
        (896, 896, 'JPEG', 's896.jpg'),
        (1024, 1024, 'JPEG', 's1024.jpg'),
        (1792, 1792, 'JPEG', 's1792.jpg'),
        (2048, 2048, 'JPEG', 's2048.jpg'),
        (3584, 3584, 'JPEG', 's3584.jpg'),
        (4096, 4096, 'JPEG', 's4096.jpg'),
        (8192, 8192, 'JPEG', 's8192.jpg'),
        (50, 2000, 'JPEG', 'strip50x2000.jpg'),
    ]:
        p = os.path.join(ASSETS, name)
        size = gen_synthetic(p, w, h, fmt)
        print('synthetic:', name, w, 'x', h, size, 'bytes')


def phase_shape():
    # 1) 公网 URL
    r = call(mm_messages('这张图里有什么？用一句话回答。', [PUBLIC_IMG_URL]), max_tokens=64)
    record('shape', {'case': 'https_url', 'result': r})
    # 2) base64 data URL（本地 PDF 页图）
    url, nbytes = b64_url(os.path.join(ASSETS, 'page1.png'))
    r = call(mm_messages('这是一页论文截图，请给出它的标题。', [url]), max_tokens=64)
    record('shape', {'case': 'base64_data_url', 'img_bytes': nbytes,
                     'payload_kb': round(len(url) / 1024), 'result': r})
    # 3) 文本+图像混合顺序（text 在前）
    msgs = [{'role': 'user', 'content': [
        {'type': 'text', 'text': '下面两张图是否来自同一页文档？回答是或否。'},
        img_part(url), img_part(url)]}]
    r = call(msgs, max_tokens=16)
    record('shape', {'case': 'text_first_two_images', 'result': r})


def phase_count():
    small = os.path.join(ASSETS, 's224.jpg')
    url, _ = b64_url(small, 'JPEG')
    for n in (1, 4, 8, 16, 24, 32, 48, 64):
        r = call(mm_messages(f'一共传入了{n}张图片，它们内容一致吗？只回答"是"或"否"。', [url] * n),
                 max_tokens=8)
        record('count', {'n': n, 'ok': r['ok'],
                         'error': r.get('error'), 'error_body': r.get('error_body'),
                         'usage': r.get('usage'), 'content': (r.get('content') or '')[:40],
                         'total': r.get('total')})
        if not r['ok']:
            break


def phase_size():
    for name in ('tiny16.png', 's224.jpg', 's448.jpg', 's896.jpg', 's1792.jpg',
                 's3584.jpg', 's8192.jpg', 'strip50x2000.jpg', 'page1.png'):
        path = os.path.join(ASSETS, name)
        fmt = 'PNG' if name.endswith('.png') else 'JPEG'
        url, nbytes = b64_url(path, fmt)
        r = call(mm_messages('图片左上角标注的尺寸数字是多少？只回答数字。', [url]), max_tokens=16)
        record('size', {'img': name, 'img_bytes': nbytes,
                        'ok': r['ok'], 'error': r.get('error'),
                        'error_body': r.get('error_body'),
                        'usage': r.get('usage'), 'content': (r.get('content') or '')[:40],
                        'total': r.get('total')})


def phase_tokens():
    """固定文本提示，仅改变图片分辨率，观察 prompt_tokens 随像素数的变化。"""
    text = '描述这张图。'
    r0 = call(mm_messages(text, []), max_tokens=8)
    record('tokens', {'img': 'text_only', 'usage': r0.get('usage')})
    for name in ('s224.jpg', 's448.jpg', 's896.jpg', 's1024.jpg', 's1792.jpg',
                 's2048.jpg', 's3584.jpg', 's4096.jpg'):
        url, nbytes = b64_url(os.path.join(ASSETS, name), 'JPEG')
        r = call(mm_messages(text, [url]), max_tokens=8)
        record('tokens', {'img': name, 'img_bytes': nbytes, 'usage': r.get('usage'),
                          'ok': r['ok'], 'error': r.get('error'),
                          'error_body': r.get('error_body')})


def _filler(n_chars):
    base = '这一段是用于填充上下文窗口的无意义重复文本，不包含任何需要记住的信息。'
    return (base * (n_chars // len(base) + 1))[:n_chars]


def phase_context():
    """先校准 字/ token 比，再分别构造 欠限 / 超限 输入，观察通过、降级还是报错。"""
    needle = '魔法数字是739241。'
    question = '请回答：魔法数字是多少？只回答数字。'
    cal = call([{'role': 'user', 'content': _filler(20000) + question}], max_tokens=16)
    pt = (cal.get('usage') or {}).get('prompt_tokens')
    record('context', {'case': 'calibration', 'chars': 20000 + len(question),
                       'usage': cal.get('usage'), 'ok': cal['ok'],
                       'error': cal.get('error'), 'error_body': cal.get('error_body')})
    if not pt:
        return
    chars_per_token = 20000 / pt
    for label, target_tokens in (('under_limit_950k', 950_000), ('over_limit_1050k', 1_050_000)):
        n_chars = int(target_tokens * chars_per_token)
        content = needle + _filler(n_chars) + question
        r = call([{'role': 'user', 'content': content}], max_tokens=16, timeout=600)
        record('context', {'case': label, 'target_tokens': target_tokens,
                           'chars': len(content), 'ok': r['ok'],
                           'error': r.get('error'), 'error_body': r.get('error_body'),
                           'usage': r.get('usage'),
                           'content': (r.get('content') or '')[:60], 'total': r.get('total')})


def phase_latency():
    small_url, _ = b64_url(os.path.join(ASSETS, 's224.jpg'), 'JPEG')
    page_url, _ = b64_url(os.path.join(ASSETS, 'page1.png'))
    cases = [
        ('text_only', '用一句话介绍你自己。', []),
        ('img_small_x1', '这张图里有什么？一句话回答。', [small_url]),
        ('img_small_x4', '这些图内容一致吗？一句话回答。', [small_url] * 4),
        ('img_small_x8', '这些图内容一致吗？一句话回答。', [small_url] * 8),
        ('img_page_x1', '这是一页论文截图，给出标题。', [page_url]),
    ]
    for rep in range(3):
        for name, text, urls in cases:
            r = call(mm_messages(text, urls), max_tokens=32, stream=True)
            record('latency', {'case': name, 'rep': rep, 'ttft': r.get('ttft'),
                               'total': r.get('total'), 'ok': r['ok'],
                               'error': r.get('error'), 'usage': r.get('usage')})


if __name__ == '__main__':
    phase = sys.argv[1] if len(sys.argv) > 1 else None
    phases = {'assets': phase_assets, 'shape': phase_shape, 'count': phase_count,
              'size': phase_size, 'tokens': phase_tokens, 'context': phase_context,
              'latency': phase_latency}
    if phase not in phases:
        sys.exit(f'用法: probe.py [{"|".join(phases)}]')
    phases[phase]()
