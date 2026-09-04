#!/usr/bin/env python3
"""论文精读 App 本地服务器：服务 public/ 目录，支持手机通过局域网访问。"""
import http.server
import json
import os
import re
import shutil
import socket
import socketserver
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from urllib.parse import parse_qs, urlparse
import webbrowser

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(BASE_DIR, 'public')
SKILLS_DIR = os.path.join(BASE_DIR, 'skills')


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/api/skills':
            self._serve_skills()
            return
        if parsed.path not in ('/api/arxiv', '/api/arxiv-pdf'):
            return super().do_GET()

        paper_id = parse_qs(parsed.query).get('id', [''])[0].strip()
        if not re.fullmatch(r'(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?', paper_id, re.I):
            self.send_error(400, 'Invalid arXiv ID')
            return
        try:
            is_pdf = parsed.path == '/api/arxiv-pdf'
            req = urllib.request.Request(
                f'https://arxiv.org/{"pdf" if is_pdf else "html"}/{paper_id}',
                headers={'User-Agent': 'PaperReader/1.0 (local research tool)'},
            )
            with urllib.request.urlopen(req, timeout=45) as upstream:
                limit = (100 if is_pdf else 30) * 1024 * 1024
                body = upstream.read(limit + 1)
                if len(body) > limit:
                    raise ValueError(f'arXiv {"PDF" if is_pdf else "HTML"} is too large')
                self.send_response(200)
                self.send_header('Content-Type', 'application/pdf' if is_pdf else 'text/html; charset=utf-8')
                if is_pdf:
                    self.send_header('Content-Disposition', f'inline; filename="{paper_id.replace("/", "_")}.pdf"')
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as err:
            self.send_error(err.code, f'arXiv {"PDF" if parsed.path == "/api/arxiv-pdf" else "HTML"} is unavailable for this paper')
        except Exception as err:
            print(f'arXiv import error: {err}', file=sys.stderr)
            self.send_error(502, 'Failed to fetch arXiv HTML')

    def _serve_skills(self):
        """列出 skills/ 下的 .md 文件与原文；frontmatter 解析由前端 parseSkillFile 完成。"""
        try:
            entries = []
            for name in sorted(os.listdir(SKILLS_DIR)):
                path = os.path.join(SKILLS_DIR, name)
                if not name.lower().endswith('.md') or not os.path.isfile(path):
                    continue
                with open(path, encoding='utf-8') as f:
                    entries.append({'file': name, 'text': f.read()})
        except OSError as err:
            print(f'skills read error: {err}', file=sys.stderr)
            self.send_error(500, 'Failed to read skills')
            return
        body = json.dumps(entries, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != '/api/forward':
            self.send_error(404)
            return

        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length <= 0 or length > 10 * 1024 * 1024:
                raise ValueError('请求体大小无效')
            payload = json.loads(self.rfile.read(length))
            target = payload.get('url', '')
            parsed = urlparse(target)
            if parsed.scheme not in ('http', 'https') or not parsed.netloc:
                raise ValueError('仅支持有效的 HTTP/HTTPS API 地址')

            body = payload.get('body')
            data = json.dumps(body).encode('utf-8') if body is not None else None
            headers = {
                str(k): str(v) for k, v in payload.get('headers', {}).items()
                if k.lower() in ('authorization', 'content-type', 'accept')
            }
            # 部分中转站的 Cloudflare 规则会直接拒绝 Python-urllib 的默认 UA。
            headers.setdefault('Accept', 'application/json, text/event-stream')
            headers['User-Agent'] = (
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/131.0.0.0 Safari/537.36'
            )
            if shutil.which('curl.exe') or shutil.which('curl'):
                self._forward_with_curl(target, payload.get('method', 'POST'), headers, data)
                return

            req = urllib.request.Request(
                target, data=data, headers=headers,
                method=payload.get('method', 'POST').upper(),
            )
            try:
                upstream = urllib.request.urlopen(req, timeout=180)
            except urllib.error.HTTPError as err:
                upstream = err

            self.send_response(upstream.status)
            content_type = upstream.headers.get('Content-Type')
            if content_type:
                self.send_header('Content-Type', content_type)
            self.end_headers()
            while chunk := upstream.read(8192):
                self.wfile.write(chunk)
                self.wfile.flush()
            upstream.close()
        except (ValueError, TypeError, json.JSONDecodeError) as err:
            print(f'API proxy input error: {err}', file=sys.stderr)
            self.send_error(400, 'Invalid proxy request')
        except Exception as err:
            print(f'API proxy error: {err}', file=sys.stderr)
            self.send_error(502, 'Upstream request failed')

    def _forward_with_curl(self, target, method, headers, data):
        curl = shutil.which('curl.exe') or shutil.which('curl')
        args = [
            curl, '--silent', '--show-error', '--no-buffer', '--http1.1',
            '--connect-timeout', '20', '--max-time', '180',
            '--dump-header', '-', '--request', str(method).upper(),
        ]
        for name, value in headers.items():
            args.extend(['--header', f'{name}: {value}'])
        if data is not None:
            args.extend(['--data-binary', '@-'])
        args.append(target)

        process = subprocess.Popen(
            args,
            stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if data is not None:
            process.stdin.write(data)
            process.stdin.close()

        status = None
        response_headers = {}
        while True:
            status_line = process.stdout.readline()
            if not status_line:
                error = process.stderr.read().decode('utf-8', errors='replace')
                process.wait()
                raise RuntimeError(error.strip() or 'curl 未返回 HTTP 响应')
            match = re.match(rb'HTTP/\S+\s+(\d+)', status_line)
            if not match:
                raise RuntimeError('curl 返回了无效的 HTTP 响应')
            status = int(match.group(1))
            response_headers = {}
            while True:
                line = process.stdout.readline()
                if line in (b'\r\n', b'\n', b''):
                    break
                name, sep, value = line.partition(b':')
                if sep:
                    response_headers[name.decode('latin-1').lower()] = value.strip().decode('latin-1')
            if status < 200:
                continue
            break

        self.send_response(status)
        if response_headers.get('content-type'):
            self.send_header('Content-Type', response_headers['content-type'])
        self.end_headers()
        while True:
            chunk = process.stdout.read1(8192)
            if not chunk:
                break
            self.wfile.write(chunk)
            self.wfile.flush()
        process.wait()

    def log_message(self, fmt, *args):
        pass  # 保持控制台安静


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'


def main():
    # GBK 等窄编码控制台下 emoji 不可编码，降级为 '?' 而非崩溃；
    # pythonw 等场景下流为 None 或无 reconfigure，直接跳过
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(errors='replace')
    with Server(('0.0.0.0', PORT), Handler) as httpd:
        local = f'http://127.0.0.1:{PORT}'
        lan = f'http://{lan_ip()}:{PORT}'
        print('=' * 46)
        print('  📚 论文精读 App 已启动')
        print(f'  电脑访问：{local}')
        print(f'  手机访问（同一 Wi-Fi）：{lan}')
        print('  按 Ctrl+C 停止')
        print('=' * 46)
        threading.Timer(0.6, lambda: webbrowser.open(local)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n已停止。')


if __name__ == '__main__':
    main()
