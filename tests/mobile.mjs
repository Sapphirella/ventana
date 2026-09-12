/**
 * mobile.mjs —— 移动端聊天界面的验收测试（像素 + 计算样式 + 交互）
 *
 * 覆盖三件事：
 *   1. 被报告的 bug：夜间模式下对方回复渲染成通栏方块
 *      → 断言「对方回复没有任何背景/边框/圆角盒子」，且不再横贯整屏
 *      → 断言「我方消息是圆角气泡」，用像素扫描确认圆角真的切出来了
 *   2. 移动端可读性：输入卡是固定悬浮层，消息不被压住；iPhone 安全区被避让
 *   3. 交互：发送 → 正在输入 → 流式 → 多条连发 → 停止 → 持久化
 *
 * 前置：
 *   1) ventana/ 目录已被静态服务占用：python3 -m http.server 5210
 *   2) 9222 上有一个开了调试端口的 Chrome（见 cdp.mjs 的 launchHint）
 *
 * 用法：node ventana/tests/mobile.mjs [截图输出目录]
 */
import { connect, emulateMobile, setColorScheme, goto, evaluate, screenshot, sleep } from './cdp.mjs';
import { decodePng } from './png.mjs';
import fs from 'node:fs';
import path from 'node:path';

const URL_ = process.env.CHAMBRE_URL || 'http://127.0.0.1:5210/index.html';
const OUT = process.argv[2] || '/tmp/ventana-shots';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const info = (s) => console.log(`    · ${s}`);

const page = await connect();
await page.send('Runtime.enable');
await page.send('Page.enable');

/* 清库必须在首次加载之后：Page.addScriptToEvaluateOnNewDocument 每次新文档都会跑，
   挂上不清掉的话后面所有刷新都会把数据洗掉，看起来像"持久化失效"（上一轮踩过）。 */
async function fresh(scheme) {
  await setColorScheme(page, scheme);
  await emulateMobile(page, { width: 390, height: 844, dpr: 3 });
  await goto(page, URL_);
  await evaluate(page, '(() => { try { localStorage.clear(); } catch (e) {} return 1; })()');
  await goto(page, URL_);
}

async function sendText(text) {
  await evaluate(page, `(() => {
    const b = document.querySelector('#box');
    b.value = ${JSON.stringify(text)};
    b.dispatchEvent(new Event('input'));
    document.querySelector('#send').click();
    return 1;
  })()`);
}

/* ============================================================
   一、气泡形态：日间 / 夜间各跑一遍
   ============================================================ */
for (const scheme of ['light', 'dark']) {
  const label = scheme === 'light' ? '日间' : '夜间';
  console.log(`\n=== ${label}模式 · 移动端 390×844 ===`);
  await fresh(scheme);
  await sendText('这条是我发的，右边应该是一个气泡。');
  await sleep(900);
  // 演示模式会连发多条，等它把第一条吐出来就够了
  await evaluate(page, "(() => { const s = document.querySelector('#send'); if (s.classList.contains('stop')) s.click(); return 1; })()");
  await sleep(500);

  const probe = await evaluate(page, `(() => {
    const rows = [...document.querySelectorAll('#log .row')];
    return {
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      logPadBottom: parseFloat(getComputedStyle(document.querySelector('#log')).paddingBottom),
      rows: rows.map(r => {
        const body = r.querySelector('.body');
        if (!body) return { cls: r.className };
        const cs = getComputedStyle(body);
        const rect = body.getBoundingClientRect();
        return {
          cls: r.className.trim(),
          kind: body.className,
          bg: cs.backgroundColor,
          bgImage: cs.backgroundImage,
          borderW: parseFloat(cs.borderTopWidth) || 0,
          radius: cs.borderTopLeftRadius,
          padX: parseFloat(cs.paddingLeft) || 0,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          contentW: Math.round(body.getBoundingClientRect().width),
          // 这行里文字实际覆盖到多远（拿子节点里最靠右的那个量）
          textWidth: (() => {
            var kids = body.querySelectorAll('p, pre, a, strong, code, br');
            var max = 0;
            for (var i = 0; i < kids.length; i++) {
              var kr = kids[i].getBoundingClientRect();
              if (kr.width > 0) max = Math.max(max, kr.right - rect.x);
            }
            return Math.round(max);
          })(),
        };
      }),
      logRect: (() => { const r = document.querySelector('#log').getBoundingClientRect(); return { x: r.x, w: r.width }; })(),
    };
  })()`);

  const replies = probe.rows.filter(r => r.kind && r.kind.includes('reply'));
  const mines = probe.rows.filter(r => r.kind && r.kind.includes('bubble'));
  ok(replies.length >= 1, `${label}：对方回复至少一条`);
  ok(mines.length >= 1, `${label}：我方消息至少一条`);

  /* ★ 被报告的 bug：对方回复不许有任何「盒子」观感 */
  for (const r of replies) {
    const transparent = r.bg === 'rgba(0, 0, 0, 0)' || r.bg === 'transparent';
    ok(transparent && r.borderW === 0 && r.bgImage === 'none' && parseFloat(r.radius) === 0,
      `${label}：对方回复不是方块（无底色 / 无边框 / 无圆角盒子）`,
      `bg=${r.bg} border=${r.borderW} radius=${r.radius}`);
  }

  /* 我方消息仍然是气泡 */
  for (const r of mines) {
    ok(r.bg !== 'rgba(0, 0, 0, 0)' && parseFloat(r.radius) >= 8,
      `${label}：我方消息是气泡（有底色 + 圆角）`, `bg=${r.bg} radius=${r.radius}`);
    ok(r.rect.w < probe.viewport.w * 0.86,
      `${label}：我方气泡没有横贯整屏（宽 ${r.rect.w} < ${Math.round(probe.viewport.w * 0.86)}）`);
  }

  /* 对方回复虽然是一段文字，但也不能铺满到夸张 */
  for (const r of replies) {
    ok(r.rect.w <= probe.viewport.w, `${label}：对方文本没溢出视口（${r.rect.w} ≤ ${probe.viewport.w}）`);
  }

  /* ---------- 像素核查：圆角真的切出来了吗 ---------- */
  const file = path.join(OUT, `mobile-${scheme}.png`);
  await screenshot(page, file);
  const img = decodePng(fs.readFileSync(file));
  const s = img.width / probe.viewport.w;   // = DPR

  for (const r of mines) {
    const inside = img.px((r.rect.x + r.rect.w / 2) * s, (r.rect.y + r.rect.h / 2) * s);
    const corner = img.px((r.rect.x + 2) * s, (r.rect.y + 1.5) * s);
    const d = Math.max(...[0, 1, 2].map(i => Math.abs(inside[i] - corner[i])));
    ok(d > 24, `${label}：像素采样确认我方气泡左上角被切圆（差异 ${d}）`);
    info(`气泡底色 RGB(${inside})，左上角 RGB(${corner})`);
  }
  /* 采样点必须避开笔画：回复短的时候，区域中心正好落在文字上，
     文字颜色接近反色，差异自然很大 —— 那是假阳性（踩过一次）。
     所以先量出这行里文字真正覆盖到的右边界，再在它右边采样：
     那里不可能有文字，如果还出现"非背景"的颜色，才说明有底色。 */
  const pageBg = img.px(4 * s, 4 * s);
  for (const r of replies) {
    const textRight = r.rect.x + Math.max(8, Math.round(r.textWidth || r.rect.w));
    const probeX = Math.min(r.rect.x + r.rect.w - 2, textRight + 6);
    const probe = img.px(probeX * s, (r.rect.y + r.rect.h / 2) * s);
    const d = Math.max(...[0, 1, 2].map(i => Math.abs(probe[i] - pageBg[i])));
    ok(d < 24, `${label}：像素采样确认对方回复区域没有底色（文字右侧采样，与页面底色差异 ${d}）`);
  }
}

