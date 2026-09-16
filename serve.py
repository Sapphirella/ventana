#!/usr/bin/env python3
"""Ventana 开发用静态服务 —— 不缓存，改完刷新就能看到。

为什么不用 `python3 -m http.server`：
  1) 它会给静态资源带上缓存头（配合浏览器缓存 + Service Worker，
     手机上经常"改了代码看不到"）；这里一律发 Cache-Control: no-store。
  2) 它默认只绑 127.0.0.1，手机没法访问；这里默认绑 0.0.0.0，
     并且启动时把可用的局域网地址打印出来，方便在手机上直接输地址打开。

用法：
    python3 ventana/serve.py                    # 端口 5210，bind 0.0.0.0
    python3 ventana/serve.py --port 8080
    python3 ventana/serve.py --bind 127.0.0.1   # 只给本机用
"""
import argparse
import functools
import http.server
import os
import re
import socket
import socketserver

APP_DIR = os.path.dirname(os.path.abspath(__file__))


def app_version():
    """从 app.js 里读 VERSION，用来给 styles.css / app.js 的引用打上版本号。

    为什么要这样做：这两个文件改了必须立刻生效（否则手机上一直看旧样式/
    旧脚本）。SW 侧已经改成网络优先，这里是第二道保险 —— 即使有中间层
    按 URL 缓存，query 变了也会重新取。
    版本号只在 app.js 里维护一处，避免手工同步漏掉。
    """
    try:
        with open(os.path.join(APP_DIR, 'app.js'), encoding='utf-8') as f:
            head = f.read(2000)
        m = re.search(r"VERSION\s*=\s*'([^']+)'", head)
        return m.group(1) if m else '0'
    except OSError:
        return '0'


_VERSION = app_version()


class Handler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        # index.html 里写的是 styles.css?v=__V__，这里把占位符换成真实版本号
        path = self.translate_path(self.path)
        if os.path.basename(path) == 'index.html' or self.path in ('/', '/index.html'):
            try:
                with open(path, 'rb') as f:
                    body = f.read().replace(b'__V__', _VERSION.encode())
            except OSError:
                return super().send_head()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store, must-revalidate')
            self.end_headers()
            import io
            return io.BytesIO(body)
        return super().send_head()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *args):
        # 只留错误，正常请求别刷屏（1xx/2xx/3xx 都跳过）
        code = str(args[1]) if len(args) > 1 else ''
        if code.startswith('4') or code.startswith('5'):
            super().log_message(fmt, *args)


def lan_ips():
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith('127.'):
                ips.add(ip)
    except OSError:
        pass
    return sorted(ips)


def main():
    ap = argparse.ArgumentParser(description='Ventana 开发用静态服务（不缓存）')
    ap.add_argument('--port', type=int, default=5210)
    ap.add_argument('--bind', default='0.0.0.0')
    args = ap.parse_args()

    handler = functools.partial(Handler, directory=APP_DIR)
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer((args.bind, args.port), handler) as httpd:
        print(f'Ventana 服务已启动（不缓存），目录：{APP_DIR}')
        print(f'  本机：http://127.0.0.1:{args.port}/')
        for ip in lan_ips():
            print(f'  手机（同一个 Wi-Fi）：http://{ip}:{args.port}/')
        print('  Ctrl+C 停止')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n已停止。')


if __name__ == '__main__':
    main()
