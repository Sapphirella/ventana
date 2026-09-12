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
import socket
import socketserver

APP_DIR = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
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