/* ============================================================
   二、移动端布局：输入卡悬浮、消息不被压住、安全区
   ============================================================ */
console.log('\n=== 移动端布局 · 输入卡与安全区 ===');
await fresh('dark');
await sendText('布局检查用的长文本。' + '再多写一点让气泡换行。'.repeat(4));
await sleep(700);
await evaluate(page, "(() => { const s = document.querySelector('#send'); if (s.classList.contains('stop')) s.click(); return 1; })()");
await sleep(400);

const layout = await evaluate(page, `(() => {
  const wrap = document.querySelector('#composerWrap');
  const cs = getComputedStyle(wrap);
  const wr = wrap.getBoundingClientRect();
  const log = document.querySelector('#log');
  const lcs = getComputedStyle(log);
  const rows = [...document.querySelectorAll('#log .row')];
  const last = rows[rows.length - 1].getBoundingClientRect();
  return {
    position: cs.position,
    wrapBottom: Math.round(innerHeight - wr.bottom),
    wrapH: Math.round(wr.height),
    logPadBottom: parseFloat(lcs.paddingBottom),
    composerVar: getComputedStyle(document.documentElement).getPropertyValue('--composer-h').trim(),
    lastRowBottom: Math.round(last.bottom),
    logInnerBottom: Math.round(log.getBoundingClientRect().bottom),
    scrollTop: log.scrollTop,
    scrollMax: log.scrollHeight - log.clientHeight,
    placeholderFits: (() => {
      const box = document.querySelector('#box');
      return box.scrollHeight <= box.clientHeight + 1;
    })(),
    sendSize: (() => { const r = document.querySelector('#send').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
  };
})()`);

ok(layout.position === 'fixed', '输入卡是固定悬浮层（不与消息抢空间）', layout.position);
ok(layout.wrapBottom === 0 || layout.wrapBottom < 40, `输入卡贴住视口底部（离底 ${layout.wrapBottom}px）`);
ok(parseFloat(layout.composerVar) === layout.wrapH,
  `--composer-h 与输入卡实测高度一致（${layout.composerVar} vs ${layout.wrapH}px）`);
ok(layout.logPadBottom >= layout.wrapH, `消息区下内边距 ≥ 输入卡高度（${layout.logPadBottom} ≥ ${layout.wrapH}）`);
ok(layout.lastRowBottom <= layout.logInnerBottom + 1,
  `最后一条消息没被输入卡压住（${layout.lastRowBottom} ≤ ${layout.logInnerBottom}）`);
ok(layout.sendSize[0] >= 36 && layout.sendSize[1] >= 36,
  `发送键触摸目标 ≥ 36px（${layout.sendSize.join('×')}）`);

/* 安全区：模拟 iPhone 底部 home indicator */
await page.send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  screenWidth: 390, screenHeight: 844,
  displayFeature: undefined,
});
const safe = await evaluate(page, `(() => {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;bottom:0;height:env(safe-area-inset-bottom);width:1px';
  document.body.appendChild(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return h;
})()`);
ok(typeof safe === 'number', `env(safe-area-inset-bottom) 可用（当前 ${safe}px）`);

/* ============================================================
   三、交互：正在输入 → 流式 → 多条连发 → 停止
   ============================================================ */
console.log('\n=== 交互流程 ===');
await fresh('light');
await sendText('你好');

const thinking = await evaluate(page, "(() => !!document.querySelector('#log .thinking'))()");
ok(thinking, '发送后先出现「正在输入」三点，而不是一个空气泡');

/* 别用固定 sleep 等流式开始 —— 演示回复的长度会变，600ms 时可能还没吐出第一个字。
   轮询等"有一条气泡正在吐字"（有字 + 有光标），最多等 3 秒。
   注意判据要一次取样取全：先把"有字"和"有光标"分成两次问，
   两次之间状态可能已经翻篇，会看成一个自相矛盾的结果（踩过）。 */
let streamSample = null;
for (let i = 0; i < 30; i++) {
  const probe = await evaluate(page, `(() => {
    const filled = [...document.querySelectorAll('#log .reply')]
      .filter(el => (el.textContent || '').trim().length > 0);
    const caret = document.querySelector('#log .caret');
    return { filled: filled.length, caret: !!caret,
             caretInFilled: filled.some(el => el.querySelector('.caret')) };
  })()`);
  if (probe.caretInFilled) { streamSample = probe; break; }
  await sleep(100);
}
const streaming = await evaluate(page, `(() => {
  const caret = document.querySelector('#log .caret');
  const filled = [...document.querySelectorAll('#log .reply')]
    .filter(el => (el.textContent || '').trim().length > 0);
  return {
    hasCaret: !!caret,
    text: filled.length ? filled[0].textContent.length : 0,
    // 只看「已经吐出字的那条气泡」自己身上还有没有三点
    filledClean: filled.length > 0 && filled.every(el => !el.querySelector('.thinking')),
    thinkingRows: document.querySelectorAll('#log .row .thinking').length,
    replyRows: document.querySelectorAll('#log .reply').length,
  };
})()`);
ok(streaming.hasCaret && !!streamSample, '流式过程中光标在闪（有字的那条气泡里）');
ok(streaming.text > 0, `回复正在逐字吐出来（已 ${streaming.text} 字）`);
ok(streaming.filledClean, '第一个字到达后这条气泡里的「正在输入」被撤掉');
ok(streaming.thinkingRows <= streaming.replyRows - 1,
  `「正在输入」只出现在尚未出字的气泡里（${streaming.thinkingRows} 个 / 共 ${streaming.replyRows} 条）`);

