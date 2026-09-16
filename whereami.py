#!/usr/bin/env python3
"""查当前的局域网访问地址（换网络/换地方以后跑一下就知道该用哪个网址）。

为什么需要它：Mac 换到另一个 Wi-Fi（或连手机热点）之后 IP 会变，
之前存的书签（比如 192.168.31.101:5210）就失效了 —— 看着像"网页打不开了"，
其实服务一直好好的，只是地址变了。

用法：
    python3 ventana/whereami.py                 # 列出当前地址 + 二维码
    python3 ventana/whereami.py --port 5177     # 只看某一个端口
    python3 ventana/whereami.py --no-qr         # 不打二维码

零依赖：二维码是自己画的（只用标准库）。终端里显示二维码要求背景是深色、
前景是浅色，和常见的二维码配色相反 —— 这是终端本身的限制，扫码没问题。
"""
import argparse
import os
import socket
import subprocess
import sys

# 关注的端口 → 名字。加服务就往这里加一行。
SERVICES = [
    (5210, 'Ventana'),
    (5177, 'VidaOS'),
]


def lan_ips():
    """本机所有可用的局域网 IPv4（排除回环与链路本地）。"""
    ips = []
    try:
        out = subprocess.run(['ifconfig'], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        out = ''
    for line in out.splitlines():
        line = line.strip()
        if line.startswith('inet '):
            ip = line.split()[1]
            if ip.startswith('127.') or ip.startswith('169.254.'):
                continue
            ips.append(ip)
    if not ips:
        # 兜底：靠"连一个外部地址"反推本机出口 IP（不发包，只查路由）
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(('8.8.8.8', 80))
            ip = s.getsockname()[0]
            s.close()
            if not ip.startswith('127.'):
                ips.append(ip)
        except Exception:
            pass
    # 去重且保持顺序
    seen, out_ips = set(), []
    for ip in ips:
        if ip not in seen:
            seen.add(ip)
            out_ips.append(ip)
    return out_ips


def listening_ports():
    """当前真正在监听的端口集合（没在听的就别给地址了）。"""
    ports = set()
    try:
        out = subprocess.run(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN'],
                             capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return None
    for line in out.splitlines()[1:]:
        parts = line.split()
        for p in parts:
            if ':' in p:
                tail = p.rsplit(':', 1)[-1]
                if tail.isdigit():
                    ports.add(int(tail))
    return ports


def wifi_name():
    try:
        out = subprocess.run(
            ['/usr/sbin/networksetup', '-getairportnetwork', 'en0'],
            capture_output=True, text=True, timeout=5).stdout.strip()
        if ':' in out:
            return out.split(':', 1)[1].strip()
    except Exception:
        pass
    return ''


# ---------------- 二维码 ----------------
# 用 _vendor/segno（纯 Python、MIT，已随项目附带）。
# 为什么不自己写：手写那份试过，模块级 diff 显示 87/625 个模块和参考实现不同，
# 那个尺寸下纠错余量装不下这些差异，扫码器直接识别不出来 ——
# "画出来像二维码"和"真的能扫"是两回事。带一份成熟的实现比修自己的 bug 便宜。
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '_vendor'))
try:
    import segno
except Exception:            # 万一 _vendor 被删了，也别让整个脚本挂掉
    segno = None


def qr_matrix(text):
    """返回二维码的 0/1 矩阵（没有 segno 就抛异常，由调用方降级）。"""
    if segno is None:
        raise RuntimeError('缺少 _vendor/segno，无法生成二维码')
    qr = segno.make(text, error='m', boost_error=False)
    return [[1 if v else 0 for v in row] for row in qr.matrix]


def print_qr(text):
    try:
        m = qr_matrix(text)
    except Exception as e:
        print('   （二维码生成失败：%s）' % e)
        return
    # 终端里用两个半块字符画，一字符高 ≈ 两模块
    reset = '\033[0m'
    for y in range(0, len(m), 2):
        line = ''
        for x in range(len(m)):
            top = m[y][x]
            bot = m[y + 1][x] if y + 1 < len(m) else 0
            if top and bot:
                line += '\u2588'          # █
            elif top and not bot:
                line += '\u2580'          # ▀
            elif not top and bot:
                line += '\u2584'          # ▄
            else:
                line += ' '
        print('  ' + line)


def main():
    ap = argparse.ArgumentParser(description='查当前的局域网访问地址')
    ap.add_argument('--port', type=int, help='只看这个端口')
    ap.add_argument('--no-qr', action='store_true', help='不打印二维码')
    args = ap.parse_args()

    ips = lan_ips()
    live = listening_ports()
    ssid = wifi_name()

    print('=' * 56)
    print(' 当前网络：%s' % (ssid or '（不是 Wi-Fi，或读不到名字）'))
    print(' 本机地址：%s' % (', '.join(ips) if ips else '（没找到局域网 IP）'))
    print('=' * 56)
    if not ips:
        print('没找到局域网地址：可能没连任何网络。')
        return 1

    targets = [(p, n) for p, n in SERVICES if not args.port or p == args.port]
    if not targets:
        print('没有匹配的端口。已知服务：%s' % ', '.join('%d(%s)' % (p, n) for p, n in SERVICES))
        return 1

    for port, name in targets:
        if live is not None and port not in live:
            print('\n%s (: %d) —— 服务没在跑，先启动它' % (name, port))
            continue
        for ip in ips:
            url = 'http://%s:%d/' % (ip, port)
            print('\n%s → %s' % (name, url))
            if not args.no_qr:
                print_qr(url)
    print('\n提示：手机要和这台电脑在**同一个网络**里（同一个 Wi-Fi，或都连手机热点）。')
    print('      如果页面打不开，先确认手机连的网络和上面这个地址是同一网段。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
