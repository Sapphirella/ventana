/**
 * cdp.mjs —— 极简 Chrome DevTools Protocol 客户端（无第三方依赖）
 *
 * 只做三件事：连标签页 WebSocket、发命令收结果、订阅事件。
 * 所有浏览器测试脚本（smoke / shots / bg-color …）都复用它。
 *
 * 用法：
 *   import { connect, launchHint } from './cdp.mjs';
 *   const page = await connect();               // 连到 127.0.0.1:9222 的第一个标签页
 *   await page.send('Page.enable');
 */

const HOST = process.env.CHROME_CDP_HOST || '127.0.0.1';
const PORT = Number(process.env.CHROME_CDP_PORT || 9222);

export const launchHint = () =>
  `未能在 ${HOST}:${PORT} 找到调试端口。请先启动无头 Chrome：\n` +
  `  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\\n` +
  `    --headless=new --remote-debugging-port=${PORT} \\\n` +
  `    --user-data-dir=/tmp/ventana-cdp --no-sandbox --disable-gpu \\\n` +
  `    --window-size=390,844 about:blank &\n` +
  `（macOS 沙箱下 Chrome 必须带 --no-sandbox，否则会 "Failed to initialize sandbox" 直接崩）`;

async function httpJson(path) {
  const res = await fetch(`http://${HOST}:${PORT}${path}`);
  if (!res.ok) throw new Error(`CDP HTTP ${res.status} ${path}`);
  return res.json();
}

/** 连上第一个可用的 page 标签页，返回带 send/on/close 的句柄 */
export async function connect() {
  let list;
  try {
    list = await httpJson('/json/list');
  } catch (e) {
    throw new Error(launchHint());
  }
  let target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) {
    // 没有标签页就新建一个
    const created = await httpJson('/json/new?about:blank');
    target = created;
  }
  return open(target.webSocketDebuggerUrl);
}

/** 直接对某个 target 打开裸 CDP 连接 */
export function open(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = new Map();

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(new Error('CDP WebSocket 连接失败：' + (e.message || 'error'))));
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
    } catch (e) {
      return;
    }
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    const arr = listeners.get(msg.method);
    if (arr) arr.forEach((fn) => fn(msg.params));
  });

  const api = {
    ready,
    send(method, params = {}) {
      id += 1;
      const myId = id;
      return new Promise(async (resolve, reject) => {
        try { await ready; } catch (e) { return reject(e); }
        pending.set(myId, { resolve, reject });
        ws.send(JSON.stringify({ id: myId, method, params }));
        setTimeout(() => {
          if (pending.has(myId)) {
            pending.delete(myId);
            reject(new Error(`CDP 命令超时：${method}`));
          }
        }, params.__timeout || 60000);
      });
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
      return () => {
        const arr = listeners.get(method) || [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      };
    },
    once(method, timeout = 30000) {
      return new Promise((resolve, reject) => {
        const off = api.on(method, (p) => { off(); resolve(p); });
        setTimeout(() => { off(); reject(new Error(`等待事件超时：${method}`)); }, timeout);
      });
    },
    close() { try { ws.close(); } catch (e) {} },
  };
  return api;
}

/* ---------------- 常用组合命令 ---------------- */

/** 模拟一台手机（视口 + 触摸 + DPR + UA） */
export async function emulateMobile(page, { width = 390, height = 844, dpr = 3 } = {}) {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: dpr, mobile: true,
    screenWidth: width, screenHeight: height,
  });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page.send('Emulation.setUserAgentOverride', {
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
  });
}

/** 切换系统深浅色（Chrome 的 prefers-color-scheme） */
export async function setColorScheme(page, scheme) {
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  });
}

/** 打开页面并等网络空闲 + 一小段稳定期 */
export async function goto(page, url, { settle = 350 } = {}) {
  await page.send('Page.enable');
  const loaded = page.once('Page.loadEventFired');
  await page.send('Page.navigate', { url });
  try { await loaded; } catch (e) {}
  await sleep(settle);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在页面里跑一段表达式，抛错会带出来 */
export async function evaluate(page, expression) {
  const r = await page.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error('页面内求值异常：' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
  }
  return r.result.value;
}

/** 截图并写文件 */
export async function screenshot(page, file, { fullPage = false } = {}) {
  const opts = { format: 'png' };
  if (fullPage) opts.captureBeyondViewport = true;
  const { data } = await page.send('Page.captureScreenshot', opts);
  const fs = await import('node:fs/promises');
  await fs.writeFile(file, Buffer.from(data, 'base64'));
  return file;
}