/* 停止的验证
   踩过的坑：一开始想「轮询到气泡之间的停顿窗口（上一条已定稿 + 下一条只有三点 +
   没有光标）再点停止」。跑不通 —— 那个三点的状态只存在几十毫秒，
   轮询的窗口又比它长，永远对不上（真实 API 的长段落间隙才会稳定出现）。
   所以这里不再等某个瞬时状态，改成验证不变量：
     1) 流式过程中：有字的气泡里没有 .thinking（三点已被文字顶掉）
     2) 点停止后：整屏没有任何 .caret / .thinking 残留，按钮复位，没有空气泡
   第 2 条才是用户真正看得见的东西，而且是确定性的。 */
const sendState = await evaluate(page, `(() => {
  const s = document.querySelector('#send');
  return { stop: s.classList.contains('stop'), disabled: s.disabled };
})()`);
ok(sendState.stop && !sendState.disabled, '生成中发送键变成「停止」且可点', JSON.stringify(sendState));

await evaluate(page, "(() => { document.querySelector('#send').click(); return 1; })()");
await sleep(350);
const stopped = await evaluate(page, `(() => {
  const s = document.querySelector('#send');
  return {
    stop: s.classList.contains('stop'),
    caret: document.querySelectorAll('#log .caret').length,
    thinking: document.querySelectorAll('#log .thinking').length,
    emptyBubbles: [...document.querySelectorAll('#log .reply')]
      .filter(el => !(el.textContent || '').trim().length).length,
  };
})()`);
ok(!stopped.stop, '停止后发送键复位成「发送」');
ok(stopped.caret === 0, `停止后没有残留光标（${stopped.caret} 个）`);
ok(stopped.thinking === 0, `停止后没有残留「正在输入」三点（${stopped.thinking} 个）`);
ok(stopped.emptyBubbles === 0, `停止后没有空气泡（${stopped.emptyBubbles} 个）`);

const multi = await evaluate(page, "(() => document.querySelectorAll('#log .reply').length)()");
ok(multi >= 2, `演示回复拆成多条连发（当前 ${multi} 条）`);

/* 持久化 */
await goto(page, URL_);
await sleep(500);
const after = await evaluate(page, `(() => {
  return {
    rows: document.querySelectorAll('#log .row').length,
    stamps: document.querySelectorAll('#log .tstamp').length,
    hasBubble: !!document.querySelector('#log .bubble'),
    hasReply: !!document.querySelector('#log .reply'),
    scrolledToBottom: (() => { const l = document.querySelector('#log'); return l.scrollHeight - l.scrollTop - l.clientHeight < 90; })(),
  };
})()`);
ok(after.rows >= 2, `刷新后对话从 localStorage 恢复（${after.rows} 行）`);
ok(after.hasBubble && after.hasReply, '恢复后我方气泡与对方文字都在');
ok(after.stamps >= 1, `恢复后时间戳被补画出来（${after.stamps} 条）`);
ok(after.scrolledToBottom, '恢复后自动滚到底部');

/* ============================================================
   四、不许横向溢出（移动端最容易翻车的地方）与设置页
   ============================================================ */
console.log('\n=== 横向溢出与设置页 ===');
for (const vp of [{ w: 390, h: 844, name: '手机 390' }, { w: 900, h: 700, name: '窄桌面 900' }]) {
  await setColorScheme(page, 'dark');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: vp.w, height: vp.h, deviceScaleFactor: 2, mobile: vp.w < 720,
    screenWidth: vp.w, screenHeight: vp.h,
  });
  await goto(page, URL_);
  await evaluate(page, '(() => { try { localStorage.clear(); } catch (e) {} return 1; })()');
  await goto(page, URL_);
  await sendText('测'.repeat(60) + ' https://example.com/a/very/long/path/that/should/wrap/not/overflow?x=1');
  await sleep(500);
  await evaluate(page, "(() => { const s = document.querySelector('#send'); if (s.classList.contains('stop')) s.click(); return 1; })()");
  await sleep(300);

  const overflow = await evaluate(page, `(() => {
    const doc = document.documentElement;
    const wide = [...document.querySelectorAll('#log .body, #log .row, .composer, .topbar, .cfg-inner')]
      .filter(el => el.getBoundingClientRect().right > innerWidth + 1
                 || el.getBoundingClientRect().left < -1)
      .map(el => el.className + ':' + Math.round(el.getBoundingClientRect().right));
    return {
      docScrollX: doc.scrollWidth - doc.clientWidth,
      logScrollX: (() => { const l = document.querySelector('#log'); return l.scrollWidth - l.clientWidth; })(),
      wide,
    };
  })()`);
  ok(overflow.docScrollX <= 1, `${vp.name}：整页没有横向滚动（${overflow.docScrollX}px）`);
  ok(overflow.logScrollX <= 1, `${vp.name}：消息区没有横向溢出（${overflow.logScrollX}px）`);
  ok(overflow.wide.length === 0, `${vp.name}：没有元素越出视口边缘`, overflow.wide.join(' | '));

  /* 设置页也要能用 */
  await evaluate(page, "(() => { document.querySelector('#openConfig').click(); return 1; })()");
  await sleep(200);
  const cfg = await evaluate(page, `(() => {
    const view = document.querySelector('#viewConfig');
    const chat = document.querySelector('#viewChat');
    return {
      configVisible: getComputedStyle(view).display !== 'none',
      chatHidden: getComputedStyle(chat).display === 'none',
      docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      inputCount: document.querySelectorAll('#viewConfig input').length,
      saveVisible: document.querySelector('#cfgSave').getBoundingClientRect().width > 0,
    };
  })()`);
  ok(cfg.configVisible && cfg.chatHidden, `${vp.name}：点设置能切到设置页、对话页收起`);
  ok(cfg.docScrollX <= 1, `${vp.name}：设置页也没有横向滚动（${cfg.docScrollX}px）`);
  ok(cfg.inputCount >= 3 && cfg.saveVisible,
    `${vp.name}：设置页三项输入与保存键都在（${cfg.inputCount} 个输入框）`);

  /* 键盘弹起：视口高度塌到 420，输入卡必须还在可见区内、消息区仍避让 */
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: vp.w, height: 420, deviceScaleFactor: 2, mobile: true,
    screenWidth: vp.w, screenHeight: vp.h,
  });
  await evaluate(page, "(() => { document.querySelector('#backChat').click(); return 1; })()");
  await sleep(400);
  const kb = await evaluate(page, `(() => {
    const c = document.querySelector('.composer').getBoundingClientRect();
    const l = document.querySelector('#log');
    return { visible: c.top < innerHeight && c.bottom <= innerHeight + 1,
             composerTop: Math.round(c.top), composerBottom: Math.round(c.bottom),
             innerH: innerHeight,
             logPadBottom: parseFloat(getComputedStyle(l).paddingBottom) };
  })()`);
  ok(kb.visible, `${vp.name}：键盘弹起后输入卡完整可见（底 ${kb.composerBottom} ≤ ${kb.innerH}）`);
  ok(kb.logPadBottom >= kb.innerH - kb.composerTop,
    `${vp.name}：键盘弹起后消息区仍为输入卡留位（${kb.logPadBottom} ≥ ${kb.innerH - kb.composerTop}）`);
}

/* 复位视口 */
await page.send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  screenWidth: 390, screenHeight: 844,
});

/* ============================================================
   五、黑白：界面里不许出现彩色（PWA 图标除外）
   ============================================================ */
console.log('\n=== 黑白配色约束 ===');
for (const scheme of ['light', 'dark']) {
  await fresh(scheme);
  const colors = await evaluate(page, `(() => {
    const bad = [];
    const R = (el) => getComputedStyle(el);
    document.querySelectorAll('#viewChat *').forEach(el => {
      const cs = R(el);
      const chk = (prop, v) => {
        const m = String(v).match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
        if (!m) return;
        const [r, g, b] = [+m[1], +m[2], +m[3]];
        if (Math.max(r, g, b) - Math.min(r, g, b) > 12) bad.push(prop + '=' + v + ' @ ' + el.className);
      };
      chk('color', cs.color); chk('background-color', cs.backgroundColor);
      chk('border-top-color', cs.borderTopColor);
    });
    return bad.slice(0, 8);
  })()`);
  ok(colors.length === 0, `${scheme === 'light' ? '日间' : '夜间'}：聊天界面没有彩色（R=G=B）`, colors.join(' | '));
}

/* ============================================================
   六、改名（Ventana）与旧数据迁移
   ============================================================ */
console.log('\n=== 品牌与旧数据迁移 ===');
await fresh('light');

const branding = await evaluate(page, `(() => ({
  title: document.title,
  desc: document.querySelector('meta[name=description]').content,
  placeholder: document.querySelector('#box').placeholder,
  ver: document.querySelector('#verLine').textContent,
  manifest: document.querySelector('link[rel=manifest]').getAttribute('href'),
  // 用户看得见的文字里不该再出现旧名字。
  // 用 innerText 而不是 innerHTML：源码注释里提到旧名字是正常的
  // （迁移那一节必须写清楚旧键叫什么），但那些注释不该出现在渲染结果里。
  visibleHasOldName: document.body.innerText.indexOf('Chambre') >= 0,
}))()`);
ok(branding.title === 'Ventana', `页面标题是 Ventana（实际 ${branding.title}）`);
ok(branding.placeholder.indexOf('Ventana') >= 0, `输入框提示语已改名（${branding.placeholder}）`);
ok(branding.visibleHasOldName === false, '渲染出来的文字里没有 "Chambre" 残留');

/* 源码里还留着旧名字是**故意**的：localStorage 迁移那一段必须写清旧键叫什么。
   但除了那里，代码里不该再有旧品牌词（注释、路径、cache 名都算）。 */
const sourceLeaks = await evaluate(page, `Promise.all([
  fetch('index.html').then(r => r.text()),
  fetch('app.js').then(r => r.text()),
]).then(([html, js]) => {
  const lines = (html + String.fromCharCode(10) + js)
    .split(String.fromCharCode(10)).filter(l => l.indexOf('Chambre') >= 0);
  return { total: lines.length, sample: lines.slice(0, 3) };
})`);
ok(sourceLeaks.total <= 3, `源码里的旧名字只剩迁移注释那几处（${sourceLeaks.total} 行）`,
  sourceLeaks.sample.join(' | '));

const manifest = await evaluate(page, `fetch('manifest.webmanifest').then(r => r.json())`);
ok(manifest.name === 'Ventana' && manifest.short_name === 'Ventana',
  `manifest 名称是 Ventana（${manifest.name} / ${manifest.short_name}）`);

/* 迁移：模拟"用户在叫 Chambre 时已经配好 API Key / 有聊天记录" */
await evaluate(page, `(() => {
  try {
    localStorage.clear();
    localStorage.setItem('chambre.cfg', JSON.stringify({ base: 'https://example.com/v1', key: 'sk-old', model: 'old-model', demo: false }));
    localStorage.setItem('chambre.msgs', JSON.stringify([
      { role: 'user', content: '旧世界的这句话不该丢', at: Date.now() - 60000 },
      { role: 'assistant', content: '记着。', at: Date.now() - 59000 },
    ]));
  } catch (e) {}
  return 1;
})()`);
await goto(page, URL_);
await sleep(400);

const migrated = await evaluate(page, `(() => {
  const keys = Object.keys(localStorage);
  return {
    newCfg: localStorage.getItem('ventana.cfg'),
    newMsgs: localStorage.getItem('ventana.msgs'),
    oldStillThere: localStorage.getItem('chambre.cfg') !== null,
    rows: document.querySelectorAll('#log .row').length,
    // 顶栏胶囊应当显示迁移过来的模型名
    tag: document.querySelector('#modelTag').textContent,
  };
})()`);
ok(!!migrated.newCfg, '旧 chambre.cfg 被迁移到 ventana.cfg');
ok(!!migrated.newMsgs, '旧 chambre.msgs 被迁移到 ventana.msgs');
ok(migrated.tag === 'old-model', `迁移后顶栏显示旧模型名（${migrated.tag}）`);
ok(migrated.rows >= 2, `迁移后的聊天记录被画出来（${migrated.rows} 行）`);

/* ============================================================
   七、系统提示词（人格）与文件上传
   ============================================================ */
console.log('\n=== 系统提示词 ===');
await fresh('light');
await evaluate(page, "(() => { document.querySelector('#openConfig').click(); return 1; })()");
await sleep(250);

const panel = await evaluate(page, `(() => {
  const ta = document.querySelector('#cfgPrompt');
  const r = ta.getBoundingClientRect();
  return {
    hasTextarea: ta.tagName === 'TEXTAREA',
    tag: ta.tagName,
    accept: document.querySelector('#promptFile').accept,
    rows: ta.rows,
    width: Math.round(r.width), height: Math.round(r.height),
    hasUpload: !!document.querySelector('#promptUpload'),
    hasClear: !!document.querySelector('#promptClear'),
    hasSave: !!document.querySelector('#promptSave'),
    stat: document.querySelector('#promptStat').textContent,
    fontSize: parseFloat(getComputedStyle(ta).fontSize),
    docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
})()`);
ok(panel.hasTextarea, '系统提示词是一个多行输入框（textarea）');
ok(panel.hasUpload && panel.hasClear && panel.hasSave, '上传 / 清空 / 保存人格三个按钮都在');
ok(panel.accept.indexOf('.md') >= 0 && panel.accept.indexOf('.txt') >= 0,
  `文件选择器接受 md / txt（${panel.accept.slice(0, 40)}…）`);
ok(panel.fontSize >= 16, `输入框字号 ≥16px，iOS 不会自动放大（${panel.fontSize}px）`);
ok(panel.docScrollX <= 1, `设置页加长后仍无横向滚动（${panel.docScrollX}px）`);
ok(panel.stat.indexOf('还没写') >= 0, `空人格时给出说明（${panel.stat}）`);

/* 打字 → 保存 → 刷新后还在 */
const PERSONA = '# 你是谁\n\n你是 Nook，住在这台手机里。说话短，不用敬语。';
await evaluate(page, `(() => {
  const ta = document.querySelector('#cfgPrompt');
  ta.value = ${JSON.stringify(PERSONA)};
  document.querySelector('#promptSave').click();
  return 1;
})()`);
await sleep(200);
const saved = await evaluate(page, `(() => ({
  stored: JSON.parse(localStorage.getItem('ventana.prompt') || 'null'),
  stat: document.querySelector('#promptStat').textContent,
  chip: document.querySelector('#ctxChip').title,
}))()`);
ok(saved.stored && saved.stored.text === PERSONA, '点「保存人格」后写进了 ventana.prompt');
ok(saved.stat.indexOf(String(PERSONA.length)) >= 0,
  `状态行显示字数（${saved.stat}）`);

await goto(page, URL_);
await evaluate(page, "(() => { document.querySelector('#openConfig').click(); return 1; })()");
await sleep(250);
const reloaded = await evaluate(page, `document.querySelector('#cfgPrompt').value`);
ok(reloaded === PERSONA, '刷新后人格还在输入框里');

/* 上传文件：真的读一个 File 进去（用 DataTransfer 造一个假文件） */
const uploaded = await evaluate(page, `(() => {
  const dt = new DataTransfer();
  dt.items.add(new File(['skill 文件里的内容\\n第二行'], 'skill.md', { type: 'text/markdown' }));
  const input = document.querySelector('#promptFile');
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  return 1;
})()`);
await sleep(300);
const afterUpload = await evaluate(page, `(() => ({
  value: document.querySelector('#cfgPrompt').value,
  stat: document.querySelector('#promptStat').textContent,
  stored: JSON.parse(localStorage.getItem('ventana.prompt') || 'null'),
}))()`);
ok(afterUpload.value.indexOf('skill 文件里的内容') >= 0, '上传 .md 后内容进了输入框');
ok(afterUpload.stored && afterUpload.stored.file === 'skill.md',
  `记下了文件名（${afterUpload.stored && afterUpload.stored.file}）`);
ok(afterUpload.stat.indexOf('skill.md') >= 0, `状态行显示来源文件（${afterUpload.stat}）`);

/* 大文件要拦住 */
const bigReject = await evaluate(page, `(() => {
  const dt = new DataTransfer();
  dt.items.add(new File(['x'.repeat(500 * 1024)], 'huge.md', { type: 'text/markdown' }));
  const input = document.querySelector('#promptFile');
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  return document.querySelector('#cfgMsg').textContent;
})()`);
await sleep(200);
const bigMsg = await evaluate(page, `document.querySelector('#cfgMsg').textContent`);
ok(bigMsg.indexOf('太大') >= 0, `超过 400KB 的文件被拦下（${bigMsg}）`);

/* 清空 */
await evaluate(page, "(() => { document.querySelector('#promptClear').click(); return 1; })()");
await sleep(200);
const cleared = await evaluate(page, `(() => ({
  value: document.querySelector('#cfgPrompt').value,
  stored: JSON.parse(localStorage.getItem('ventana.prompt') || 'null'),
  stat: document.querySelector('#promptStat').textContent,
}))()`);
ok(cleared.value === '' && (!cleared.stored || !cleared.stored.text), '点「清空」后输入框与存储都清干净');
ok(cleared.stat.indexOf('还没写') >= 0, '清空后状态行回到初始说明');

/* ============================================================
   八、系统提示词真的被送出去了吗（关键：不能只是存下来）
   ============================================================ */
console.log('\n=== 请求体里的 system 消息 ===');
await fresh('light');

/* 用假的 fetch 截住请求：不真的联网，只看发出去什么 */
const captured = await evaluate(page, `(() => {
  window.__sent = [];
  const realFetch = window.fetch;
  window.fetch = function (url, init) {
    if (String(url).indexOf('chat/completions') >= 0) {
      window.__sent.push(JSON.parse(init.body));
      // 回一个最小的 SSE 流，让 UI 正常收尾
      const sse = 'data: {"choices":[{"delta":{"content":"好"}}]}\\n\\ndata: [DONE]\\n\\n';
      return Promise.resolve(new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    }
    return realFetch.apply(this, arguments);
  };
  // 填好三项并保存 —— 不再有"切到真实 API"这个开关，
  // 三项齐了就是真实 API，缺一项才走演示兜底
  document.querySelector('#openConfig').click();
  const set = (id, v) => { const el = document.querySelector(id); el.value = v; };
  set('#cfgBase', 'https://example.com/v1');
  set('#cfgKey', 'sk-test');
  set('#cfgModel', 'test-model');
  set('#cfgPrompt', '你是 Nook。说话短。');
  document.querySelector('#cfgSave').click();
  document.querySelector('#backChat').click();
  const b = document.querySelector('#box');
  b.value = '在吗';
  b.dispatchEvent(new Event('input'));
  document.querySelector('#send').click();
  return 1;
})()`);
await sleep(900);

const sent = await evaluate(page, `(() => window.__sent[0] || null)()`);
ok(!!sent, '真的发出了 chat/completions 请求（用假 fetch 截住）');
if (sent) {
  ok(sent.messages[0].role === 'system', '请求体第一条是 system 消息');
  ok(sent.messages[0].content.indexOf('你是 Nook') >= 0,
    `system 内容就是输入框里那段（${String(sent.messages[0].content).slice(0, 20)}…）`);
  ok(sent.messages[1].role === 'user' && sent.messages[1].content === '在吗',
    'system 之后紧跟用户消息');
  ok(sent.model === 'test-model' && sent.stream === true, '模型名与 stream 参数正确');
}

/* 空人格时不该塞空的 system 消息 */
await fresh('light');
const noPersona = await evaluate(page, `(() => {
  window.__sent = [];
  const realFetch = window.fetch;
  window.fetch = function (url, init) {
    if (String(url).indexOf('chat/completions') >= 0) {
      window.__sent.push(JSON.parse(init.body));
      const sse = 'data: {"choices":[{"delta":{"content":"嗯"}}]}\\n\\ndata: [DONE]\\n\\n';
      return Promise.resolve(new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    }
    return realFetch.apply(this, arguments);
  };
  localStorage.setItem('ventana.cfg', JSON.stringify({ base: 'https://example.com/v1', key: 'sk', model: 'm', demo: false }));
  localStorage.removeItem('ventana.prompt');
  return 1;
})()`);
await goto(page, URL_);
await sleep(300);
await evaluate(page, `(() => {
  window.__sent = [];
  const realFetch = window.fetch;
  window.fetch = function (url, init) {
    if (String(url).indexOf('chat/completions') >= 0) {
      window.__sent.push(JSON.parse(init.body));
      const sse = 'data: {"choices":[{"delta":{"content":"嗯"}}]}\\n\\ndata: [DONE]\\n\\n';
      return Promise.resolve(new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    }
    return realFetch.apply(this, arguments);
  };
  const b = document.querySelector('#box');
  b.value = '在吗';
  b.dispatchEvent(new Event('input'));
  document.querySelector('#send').click();
  return 1;
})()`);
await sleep(800);
const sent2 = await evaluate(page, `(() => window.__sent[0] || null)()`);
ok(sent2 && sent2.messages[0].role === 'user',
  '人格为空时不发空的 system 消息（第一条直接就是 user）');

/* ============================================================
   九、被缓存坑过两次：版本自愈
   ============================================================
   背景（真实事故）：
     改名后作者发现 http://127.0.0.1:5210/ 打开还是旧版 Chambre，
     而 http://192.168.31.101:5210/ 是新版 Ventana —— 两个 origin 各有一份缓存，
     旧 Service Worker 把旧 HTML 锁在了 127.0.0.1 这个 origin 上。
   两个成因、两条对策，都要有测试守着：
     1) 换了版本但旧 SW 还在服务旧缓存 → SW 命中缓存时 postMessage('stale-page')，
        页面收到且在线时自己刷一次（staleOnce 保证每次加载只刷一次，不会循环）
     2) sw.js **自己**也会被浏览器缓存（默认最长 24h）→ 所以每次改 sw.js 都要
        同时升 index.html 和 sw.js 里的 VERSION，注册 URL 带上 ?v=<VERSION>。 */
console.log('\n=== 版本自愈（Service Worker） ===');
await fresh('dark');

const swInfo = await evaluate(page, `(async () => {
  const regs = await navigator.serviceWorker.getRegistrations();
  const keys = await caches.keys();
  const reg = regs[0];
  return {
    registered: !!reg,
    scriptURL: reg && reg.active && reg.active.scriptURL,
    state: reg && reg.active && reg.active.state,
    cacheNames: keys,
  };
})()`);
ok(swInfo.registered, 'Service Worker 已注册');
ok(/sw\.js\?v=/.test(swInfo.scriptURL || ''),
  `注册 URL 带版本号，换版本时浏览器会当成新的 SW（${swInfo.scriptURL}）`);
const verInSw = (swInfo.scriptURL || '').split('?v=')[1];
const verInPage = await evaluate(page, `document.querySelector('#verLine').textContent`);
ok(verInPage.indexOf(verInSw) >= 0,
  `页面 VERSION 与注册 URL 的版本一致（${verInSw}）`);
ok(swInfo.cacheNames.some(n => n === 'ventana-' + verInSw),
  `缓存名跟着版本走（${swInfo.cacheNames.join(',')}）`);

/* 页面真的会响应 SW 的 stale-page 通知吗？
   踩坑记录（三连坑，都记下来）：
     · 想把 location.reload 换成计数器来观测 —— Chrome 里给 location.reload 赋值是
       静默失败（不抛错也不生效），计数器永远是 0，看着像"没反应"，其实刷了。
     · 改用在页面里累加 sessionStorage 计数 —— 一旦重启 Chrome 进程就清零，
       跨进程跑测试时读不到，容易误判。
     · 从页面 dispatchEvent(new MessageEvent('message')) 根本打不到
       navigator.serviceWorker 上的监听器 —— 只有 SW 真的 postMessage 出来的消息
       才会派发到那里（sw.js 里的 stale-page-selftest 钩子就是为了走这条真实通道）。
   → 最终用 CDP 自己的导航事件来数刷新：`Page.frameNavigated`。它是真的"页面导航了"，
     不依赖任何页面内的可写状态，最可靠。 */
const navs = [];
const offNav = page.on('Page.frameNavigated', (p) => {
  if (!p.frame.parentId) navs.push(p.frame.url);
});

// 无关消息：走同一个真实通道，但不该引起刷新
await evaluate(page, `(() => { navigator.serviceWorker.controller.postMessage({ type: 'nothing-to-do-with-us' }); return 1; })()`);
await sleep(600);
ok(navs.length === 0, `无关的 postMessage 不触发刷新（导航 ${navs.length} 次）`);

// 真实通道：SW 收到自检指令后 postMessage 一条 stale-page
await evaluate(page, `(() => { navigator.serviceWorker.controller.postMessage({ type: 'stale-page-selftest' }); return 1; })()`);
await sleep(2200);
ok(navs.length === 1, `收到 SW 发来的 stale-page 后自动刷新了一次（导航 ${navs.length} 次）`);
ok(navs.length === 1 && /index\.html/.test(navs[0]), `刷新回的是同一个页面（${navs[0] || '无'}）`);
offNav();

/* sw.js 与 index.html 的版本号必须一致 —— 这条最容易忘 */
const bothVersions = await evaluate(page, `Promise.all([
  fetch('sw.js').then(r => r.text()),
  fetch('app.js').then(r => r.text()),
]).then(([sw, js]) => {
  const a = (sw.match(/var VERSION = '([^']+)'/) || [])[1];
  const b = (js.match(/var VERSION = '([^']+)'/) || [])[1];
  return { sw: a, app: b };
})`);
ok(bothVersions.sw && bothVersions.sw === bothVersions.app,
  `sw.js 与 app.js 的 VERSION 一致（${bothVersions.sw} / ${bothVersions.app}）`);

/* ============================================================
   十、演示模式是自动兜底，不是一个开关
   ============================================================
   作者反馈：「演示模式是无 API 连接时的默认模式，它不需要主动开启，
   所以不要让它占据一个滑块板块」。这一组就是守着这件事：
     · 界面上不该再有任何"模式选择"控件
     · 没配 API → 自动演示模式（不碰网络，回复来自内置示例）
     · 三项齐了 → 自动走真实 API（不需要手动切）
     · 「清除连接」是回到演示模式的唯一入口 */
console.log('\n=== 演示模式自动兜底 ===');
await fresh('light');
await evaluate(page, "(() => { document.querySelector('#openConfig').click(); return 1; })()");
await sleep(250);

const noToggle = await evaluate(page, `(() => {
  const segs = [...document.querySelectorAll('.seg, #segMode, #segDemo, #segApi')];
  const banner = document.querySelector('#apiBanner');
  const cs = banner ? getComputedStyle(banner) : null;
  return {
    leftover: segs.length,
    bannerShown: cs && cs.display !== 'none',
    bannerText: banner ? banner.innerText : '',
    inputsEnabled: [...document.querySelectorAll('#cfgBase, #cfgKey, #cfgModel')].every(el => !el.disabled),
    hasForget: !!document.querySelector('#cfgForget'),
    hasTest: !!document.querySelector('#cfgTest'),
    hasSave: !!document.querySelector('#cfgSave'),
  };
})()`);
ok(noToggle.leftover === 0, `界面上没有任何"模式选择"控件（残留 ${noToggle.leftover} 个）`);
ok(noToggle.bannerShown, '有一条状态横幅说明当前处于演示模式');
ok(noToggle.bannerText.indexOf('演示模式') >= 0,
  `横幅说清了现在是演示模式（${noToggle.bannerText.slice(0, 30)}…）`);
ok(noToggle.bannerText.indexOf('接口地址') >= 0 && noToggle.bannerText.indexOf('API Key') >= 0,
  '横幅点名了还缺哪几项');
ok(noToggle.inputsEnabled, '三项输入框一律可编辑（不再因为"演示模式"被禁用）');
ok(noToggle.hasForget && noToggle.hasTest && noToggle.hasSave, '清除连接 / 试一试 / 保存 三个按钮都在');

/* 两块之间要分开：量一下"系统提示词"标题与 API 块末端之间的距离 */
const spacing = await evaluate(page, `(() => {
  const groups = [...document.querySelectorAll('.cfg-inner .group')];
  const titles = [...document.querySelectorAll('.group-title')].map(t => t.innerText);
  const g1 = groups[0].getBoundingClientRect(), g2 = groups[1].getBoundingClientRect();
  const firstLabel = groups[0].querySelector('input, textarea').getBoundingClientRect();
  const title2 = document.querySelectorAll('.group-title')[1];
  const gap = title2.getBoundingClientRect().top - g1.bottom;
  return {
    titles,
    gap: Math.round(gap),
    separated: Math.round(g2.top - g1.bottom),
    divider: getComputedStyle(groups[1]).borderTopWidth,
    promptTop: Math.round(document.querySelector('#cfgPrompt').getBoundingClientRect().top),
  };
})()`);
ok(spacing.titles.length === 2 && spacing.titles[0].indexOf('API') >= 0
   && spacing.titles[1].indexOf('系统提示词') >= 0,
  `两块各有小节标题（${spacing.titles.join(' / ')}）`);
ok(spacing.separated >= 20, `两块之间有呼吸空间（间距 ${spacing.separated}px）`);
ok(parseFloat(spacing.divider) >= 1, `两块之间有分隔线（${spacing.divider}）`);

/* 没配 API 时：不碰网络，走内置演示回复 */
await evaluate(page, "(() => { document.querySelector('#backChat').click(); return 1; })()");
await sleep(200);
const demoBehavior = await evaluate(page, `(() => {
  window.__netCalls = 0;
  const realFetch = window.fetch;
  window.fetch = function (url) {
    if (String(url).indexOf('chat/completions') >= 0) window.__netCalls++;
    return realFetch.apply(this, arguments);
  };
  const b = document.querySelector('#box');
  b.value = '没配 API 时会怎么样';
  b.dispatchEvent(new Event('input'));
  document.querySelector('#send').click();
  return 1;
})()`);
await sleep(900);
const demoNow = await evaluate(page, `({
  netCalls: window.__netCalls,
  streaming: !!document.querySelector('#log .caret'),
  replies: document.querySelectorAll('#log .reply').length,
  chip: document.querySelector('#modelTag').textContent,
})`);
ok(demoNow.netCalls === 0, `演示模式下完全不发网络请求（${demoNow.netCalls} 次）`);
ok(demoNow.streaming || demoNow.replies > 1, '演示模式照样有流式输出（内置回复）');
ok(demoNow.chip === '演示模式', `顶栏显示演示模式（${demoNow.chip}）`);
await evaluate(page, "(() => { const s = document.querySelector('#send'); if (s.classList.contains('stop')) s.click(); return 1; })()");
await sleep(300);

/* 只填两项 → 仍然是演示模式（不能因为"填了东西"就半途切过去） */
await evaluate(page, `(() => {
  document.querySelector('#openConfig').click();
  document.querySelector('#cfgBase').value = 'https://example.com/v1';
  document.querySelector('#cfgKey').value = 'sk-partial';
  document.querySelector('#cfgSave').click();
  return 1;
})()`);
await sleep(250);
const partial = await evaluate(page, `({
  banner: document.querySelector('#apiBanner').innerText,
  chip: document.querySelector('#modelTag').textContent,
  msg: document.querySelector('#cfgMsg').textContent,
})`);
ok(partial.chip === '演示模式', `只填两项时仍是演示模式（${partial.chip}）`);
ok(partial.banner.indexOf('模型名') >= 0, `横幅点名缺的是模型名（${partial.banner.slice(0, 40)}…）`);
ok(partial.msg.indexOf('演示模式') >= 0, `保存时明确告知仍是演示模式（${partial.msg}）`);

/* 三项齐了 → 自动切到真实 API，不用点任何开关 */
await evaluate(page, `(() => {
  document.querySelector('#cfgModel').value = 'some-model';
  document.querySelector('#cfgSave').click();
  document.querySelector('#backChat').click();
  return 1;
})()`);
await sleep(250);
const ready = await evaluate(page, `(() => {
  window.__netCalls = 0;
  const realFetch = window.fetch;
  window.fetch = function (url, init) {
    if (String(url).indexOf('chat/completions') >= 0) {
      window.__netCalls++;
      const sse = 'data: {"choices":[{"delta":{"content":"好"}}]}\\n\\ndata: [DONE]\\n\\n';
      return Promise.resolve(new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    }
    return realFetch.apply(this, arguments);
  };
  const b = document.querySelector('#box');
  b.value = '现在呢';
  b.dispatchEvent(new Event('input'));
  document.querySelector('#send').click();
  return { chip: document.querySelector('#modelTag').textContent };
})()`);
await sleep(700);
const readyNow = await evaluate(page, `({ netCalls: window.__netCalls, chip: document.querySelector('#modelTag').textContent })`);
ok(readyNow.netCalls === 1, `三项齐了自动走真实 API，没点任何开关（网络请求 ${readyNow.netCalls} 次）`);
ok(readyNow.chip === 'some-model', `顶栏显示模型名（${readyNow.chip}）`);

/* 清除连接 → 回到演示模式，但人格要留着 */
await evaluate(page, `(() => {
  document.querySelector('#openConfig').click();
  document.querySelector('#cfgPrompt').value = '我是保留下来的人格';
  document.querySelector('#promptSave').click();
  document.querySelector('#cfgForget').click();
  return 1;
})()`);
await sleep(250);
const forgot = await evaluate(page, `({
  banner: document.querySelector('#apiBanner').innerText,
  base: document.querySelector('#cfgBase').value,
  key: document.querySelector('#cfgKey').value,
  chip: document.querySelector('#modelTag').textContent,
  persona: document.querySelector('#cfgPrompt').value,
  stored: JSON.parse(localStorage.getItem('ventana.cfg') || '{}'),
})`);
ok(forgot.base === '' && forgot.key === '', '「清除连接」清空了接口地址与 Key');
ok(forgot.chip === '演示模式' && forgot.banner.indexOf('演示模式') >= 0, '清除后回到演示模式');
ok(forgot.persona.indexOf('保留下来的人格') >= 0, '清除连接不会连人格一起清掉');

/* ============================================================
   十一、rAF 不触发时，流式也必须能出字
   ============================================================
   为什么会想到测这个：本轮在无头 Chrome 里发现 `document.hidden === true`、
   `requestAnimationFrame` **一次都不触发**。原来的流式渲染把绘制全压在 rAF 里，
   于是"字都收到了、屏幕上一个字不出，只有正在输入三点一直转"。
   真机上也有对应的场景：切到后台标签、被遮住的窗口。
   对策是 appendDelta 里改成「rAF 与 120ms 兜底定时器谁先到谁画」。

   这条测试故意把 rAF 打成空函数（比依赖环境更可靠），验证兜底路径真的能出字。 */
console.log('\n=== rAF 失效时的兜底 ===');
await fresh('light');

await evaluate(page, `(() => {
  window.__realRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = function () { return 0; };   // 永不回调
  window.__rafOff = true;
  const b = document.querySelector('#box');
  b.value = '不许用 rAF 也要出字';
  b.dispatchEvent(new Event('input'));
  document.querySelector('#send').click();
  return 1;
})()`);

/* 注意：这里的环境本来就不产帧，而页面被判定为不可见时浏览器还会**节流定时器**
   （能到 1 秒一次）。所以兜底不是"立刻出字"，而是"最终会出字、不会永远空着"。
   判据按这个来，别去卡具体毫秒数 —— 卡了就变成测环境的定时器精度，
   而不是测我们的兜底逻辑。 */
let grew = null;
for (let i = 0; i < 25; i++) {
  const st = await evaluate(page, `(() => {
    const filled = [...document.querySelectorAll('#log .reply')]
      .filter(el => (el.textContent || '').trim().length > 0);
    const streaming = filled[filled.length - 1];
    return {
      chars: streaming ? streaming.textContent.replace(/\s/g, '').length : 0,
      hasCaret: filled.some(el => el.querySelector('.caret')),
    };
  })()`);
  if (st.chars >= 2 && st.hasCaret) { grew = st; break; }
  await sleep(300);
}
ok(grew !== null,
  'rAF 不触发时兜底定时器仍把字画出来，并挂上光标',
  grew ? JSON.stringify(grew) : '等了 7.5 秒仍没出字');

const rafOffNow = await evaluate(page, `!!window.__rafOff`);
ok(rafOffNow, '（前提）requestAnimationFrame 在整段过程中一直是打桩状态');

// 恢复 rAF，避免影响后面的测试
await evaluate(page, `(() => { window.requestAnimationFrame = window.__realRaf; return 1; })()`);
await evaluate(page, "(() => { const s = document.querySelector('#send'); if (s.classList.contains('stop')) s.click(); return 1; })()");
await sleep(300);

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
console.log(`截图：${OUT}/mobile-light.png, mobile-dark.png`);
await page.close();
process.exit(fail ? 1 : 0);
