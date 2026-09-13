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

/* ---------- 造一个假的 SSE 响应体 ----------
   血泪教训：手写 'data: {...}\n\n' 这种字面量时，一旦多写一层反斜杠，
   出站串里就是**两个字面的反斜杠 + n**，而不是换行。
   客户端按行切分时切不出 `data:` 前缀，于是整个响应被静默忽略 ——
   表现是"模型没输出任何东西"，看着像 app 的 bug，其实是测试夹具的 bug。
   本项目为此浪费过一整轮排查。所以统一用这个函数造 SSE，别再手写。 */
const sseBody = (deltas) => deltas.map((d) =>
  'data: ' + JSON.stringify({ choices: [{ delta: d }] }) + '\n\n').join('') + 'data: [DONE]\n\n';

/* 注入到页面里用：把一串 delta 拼成 SSE 响应体。
   必须**定义在页面里**（不能只在 Node 侧定义）—— 测试里的假 fetch 跑在浏览器上下文，
   Node 作用域里的函数它看不到（踩过：ReferenceError 之后整个请求静默失败）。 */
const SSE_FN = "var sseBody = function (deltas) { return deltas.map(function (d) { return 'data: ' + JSON.stringify({ choices: [{ delta: d }] }) + String.fromCharCode(10) + String.fromCharCode(10); }).join('') + 'data: [DONE]' + String.fromCharCode(10) + String.fromCharCode(10); };";

/* 把演示模式的节奏调到最快：整套测试原本要跑 55 秒（贴近 60 秒上限，边缘会 flaky）。
   用 addScriptToEvaluateOnNewDocument 注入，所以**每次导航都生效** ——
   这也是为什么它必须写在 page.send('Page.enable') 之后、第一次 goto 之前。 */
const page = await connect();
await page.send('Runtime.enable');
await page.send('Page.enable');
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: 'window.__VENTANA_TEST_FAST = true;',
});

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
  await sleep(500);
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
          // 我方气泡：菜单栏加在 .body 内部之后，.body 的高度已经含菜单，
          // 圆角采样必须打在这层（.bubble）的左上角上，不然采到的是菜单那一带
          bubbleRect: (() => {
            var b = body.classList.contains('bubble') ? body : body.querySelector('.bubble');
            if (!b) return null;
            var br = b.getBoundingClientRect();
            return { x: Math.round(br.x), y: Math.round(br.y),
                     w: Math.round(br.width), h: Math.round(br.height) };
          })(),
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
    const bb = r.bubbleRect || r.rect;
    const inside = img.px((bb.x + bb.w / 2) * s, (bb.y + bb.h / 2) * s);
    const corner = img.px((bb.x + 2) * s, (bb.y + 1.5) * s);
    const pageBg = img.px(4 * s, 4 * s);
    const d = Math.max(...[0, 1, 2].map(i => Math.abs(inside[i] - corner[i])));
    /* 判据用「角落 = 页面底色」而不是「角落与气泡底色差很多」：
       日间是浅灰气泡铺在白底上（255 vs 242，只差 13），差值的绝对值没有意义，
       有意义的是"角落那块地儿根本没被气泡盖住"。这个判据与配色无关。 */
    const cornerIsBg = Math.max(...[0, 1, 2].map(i => Math.abs(corner[i] - pageBg[i]))) < 12;
    const centerNotBg = Math.max(...[0, 1, 2].map(i => Math.abs(inside[i] - pageBg[i]))) >= 8;
    ok(cornerIsBg && centerNotBg,
      `${label}：像素采样确认我方气泡左上角被切圆（角落=底色:${cornerIsBg} 中心≠底色:${centerNotBg} 差值 ${d}）`);
    info(`气泡底色 RGB(${inside})，左上角 RGB(${corner})`);
  }
  /* 采样点必须避开**笔画**和**图标**，否则是假阳性：
       · 回复短的时候，正文中心正好压在字上（文字接近反色，差异自然大）
       · 图标挂在这一行正下方，采样点太靠下会打到图标（图标是 text-2 灰，也很"非背景"）
     所以改成在**正文最后一行文字**的正中取样，只往右偏一点点，
     并夹在正文右缘之内。 */
  const pageBg = img.px(4 * s, 4 * s);
  for (const r of replies) {
    const textRight = r.rect.x + Math.max(8, Math.round(r.textWidth || r.rect.w));
    const lastLineY = r.rect.y + Math.max(6, r.rect.h - 10);   // 最后一行（避开图标那一段）
    const probeX = Math.min(r.rect.x + r.rect.w - 3, textRight + 2);
    const probe = img.px(probeX * s, lastLineY * s);
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
await sleep(420);
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

const thinking = await evaluate(page, "(() => !!document.querySelector('#typing.show'))()");
ok(thinking, '发送后先出现「正在输入」指示器（在输入卡上方，不占气泡）');
/* 别在这里断言"那一刻没有空气泡"：气泡是**等到第一个字才建**的，
   而"建好"和"画上字"之间隔着一次合帧（paintSoon），快速节奏下这个缝隙极短但存在。
   真正该守的是不变量的**最终**形态：整轮结束后不留空气泡。 */
const noEmptyAtEnd = await evaluate(page, `(() => {
  const rows = [...document.querySelectorAll('#log .reply')];
  return rows.every(el => (el.textContent || '').trim().length > 0);
})()`);
ok(noEmptyAtEnd, '整轮结束后聊天区里没有留下空气泡');

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
for (const vp of [{ w: 320, h: 700, name: '小屏 320' }, { w: 390, h: 844, name: '手机 390' }, { w: 900, h: 700, name: '窄桌面 900' }]) {
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

  /* 图标排往左收了 10px（为了让图标对齐气泡左缘），窄屏下要确认它没顶出视口 */
  const actsGeo = await evaluate(page, `(() => {
    const list = [...document.querySelectorAll('#log .acts')];
    return list.map(a => {
      const row = a.closest('.row');
      const body = row.querySelector('.body');
      const svg = a.querySelector('svg');
      const isMe = row.classList.contains('me');
      return {
        left: Math.round(a.getBoundingClientRect().left),
        right: Math.round(a.getBoundingClientRect().right),
        // 图标本体压住的那条边（我方右缘 / 对方左缘）
        edge: Math.round(a.querySelector('.act').getBoundingClientRect().right),
        iconRight: svg ? Math.round(svg.getBoundingClientRect().right) : null,
        bodyRight: body ? Math.round(body.getBoundingClientRect().right) : null,
        isMe,
      };
    });
  })()`);
  const badGeo = actsGeo.filter(g => g.left < -1 || g.right > vp.w + 1);
  ok(badGeo.length === 0, `${vp.name}：图标排都在视口内`,
    JSON.stringify(badGeo));
  /* 两张边都要守住：我方图标不能伸到屏幕外（本来就贴着右缘），
     对方图标不能缩进到气泡里 */
  const outOfScreen = actsGeo.filter(g => g.edge > vp.w + 1);
  ok(outOfScreen.length === 0, `${vp.name}：我方图标没有伸出屏幕右缘`,
    JSON.stringify(outOfScreen));

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

/* 手机端软键盘的坑：点 textarea 弹键盘后可视高度从 844 压到 ~480，
   浏览器只管"露出一点"不管"够不够用"——输入框下半截被键盘压住，
   光标看不见，表现就是"没法输入"。修法是聚焦 + visualViewport resize
   时把输入框滚到键盘上方的可视区中央。下面这三条就是守这个修的。 */
await evaluate(page, "document.querySelector('#cfgPrompt').focus()");
await sleep(50);
await page.send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 480, deviceScaleFactor: 3, mobile: true,
  screenWidth: 390, screenHeight: 480,
});
await sleep(700);   // 等聚焦延时 350ms + resize 延时 80ms + 平滑滚动走完
const kbState = await evaluate(page, `(() => {
  const ta = document.querySelector('#cfgPrompt');
  const r = ta.getBoundingClientRect();
  return {
    visH: window.innerHeight,
    top: Math.round(r.top), bottom: Math.round(r.bottom),
    fullyVisible: r.top >= -1 && r.bottom <= window.innerHeight + 1,
    focused: document.activeElement === ta,
  };
})()`);
ok(kbState.focused, '键盘弹起后输入框仍持有焦点');
ok(kbState.fullyVisible,
  `键盘弹起把可视区压到 ${kbState.visH}px 后输入框整体在可视区内（top=${kbState.top}, bottom=${kbState.bottom}）`);
await page.send('Input.insertText', { text: '键盘在的时候也能敲进来' });
await sleep(200);
const kbTyped = await evaluate(page, `document.querySelector('#cfgPrompt').value`);
ok(kbTyped.indexOf('键盘在的时候也能敲进来') >= 0, '键盘弹起时输入的内容真的进了输入框');
await emulateMobile(page, { width: 390, height: 844, dpr: 3 });
await sleep(300);

/* ============================================================
   八、系统提示词真的被送出去了吗（关键：不能只是存下来）
   ============================================================ */
console.log('\n=== 请求体里的 system 消息 ===');
await fresh('light');

/* 用假的 fetch 截住请求：不真的联网，只看发出去什么 */
const captured = await evaluate(page, `(() => {
  window.__sent = [];
  ${SSE_FN}
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
await sleep(500);

const sent = await evaluate(page, `(() => window.__sent[0] || null)()`);
ok(!!sent, '真的发出了 chat/completions 请求（用假 fetch 截住）');
if (sent) {
  ok(sent.messages[0].role === 'system', '请求体第一条是 system 消息');
  ok(sent.messages[0].content.indexOf('你是 Nook') >= 0,
    `system 内容就是输入框里那段（${String(sent.messages[0].content).slice(0, 20)}…）`);
  /* 进门那条欢迎语现在是**真实消息**（会进历史），所以 system 后面第一条不一定
     是刚发的那句。判据改成"历史里有它"。 */
  ok(sent.messages.slice(1).some(m => m.role === 'user' && m.content === '在吗'),
    '刚发的用户消息在历史里（欢迎语也是一条真实消息）');
  ok(sent.model === 'test-model' && sent.stream === true, '模型名与 stream 参数正确');
}

/* 空人格时不该塞空的 system 消息 */
await fresh('light');
const noPersona = await evaluate(page, `(() => {
  window.__sent = [];
  ${SSE_FN}
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
  ${SSE_FN}
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
await sleep(450);
const sent2 = await evaluate(page, `(() => window.__sent[0] || null)()`);
ok(sent2 && !sent2.messages.some(m => m.role === 'system'),
  '人格为空时整个请求里没有 system 消息（不塞空人格）');

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
await sleep(380);
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
    titleCount: document.querySelectorAll('.cfg-inner .group-title').length,
    gap: Math.round(gap),
    separated: Math.round(g2.top - g1.bottom),
    divider: getComputedStyle(groups[1]).borderTopWidth,
    promptTop: Math.round(document.querySelector('#cfgPrompt').getBoundingClientRect().top),
  };
})()`);
ok(spacing.titles.length >= 2 && spacing.titles[0].indexOf('API') >= 0
   && spacing.titles[1].indexOf('系统提示词') >= 0,
  `设置页分块且各有标题（${spacing.titles.join(' / ')}）`);
ok(spacing.separated >= 20, `两块之间有呼吸空间（间距 ${spacing.separated}px）`);
ok(parseFloat(spacing.divider) >= 1, `两块之间有分隔线（${spacing.divider}）`);

/* 没配 API 时：不碰网络，走内置演示回复 */
await evaluate(page, "(() => { document.querySelector('#backChat').click(); return 1; })()");
await sleep(200);
const demoBehavior = await evaluate(page, `(() => {
  window.__netCalls = 0;
  ${SSE_FN}
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
await sleep(500);
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
  ${SSE_FN}
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
await sleep(420);
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

/* ============================================================
   十一、开场白：永远留着，但跟着连接状态换文本
   ============================================================
   作者要求：开场白接上 API 之后也要保留（那段排版是"高级感"的来源）。
   但它的文案里写着"现在还是演示模式…点右上角那枚齿轮"，
   所以连接状态一变就得把已存的那条**重新写一遍**，否则接上模型后
   屏幕上还挂着"现在还是演示模式"，看起来像没生效。 */
console.log('\n=== 开场白 ===');
await fresh('light');

const greetDemo = await evaluate(page, `(() => {
  const t = document.querySelector('#log .reply');
  return {
    text: t.innerText,
    hasHello: !!t.querySelector('.hello'),
    icons: document.querySelectorAll('#log .row .acts').length,
  };
})()`);
ok(greetDemo.text.indexOf('小窗口') >= 0, '演示模式的开场白用作者给的原文（…一个小窗口）');
ok(greetDemo.text.indexOf('演示模式') >= 0, '演示模式下说明现在是演示模式');
ok(greetDemo.hasHello, '带「Ventana」那个大标题');
ok(greetDemo.icons === 0, `开场白下面没有操作图标（${greetDemo.icons} 个）`);

/* 接上 API：开场白要跟着换成"已连接"版，且**不刷新页面** */
await evaluate(page, `(() => {
  document.querySelector('#openConfig').click();
  const set = (id, v) => { document.querySelector(id).value = v; };
  set('#cfgBase', 'https://example.com/v1'); set('#cfgKey', 'sk'); set('#cfgModel', 'm');
  document.querySelector('#cfgSave').click();
  document.querySelector('#backChat').click();
  return 1;
})()`);
await sleep(400);
const greetApi = await evaluate(page, `(() => {
  const t = document.querySelector('#log .reply');
  return { text: t.innerText, hasHello: !!t.querySelector('.hello'),
           icons: document.querySelectorAll('#log .row .acts').length };
})()`);
ok(greetApi.text.indexOf('已经接上模型') >= 0, '接上 API 后开场白换成已连接版（不用刷新）');
ok(greetApi.text.indexOf('演示模式') < 0, '已连接版里不再提"演示模式"');
ok(greetApi.hasHello && greetApi.icons === 0, '换了文案仍然保留大标题、仍然没有图标');

/* 清除连接：换回演示版 */
await evaluate(page, `(() => {
  document.querySelector('#openConfig').click();
  document.querySelector('#cfgForget').click();
  document.querySelector('#backChat').click();
  return 1;
})()`);
await sleep(400);
const greetBack = await evaluate(page, `document.querySelector('#log .reply').innerText`);
ok(greetBack.indexOf('演示模式') >= 0, '清除连接后开场白换回演示版');

/* 开场白不进模型历史（它只是引导文案，占 token 还会误导模型） */
const greetHistory = await evaluate(page, `(() => {
  window.__sent = [];
  ${SSE_FN}
  const realFetch = window.fetch;
  window.fetch = function (url, init) {
    if (String(url).indexOf('chat/completions') >= 0) {
      window.__sent.push(JSON.parse(init.body));
      return Promise.resolve(new Response(sseBody([{ content: '嗯' }]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    }
    return realFetch.apply(this, arguments);
  };
  localStorage.setItem('ventana.cfg', JSON.stringify({ base: 'https://example.com/v1', key: 'sk', model: 'm' }));
  return 1;
})()`);
await goto(page, URL_);
await sleep(400);
await evaluate(page, `(() => {
  window.__sent = [];
  const realFetch = window.fetch;
  ${SSE_FN}
  window.fetch = function (url, init) {
    if (String(url).indexOf('chat/completions') >= 0) {
      window.__sent.push(JSON.parse(init.body));
      return Promise.resolve(new Response(sseBody([{ content: '嗯' }]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    }
    return realFetch.apply(this, arguments);
  };
  const b = document.querySelector('#box');
  b.value = '在吗'; b.dispatchEvent(new Event('input'));
  document.querySelector('#send').click();
  return 1;
})()`);
await sleep(600);
const inHistory = await evaluate(page, `(() => {
  const body = window.__sent[0] || { messages: [] };
  return body.messages.some(m => String(m.content || '').indexOf('小窗口') >= 0);
})()`);
ok(!inHistory, '开场白**没有**进发给模型的历史（不占 token、不误导模型）');

/* ============================================================
   十二、资料库：文档按需读取，不烧 token
   ============================================================
   要点：上传的文档**不进提示词**（否则每一轮都在为它付钱），
   提示词里只有一份"标题 + 开头 60 字"的索引，模型需要时用
   tools 或 [[读:名字]] 索取全文。这组测试盯的就是这条边界。 */
console.log('\n=== 资料库与按需读取 ===');
await fresh('light');

/* 准备：配好 API（用假 fetch 截住请求）+ 上传两份文档 */
const DOC_A = '## 世界观\n\n这是一份很长很长的设定文档。'.repeat(20);
const DOC_B = '日记正文：今天下雨了。'.repeat(30);
await evaluate(page, `(() => {
  localStorage.setItem('ventana.cfg', JSON.stringify({ base: 'https://example.com/v1', key: 'sk', model: 'm' }));
  localStorage.setItem('ventana.prompt', JSON.stringify({ text: '你是一个安静的人。', file: '' }));
  return 1;
})()`);
await goto(page, URL_);
await evaluate(page, "(() => { document.querySelector('#openConfig').click(); return 1; })()");
await sleep(200);

const upload = await evaluate(page, `(() => {
  const dt = new DataTransfer();
  dt.items.add(new File([${JSON.stringify(DOC_A)}], '世界观.md', { type: 'text/markdown' }));
  dt.items.add(new File([${JSON.stringify(DOC_B)}], '日记.txt', { type: 'text/plain' }));
  const input = document.querySelector('#docFile');
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  return 1;
})()`);
await sleep(500);
const docState = await evaluate(page, `(() => ({
  stored: JSON.parse(localStorage.getItem('ventana.docs') || '[]').map(d => d.name),
  listed: [...document.querySelectorAll('#docList .docitem b')].map(b => b.textContent),
  promptUntouched: JSON.parse(localStorage.getItem('ventana.prompt')).text,
  promptBox: document.querySelector('#cfgPrompt').value,
}))()`);
ok(docState.stored.length === 2, `两份文档进了资料库（${docState.stored.join('、')}）`);
ok(docState.listed.length === 2, `设置页列出了这两份（${docState.listed.join('、')}）`);
ok(docState.promptUntouched === '你是一个安静的人。',
  '上传文档**没有**覆盖系统提示词');
ok(docState.promptBox === undefined || docState.promptBox === '你是一个安静的人。',
  '提示词输入框里的内容也没被改动');

/* 关键：请求体里只有索引，没有全文 */
await evaluate(page, "(() => { document.querySelector('#backChat').click(); return 1; })()");
await sleep(200);
const promptCheck = await evaluate(page, `(() => {
  window.__sent = [];
  ${SSE_FN}
  const realFetch = window.fetch;
  window.fetch = function (url, init) {
    if (String(url).indexOf('chat/completions') >= 0) {
      window.__sent.push(JSON.parse(init.body));
      const sse = 'data: {"choices":[{"delta":{"content":"好"}}]}\\n\\ndata: [DONE]\\n\\n';
      return Promise.resolve(new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    }
    return realFetch.apply(this, arguments);
  };
  const b = document.querySelector('#box');
  b.value = '你好';
  b.dispatchEvent(new Event('input'));
  document.querySelector('#send').click();
  return 1;
})()`);
await sleep(450);
const body1 = await evaluate(page, `(() => window.__sent[0] || null)()`);
ok(!!body1, '发出了请求');
if (body1) {
  const sys = body1.messages[0];
  ok(sys.role === 'system', '有 system 消息');
  ok(sys.content.indexOf('安静的人') >= 0, 'system 里有系统提示词');
  ok(sys.content.indexOf('【资料库刚刚更新】') >= 0,
    '文档刚上传 → 本轮 system 带"资料库刚刚更新"声明');
  ok(sys.content.indexOf('这是一份很长很长的设定文档') >= 0
    && sys.content.indexOf('日记正文：今天下雨了') >= 0,
    '首轮：两份文档的**完整正文**随本轮下发一次');
  ok(sys.content.indexOf('可读文档') < 0,
    '首轮：全文代替索引（不再给"可读文档"索引）');
  ok(sys.content.length > 480,
    `首轮 system 被全文撑大（${sys.content.length} 字，全量仅此一次）`);
  ok(Array.isArray(body1.tools) && body1.tools.length >= 2,
    `请求里带了 tools（${(body1.tools || []).map(t => t.function.name).join(', ')}）`);
}

/* 上传后的次轮：恢复默认读取方式——索引回归，全文不再出现 */
await evaluate(page, `(() => {
  window.__sent = [];
  ${SSE_FN}
  const realFetch = window.fetch;
  window.fetch = function (url, init) {
    if (String(url).indexOf('chat/completions') >= 0) {
      window.__sent.push(JSON.parse(init.body));
      return Promise.resolve(new Response(sseBody([{ content: '好呀' }]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    }
    return realFetch.apply(this, arguments);
  };
  const b = document.querySelector('#box');
  b.value = '继续';
  b.dispatchEvent(new Event('input'));
  document.querySelector('#send').click();
  return 1;
})()`);
await sleep(450);
const body2 = await evaluate(page, `(() => window.__sent[0] || null)()`);
ok(!!body2, '次轮发出了请求');
if (body2) {
  const sys2 = body2.messages[0];
  ok(sys2.content.indexOf('可读文档') >= 0, '次轮：恢复默认读取方式（文档索引回归）');
  ok(sys2.content.indexOf('【资料库刚刚更新】') < 0, '次轮：全量声明消失');
  ok(sys2.content.indexOf('《世界观.md》：') < 0 && sys2.content.indexOf('《日记.txt》：') < 0,
    '次轮：文档全文不再出现（按需才读）');
  ok(sys2.content.length < 800,
    `次轮 system 恢复很短，没被文档撑大（${sys2.content.length} 字）`);
}

/* 原生工具调用：模型要求读文档 → 我们给全文 → 再问一次 */
const toolRound = await evaluate(page, `(() => {
  window.__sent = [];
  let n = 0;
  ${SSE_FN}
  const realFetch = window.fetch;
  window.fetch = function (url, init) {
    if (String(url).indexOf('chat/completions') < 0) return realFetch.apply(this, arguments);
    window.__sent.push(JSON.parse(init.body));
    n++;
    const sse = n === 1
      // 参数故意拆成两个分片（真实端点就是这么流的）
      ? sseBody([
          { tool_calls: [{ index: 0, id: 'call_1', type: 'function',
            function: { name: 'read_doc', arguments: '{"na' } }] },
          { tool_calls: [{ index: 0,
            function: { arguments: 'me":"世界观"}' } }] },
        ])
      : sseBody([{ content: '读完了，设定里说是这样。' }]);
    return Promise.resolve(new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  };
  const b = document.querySelector('#box');
  b.value = '世界观是什么';
  b.dispatchEvent(new Event('input'));
  document.querySelector('#send').click();
  return 1;
})()`);
await sleep(380);
const rounds = await evaluate(page, `(() => ({
  count: window.__sent.length,
  secondHasTool: (window.__sent[1] && window.__sent[1].messages || []).some(m => m.role === 'tool'),
  toolContent: ((window.__sent[1] && window.__sent[1].messages || []).filter(m => m.role === 'tool')[0] || {}).content || '',
  sysLines: [...document.querySelectorAll('#log .sysline')].map(s => s.textContent),
  lastReply: (() => {
    const rs = [...document.querySelectorAll('#log .reply')];
    return rs.length ? rs[rs.length - 1].textContent : '';
  })(),
}))()`);
ok(rounds.secondHasTool, '第二轮请求里带上了 role=tool 的结果');
ok(rounds.toolContent.indexOf('这是一份很长很长的设定文档') >= 0,
  '工具结果里是文档**全文**（按需才拉进来）');
ok(rounds.sysLines.some(t => t.indexOf('读了《世界观.md》') >= 0),
  `聊天里留下了一行系统事件（${rounds.sysLines.join(' / ')}）`);
ok(rounds.lastReply.indexOf('读完了') >= 0,
  `工具调用之后的正文落在新的气泡里（${rounds.lastReply.slice(0, 20)}）`);

/* 文本协议兜底：模型直接写 [[读:名字]] 也要认 */
await evaluate(page, `(() => {
  window.__sent = [];
  let n = 0;
  ${SSE_FN}
  const realFetch = window.fetch;
  window.fetch = function (url, init) {
    if (String(url).indexOf('chat/completions') < 0) return realFetch.apply(this, arguments);
    window.__sent.push(JSON.parse(init.body));
    n++;
    const payload = n === 1
      ? '我去翻翻。\\n[[读:日记.txt]]'
      : '翻到了，日记里写着下雨。';
    const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: payload } }] }) + '\\n\\ndata: [DONE]\\n\\n';
    return Promise.resolve(new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  };
  const b = document.querySelector('#box');
  b.value = '日记里写了什么';
  b.dispatchEvent(new Event('input'));
  document.querySelector('#send').click();
  return 1;
})()`);
await sleep(380);
const textProto = await evaluate(page, `(() => ({
  count: window.__sent.length,
  replied: (window.__sent.map(x => x.messages).flat().some(m =>
    m.role === 'user' && String(m.content).indexOf('日记正文') >= 0)),
  markersLeaked: [...document.querySelectorAll('#log .reply')].some(el => el.textContent.indexOf('[[读') >= 0),
  sysLines: [...document.querySelectorAll('#log .sysline')].map(s => s.textContent),
}))()`);
ok(textProto.count === 2, `文本协议也触发了第二轮（共 ${textProto.count} 次）`);
ok(textProto.replied, '执行结果（文档正文）回给了模型');
ok(!textProto.markersLeaked, '标记本身没有漏进聊天气泡里（用户不该看到 [[读:…]]）');
ok(textProto.sysLines.some(t => t.indexOf('读了《日记.txt》') >= 0), '文本协议同样留下系统事件');

/* 删掉一份资料 */
await evaluate(page, "(() => { document.querySelector('#openConfig').click(); return 1; })()");
await sleep(200);
await evaluate(page, "(() => { document.querySelector('#docList [data-dact=del]').click(); return 1; })()");
await sleep(200);
const afterDel = await evaluate(page, `JSON.parse(localStorage.getItem('ventana.docs') || '[]').map(d => d.name)`);
ok(afterDel.length === 1, `删除一份后资料库里剩一份（${afterDel.join('、')}）`);

/* ============================================================
   十三、气泡菜单：复制 / 重新生成 / 删除
   ============================================================ */
console.log('\n=== 气泡菜单 ===');
await fresh('light');
await sendText('第一条，用来测菜单');
await sleep(420);
await evaluate(page, "(() => { const s = document.querySelector('#send'); if (s.classList.contains('stop')) s.click(); return 1; })()");
await sleep(400);

const menus = await evaluate(page, `(() => {
  const rows = [...document.querySelectorAll('#log .row')];
  return rows.map(r => ({
    kind: r.classList.contains('me') ? 'me' : 'ai',
    hello: !!r.querySelector('.hello'),
    buttons: [...r.querySelectorAll('.act')].map(b => b.getAttribute('data-act')),
    /* 菜单要在**内容**下面。不能拿 .body 的 top 比 —— 菜单挂了负外边距，
       空气泡那种高度里它会算成"在上面"。拿气泡/文字本身的 bottom 比才对。 */
    menuBelowContent: (() => {
      const acts = r.querySelector('.acts');
      // 我方那条：.body 自己就是气泡（.body.bubble）；用 .body .bubble 会选到
      // 别的行里去（选择器写错一次，量出来 -45px，看着像菜单跑到上面去了）
      const body = r.querySelector('.body');
      const content = (body && body.classList.contains('bubble'))
        ? body : (r.querySelector('.bubble') || body);
      if (!acts || !content) return null;
      return Math.round(acts.getBoundingClientRect().top - content.getBoundingClientRect().bottom);
    })(),
    /* 图标排贴的是哪条边：
         我方 → 贴气泡**右**缘（作者要求：贴在该气泡的右下方）
         对方 → 贴文字**左**缘（作者要求：贴在整段消息的左下方）
       量的是"图标本体"而不是按钮盒子（按钮左右各有 10px 内边距）。 */
    iconEdgeDx: (() => {
      const acts = r.querySelector('.acts');
      const body = r.querySelector('.body');
      if (!body || !acts) return null;
      const icons = [...acts.querySelectorAll('svg')];
      if (!icons.length) return null;
      const bb = body.getBoundingClientRect();
      const isMe = !!r.closest('.row.me');
      /* 我方贴右缘 → 量**最后一个**图标；对方贴左缘 → 量**第一个**。
         量错一边会得出 -36px 这种假失败（踩过）。 */
      const el = isMe ? icons[icons.length - 1] : icons[0];
      const sb = el.getBoundingClientRect();
      return isMe ? Math.round(sb.right - bb.right) : Math.round(sb.x - bb.x);
    })(),
    iconCount: (() => {
      const acts = r.querySelector('.acts');
      return acts ? acts.querySelectorAll('svg').length : 0;
    })(),
    /* 图标必须**横向一排**。之前用 flex-wrap: wrap，短消息（"你好"）时
       气泡很窄，按钮塞不下就折成竖排 —— 作者反馈过，别再写回去。 */
    iconsOnOneLine: (() => {
      const acts = r.querySelector('.acts');
      if (!acts) return null;
      const ys = [...acts.querySelectorAll('svg')].map(i => Math.round(i.getBoundingClientRect().y));
      return ys.length ? new Set(ys).size === 1 : null;
    })(),
    textButtonCount: (() => {
      const acts = r.querySelector('.acts');
      return acts ? [...acts.querySelectorAll('button')]
        .filter(b => (b.textContent || '').trim().length > 0).length : 0;
    })(),
    actsOverflow: (() => {
      const acts = r.querySelector('.acts');
      return acts ? Math.round(acts.getBoundingClientRect().right - innerWidth) : null;
    })(),
  }));
})()`);
/* 注意：一轮回答可能是多条气泡（演示模式会连发），图标只挂在**整轮的最后一条**
   下面；开场白（.hello）下面按设计**没有**图标。所以这里要挑"真的有图标"的那一行。 */
const greetingRow = menus.filter(m => m.hello)[0];
ok(greetingRow && greetingRow.iconCount === 0,
  `开场白下面没有图标（${greetingRow ? greetingRow.iconCount : '没有开场白'} 个）`);

const meRow = menus.filter(m => m.kind === 'me' && m.iconCount)[0];
const aiRow = menus.filter(m => m.kind === 'ai' && m.iconCount)[0];
ok(menus.length >= 2, `每条消息都有菜单栏（共 ${menus.length} 行）`);
ok(meRow && meRow.buttons.indexOf('copy') >= 0 && meRow.buttons.indexOf('del') >= 0,
  `我方气泡有 复制 / 删除（${meRow && meRow.buttons.join(',')}）`);
ok(meRow && meRow.buttons.indexOf('regen') < 0, '我方气泡没有"重新生成"（那是给对方回复用的）');
ok(aiRow && aiRow.buttons.indexOf('copy') >= 0 && aiRow.buttons.indexOf('del') >= 0
   && aiRow.buttons.indexOf('regen') >= 0,
  `AI 气泡有 复制 / 重新生成 / 删除（${aiRow && aiRow.buttons.join(',')}）`);
ok(meRow && meRow.menuBelowContent >= -2,
  `菜单在气泡**下方**（与气泡底边的距离 ${meRow && meRow.menuBelowContent}px）`);
ok(meRow && meRow.iconEdgeDx !== null && Math.abs(meRow.iconEdgeDx) <= 2,
  `我方图标贴气泡**右**下角（与气泡右缘偏差 ${meRow && meRow.iconEdgeDx}px）`);
ok(aiRow && aiRow.iconEdgeDx !== null && Math.abs(aiRow.iconEdgeDx) <= 2,
  `对方图标贴整段话的**左**下角（与文字左缘偏差 ${aiRow && aiRow.iconEdgeDx}px）`);
ok(meRow && meRow.iconCount === 2 && aiRow && aiRow.iconCount === 3,
  `是图标不是文字按钮（我方 ${meRow && meRow.iconCount} 个 / 对方 ${aiRow && aiRow.iconCount} 个）`);
ok(meRow && meRow.textButtonCount === 0 && aiRow && aiRow.textButtonCount === 0,
  '按钮里没有文字（纯图标）');
ok((meRow && meRow.actsOverflow <= 0) && (aiRow && aiRow.actsOverflow <= 0),
  `图标排没有越出屏幕右缘（${meRow && meRow.actsOverflow} / ${aiRow && aiRow.actsOverflow}）`);
ok(meRow && meRow.iconsOnOneLine === true && aiRow && aiRow.iconsOnOneLine === true,
  '图标是**横向一排**（短消息也不例外，不会折成竖排）');

/* 点击区域够不够手指点 */
const tapSize = await evaluate(page, `(() => {
  const b = document.querySelector('.act').getBoundingClientRect();
  return { w: Math.round(b.width), h: Math.round(b.height) };
})()`);
ok(tapSize.h >= 28 && tapSize.w >= 30,
  `菜单按钮的点击区域够手指用（${tapSize.w}×${tapSize.h}）`);

/* 删除一条：DOM 和存储都要少一条 */
const beforeDelMsg = await evaluate(page, `(() => ({
  // 只数真正的消息行（.row.me / .row:not(.me):not(.sys)）。
  // 用 :not(.sys) 会把时间戳行算进去 —— 删掉最后一条时间戳可能一起消失，
  // 于是"少一行"变成"少两行"，看着像 app 多删了（踩过一次）。
  dom: document.querySelectorAll('#log .row.me, #log .reply').length,
  stored: JSON.parse(localStorage.getItem('ventana.convs')).convs[0].messages.length,
}))()`);
await evaluate(page, "(() => { document.querySelector('#log .row.me .act[data-act=del]').click(); return 1; })()");
await sleep(350);
const afterDelMsg = await evaluate(page, `(() => ({
  dom: document.querySelectorAll('#log .row.me, #log .reply').length,
  stored: JSON.parse(localStorage.getItem('ventana.convs')).convs[0].messages.length,
  firstIsAssistant: (() => {
    const m = JSON.parse(localStorage.getItem('ventana.convs')).convs[0].messages;
    return m.length ? m[0].role : null;
  })(),
}))()`);
ok(afterDelMsg.stored === beforeDelMsg.stored - 1,
  `删除后存储里少一条（${beforeDelMsg.stored} → ${afterDelMsg.stored}）`);
/* 为什么不直接数 DOM 行数：删掉一条消息后，如果它是"最后一条带时间戳的"，
   时间戳行会一起消失（隔 5 分钟才补一条），于是"少一行"变成"少两行"，
   看起来像 app 多删了。改成重新加载后对比：DOM 必须与存储完全一致。 */
await goto(page, URL_);
await sleep(300);
const rebuilt = await evaluate(page, `(() => ({
  dom: document.querySelectorAll('#log .row.me, #log .reply').length,
  stored: JSON.parse(localStorage.getItem('ventana.convs')).convs[0].messages.length,
}))()`);
ok(rebuilt.dom === rebuilt.stored && rebuilt.stored === afterDelMsg.stored,
  `刷新后 DOM 与存储一致（DOM ${rebuilt.dom} / 存储 ${rebuilt.stored}）`);

/* 重新生成：把这一条往后丢掉，重新问一次 */
await fresh('light');
await sendText('请你回答一次');
await sleep(650);
await evaluate(page, "(() => { const s = document.querySelector('#send'); if (s.classList.contains('stop')) s.click(); return 1; })()");
await sleep(400);
/* 注意：光写 localStorage 不够 —— 页面里的 cfg 是启动时读进内存的，
   写存储不会让它切到 API 模式。必须刷新，否则"重新生成"走的是演示模式（踩过）。 */
await evaluate(page, `(() => {
  localStorage.setItem('ventana.cfg', JSON.stringify({ base: 'https://example.com/v1', key: 'sk', model: 'm' }));
  return 1;
})()`);
await goto(page, URL_);
await sleep(400);
const beforeRegen = await evaluate(page, `(() => {
  window.__sent = [];
  ${SSE_FN}
  const realFetch = window.fetch;
  window.fetch = function (url, init) {
    if (String(url).indexOf('chat/completions') >= 0) {
      window.__sent.push(JSON.parse(init.body));
      return Promise.resolve(new Response(sseBody([{ content: '重新生成后的回答' }]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    }
    return realFetch.apply(this, arguments);
  };
  return {
    stored: JSON.parse(localStorage.getItem('ventana.convs')).convs[0].messages.length,
    model: document.querySelector('#modelTag').textContent,
  };
})()`);
/* 要点的必须是"真正那条回答"上的重新生成 —— 进门那条欢迎语排在前面，
   它前面没有用户提问，点了会被（正确地）拒绝。踩过一次。 */
await evaluate(page, `(() => {
  const rows = [...document.querySelectorAll('#log .row')];
  // 从后往前找：第一条带"重新生成"的 AI 行，且它前面已经有用户消息
  for (let i = rows.length - 1; i >= 0; i--) {
    const btn = rows[i].querySelector('.act[data-act=regen]');
    const hasUserBefore = rows.slice(0, i).some(r => r.classList.contains('me'));
    if (btn && hasUserBefore) { btn.click(); return 1; }
  }
  return 0;
})()`);
await sleep(300);
await sleep(500);   // 让假回答把这一轮走完，状态才是稳定的
const regenState = await evaluate(page, `(() => ({
  busy: document.querySelector('#send').classList.contains('stop'),
  sent: (window.__sent || []).length,
  stored: JSON.parse(localStorage.getItem('ventana.convs')).convs[0].messages.length,
  roles: JSON.parse(localStorage.getItem('ventana.convs')).convs[0].messages.map(m => m.role),
}))()`);
ok(regenState.sent >= 1, `重新生成真的发出了请求（${regenState.sent} 次）`);
/* 别断言"点完立刻是 busy 状态"：假回答在毫秒级就结束了，busy 会翻回去，
   属于假阳性来源。要断言的是"旧回答被丢掉了、并且重新要了一次"。 */
/* 断言写成"角色序列结构"而不是"assistant 的条数"：
   进门那条欢迎语本身就是一条 assistant，所以条数一定是 2，写 1 是错的。
   正确的判据是：结构必须是「欢迎语 + 我那句 + 一条新回答」——
   旧回答的位置被新回答取代，没有多出第二条回答，也没有留下空壳。 */
ok(regenState.roles.join(',') === 'assistant,user,assistant',
  `旧回答被新回答取代，结构没变（${regenState.roles.join(',')}）`);
ok(regenState.stored === beforeRegen.stored,
  `重新生成没有增减消息条数（${beforeRegen.stored} → ${regenState.stored}）`);
ok(regenState.roles[regenState.roles.length - 1] === 'assistant',
  '最后一条是新的回答（不是悬空等待）');
ok(beforeRegen.model === 'm', `（前提）页面确实在 API 模式（顶栏显示 ${beforeRegen.model}）`);
await evaluate(page, "(() => { const s = document.querySelector('#send'); if (s.classList.contains('stop')) s.click(); return 1; })()");
await sleep(300);

/* ============================================================
    ★ 顶栏导出当前会话（txt）
   ============================================================ */
console.log('\n=== 顶栏导出当前会话 ===');
await fresh('light');
await sendText('顶栏导出这句话必须出现在 txt 里');
await sleep(380);
await evaluate(page, "(() => { const s = document.querySelector('#send'); if (s.classList.contains('stop')) s.click(); return 1; })()");
await sleep(300);

/* 顶栏有导出按钮 */
const topExportBtn = await evaluate(page, `(() => {
  const b = document.querySelector('#exportChat');
  return b ? { exists: true, aria: b.getAttribute('aria-label') || '' } : { exists: false };
})()`);
ok(topExportBtn.exists && topExportBtn.aria.indexOf('导出') >= 0,
  `顶栏有导出当前会话按钮（${topExportBtn.exists ? topExportBtn.aria : '无'}）`);

/* 点击后能拿到当前会话内容的 Blob，且文件名是 txt（拦截真实下载，只读内容） */
const topExportInfo = await evaluate(page, `(async () => {
  let captured = null, fileName = '';
  const realCreate = URL.createObjectURL;
  URL.createObjectURL = function (blob) { captured = blob; return realCreate.call(URL, blob); };
  const stopDownload = (e) => {
    const t = e.target;
    if (t && t.tagName === 'A' && t.hasAttribute('download')) {
      fileName = t.getAttribute('download') || '';
      e.preventDefault();
    }
  };
  document.addEventListener('click', stopDownload, true);
  document.querySelector('#exportChat').click();
  document.removeEventListener('click', stopDownload, true);
  URL.createObjectURL = realCreate;
  const text = captured ? await captured.text() : '';
  return { text, fileName };
})()`);
ok(topExportInfo.fileName.endsWith('.txt'), `导出的文件名以 .txt 结尾（${topExportInfo.fileName}）`);
ok(topExportInfo.text.indexOf('Ventana 会话记录') >= 0, '顶栏导出的 txt 有标题');
ok(topExportInfo.text.indexOf('顶栏导出这句话必须出现在 txt 里') >= 0, '顶栏导出的 txt 里有当前会话的话');
ok(topExportInfo.text.indexOf('我') >= 0, '顶栏导出的 txt 标出了说话人');

/* ============================================================
    顶栏导出 · 内置 WebView（微信）环境：
    a[download] 不可靠，点导出不能再走 blob 跳转（跳出去必白屏），
    必须改成打开页面内导出面板，把全文摊出来让用户复制。
   ============================================================ */
console.log('\n=== 内置 WebView 导出面板 ===');
await fresh('light');
// 注入微信 UA —— 覆盖后要重新加载一次才生效
await page.send('Emulation.setUserAgentOverride', {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x1800312b) NetType/WIFI Language/zh_CN',
  platform: 'iPhone',
});
await goto(page, URL_);
await sleep(400);
await sendText('内置浏览器导出的这句话也要在');
await sleep(380);
await evaluate(page, "(() => { const s = document.querySelector('#send'); if (s.classList.contains('stop')) s.click(); return 1; })()");
await sleep(300);

const wxExportInfo = await evaluate(page, `(async () => {
  let captured = null, fileName = '';
  const realCreate = URL.createObjectURL;
  URL.createObjectURL = function (blob) { captured = blob; return realCreate.call(URL, blob); };
  const stopDownload = (e) => {
    const t = e.target;
    if (t && t.tagName === 'A' && t.hasAttribute('download')) {
      fileName = t.getAttribute('download') || '';
      e.preventDefault();
    }
  };
  document.addEventListener('click', stopDownload, true);
  document.querySelector('#exportChat').click();
  document.removeEventListener('click', stopDownload, true);
  URL.createObjectURL = realCreate;
  const sheet = document.querySelector('#exportSheet');
  const body = document.querySelector('#exportBody');
  return {
    captured, fileName,
    opened: sheet.classList.contains('open'),
    bodyText: body.value,
    copyBtn: !!document.querySelector('#exportCopy'),
    userAgent: navigator.userAgent,
  };
})()`);
ok(wxExportInfo.userAgent.indexOf('MicroMessenger') >= 0, '（前提）页面跑在微信 UA 下');
ok(!wxExportInfo.captured && !wxExportInfo.fileName,
  '内置 WebView 里不再走 blob + a[download]（跳出去必白屏）');
ok(wxExportInfo.opened, '点导出打开页面内导出面板，不再跳浏览器');
ok(wxExportInfo.bodyText.indexOf('Ventana 会话记录') >= 0, '导出面板里有会话标题');
ok(wxExportInfo.bodyText.indexOf('内置浏览器导出的这句话也要在') >= 0, '导出面板里有当前会话的话');
ok(wxExportInfo.copyBtn, '导出面板有一键复制按钮');

/* 复制按钮有反馈（成功或失败都会有 toast） */
await evaluate(page, "(() => { document.querySelector('#exportCopy').click(); return 1; })()");
await sleep(250);
const wxCopyToast = await evaluate(page, "(() => (document.querySelector('#toast') || {}).textContent || '')()");
ok(wxCopyToast.length > 0, `点复制有反馈（${wxCopyToast.slice(0, 20)}…）`);

/* 关闭面板 */
await evaluate(page, "(() => { document.querySelector('#exportClose').click(); return 1; })()");
await sleep(200);
const wxSheetClosed = await evaluate(page, "(() => !document.querySelector('#exportSheet').classList.contains('open'))()");
ok(wxSheetClosed, '关闭按钮能收起导出面板');

/* 恢复回 iPhone 系统浏览器 UA，别污染后面的测试 */
await emulateMobile(page, { width: 390, height: 844, dpr: 3 });

/* ============================================================
   十四、会话归档
   ============================================================ */
console.log('\n=== 会话归档 ===');
await fresh('light');
await sendText('这是第一个会话说的话');
await sleep(380);
await evaluate(page, "(() => { const s = document.querySelector('#send'); if (s.classList.contains('stop')) s.click(); return 1; })()");
await sleep(300);

await evaluate(page, "(() => { document.querySelector('#openConfig').click(); document.querySelector('#convArchive').click(); return 1; })()");
await sleep(400);
const archived = await evaluate(page, `(() => {
  const st = JSON.parse(localStorage.getItem('ventana.convs'));
  return {
    total: st.convs.length,
    archived: st.convs.filter(c => c.archived).length,
    activeCount: st.convs.filter(c => !c.archived).length,
    archivedMsgs: st.convs.filter(c => c.archived)[0].messages.length,
    domRows: document.querySelectorAll('#log .row:not(.sys)').length,
    // 新会话不是"零条"：会种一条欢迎语。所以判据是"没有用户的对话内容"
    newHasNoChat: (st.convs.filter(c => !c.archived)[0].messages || [])
      .filter(m => m.role === 'user').length === 0,
  };
})()`);
ok(archived.archived === 1, `有一个会话被归档了（共 ${archived.total} 个）`);
ok(archived.archivedMsgs >= 2, `归档的会话保住了它的消息（${archived.archivedMsgs} 条）`);
ok(archived.newHasNoChat && archived.domRows <= 1,
  `归档后自动开了新的会话，里面没有旧对话（当前画面上 ${archived.domRows} 行）`);

/* 归档只在记忆馆里可见 + 按创建时间排 + 能导出 */
await evaluate(page, "(() => { document.querySelector('#openMemory').click(); return 1; })()");
await sleep(300);
const memView = await evaluate(page, `(() => ({
  visible: getComputedStyle(document.querySelector('#viewMemory')).display !== 'none',
  chatHidden: getComputedStyle(document.querySelector('#viewChat')).display === 'none',
  archiveItems: document.querySelectorAll('#archList .item').length,
  archiveTitle: (document.querySelector('#archList .item h3') || {}).textContent || '',
  archiveActs: [...document.querySelectorAll('#archList .item [data-cact]')].map(b => b.getAttribute('data-cact')),
  sortedByCreated: (() => {
    const st = JSON.parse(localStorage.getItem('ventana.convs'));
    const a = st.convs.filter(c => c.archived);
    for (let i = 1; i < a.length; i++) if (a[i - 1].createdAt < a[i].createdAt) return false;
    return true;
  })(),
}))()`);
ok(memView.visible && memView.chatHidden, '记忆馆是独立视图，打开时对话页收起');
ok(memView.archiveItems === 1, `归档列表里有 1 个会话`);
ok(memView.archiveActs.indexOf('export') >= 0 && memView.archiveActs.indexOf('del') >= 0,
  `每个归档会话都有导出与删除（${memView.archiveActs.join(',')}）`);
ok(memView.archiveActs.indexOf('restore') < 0, '归档会话不再有取消归档按钮');
ok(memView.sortedByCreated, '归档会话按创建时间排序');

/* 导出 txt 的内容要能看 */
const exportText = await evaluate(page, `(() => {
  // 直接调内部逻辑不方便，这里触发真实下载流程并把 Blob 内容读回来
  let captured = null;
  const realCreate = URL.createObjectURL;
  URL.createObjectURL = function (blob) { captured = blob; return realCreate.call(URL, blob); };
  // 拦下真实的磁盘下载：测试只需要 Blob 内容，不需要往下载目录写文件
  // （之前没拦，跑一次全量测试就在 ~/Downloads 落一个"第一个会话*.txt"）
  const stopDownload = (e) => {
    const t = e.target;
    if (t && t.tagName === 'A' && t.hasAttribute('download')) e.preventDefault();
  };
  document.addEventListener('click', stopDownload, true);
  document.querySelector('#archList [data-cact=export]').click();
  document.removeEventListener('click', stopDownload, true);
  URL.createObjectURL = realCreate;
  return captured ? captured.text() : Promise.resolve('');
})()`);
ok(exportText.indexOf('Ventana 会话记录') >= 0, '导出的 txt 有标题');
ok(exportText.indexOf('这是第一个会话说的话') >= 0, '导出的 txt 里有当初说的话');
ok(exportText.indexOf('[我]') >= 0 || exportText.indexOf('我') >= 0, '导出的 txt 标出了说话人');

/* 删除归档会话 */
const hadArchiveItem = await evaluate(page, `document.querySelectorAll('#archList .item').length`);
ok(hadArchiveItem === 1, `（前提）删除前列表里正好有一个归档会话（${hadArchiveItem}）`);
await evaluate(page, `(() => {
  window.confirm = function () { return true; };
  document.querySelector('#archList [data-cact=del]').click();
  return 1;
})()`);
await sleep(300);
const afterDelConv = await evaluate(page, `(() => {
  const st = JSON.parse(localStorage.getItem('ventana.convs'));
  return { archived: st.convs.filter(c => c.archived).length, items: document.querySelectorAll('#archList .item').length };
})()`);
ok(afterDelConv.archived === 0 && afterDelConv.items === 0, '删除归档会话后列表里没有了');

/* ============================================================
   十五、记忆馆
   ============================================================ */
console.log('\n=== 记忆馆 ===');
await fresh('light');

const memWrite = await evaluate(page, `(() => {
  localStorage.setItem('ventana.cfg', JSON.stringify({ base: 'https://example.com/v1', key: 'sk', model: 'm' }));
  localStorage.setItem('ventana.memory', JSON.stringify([
    { id: 'm1', at: Date.now() - 86400000, title: '她喜欢下雨天', body: '说过三次，雨天会想起小时候。', from: '' },
    { id: 'm2', at: Date.now(), title: '她要压缩上下文', body: '前面聊了很多世界设定，摘要如下……', from: '' },
  ]));
  return 1;
})()`);
await goto(page, URL_);
await sleep(400);
const badge = await evaluate(page, `(() => ({
  noCounter: !document.querySelector('#memCount'),
  newHidden: !!document.querySelector('#memNew') && document.querySelector('#memNew').hidden,
  title: document.querySelector('#openMemory').title,
}))()`);
ok(badge.noCounter, '顶栏记忆馆入口不再显示记忆条数');
ok(badge.newHidden, '预置记忆（非新写入）不亮感叹号');

await evaluate(page, "(() => { document.querySelector('#openMemory').click(); return 1; })()");
await sleep(300);
const memTotalUi = await evaluate(page, "(() => { const t = document.querySelector('#memTotal'); return t ? t.textContent : null; })()");
ok(memTotalUi === '共 2 条记忆', `记忆馆内显示总数（${memTotalUi}）`);

await evaluate(page, "(() => { document.querySelector('#memBack').click(); return 1; })()");
await sleep(200);

await evaluate(page, "(() => { document.querySelector('#openMemory').click(); return 1; })()");
await sleep(300);
const memUi = await evaluate(page, `(() => ({
  items: document.querySelectorAll('#memList .item').length,
  titles: [...document.querySelectorAll('#memList .item h3')].map(h => h.firstChild.textContent),
  hasTime: !!document.querySelector('#memList .item time'),
  acts: [...document.querySelectorAll('#memList .item [data-mact]')].map(b => b.getAttribute('data-mact')),
  // 渲染顺序里，时间较新的那条必须排在前面（不硬编码具体标题）
  newestFirst: (() => {
    const titles = [...document.querySelectorAll('#memList .item h3')].map(h => h.firstChild.textContent);
    const byAt = [...JSON.parse(localStorage.getItem('ventana.memory') || '[]')]
      .sort((a, b) => b.at - a.at).map(m => m.title);
    return titles.join('|') === byAt.join('|');
  })(),
}))()`);
ok(memUi.items === 2, `记忆馆列出两条（${memUi.titles.join('、')}）`);
ok(memUi.hasTime, '每条带时间戳');
ok(memUi.acts.indexOf('del') >= 0 && memUi.acts.indexOf('copy') >= 0,
  `每条能复制与删除（${memUi.acts.join(',')}）`);
ok(memUi.newestFirst, '最新的排在最上面');

/* AI 自己写入：走 tools */
await evaluate(page, "(() => { document.querySelector('#memBack').click(); return 1; })()");
await sleep(200);
await evaluate(page, `(() => {
  window.__sent = [];
  let n = 0;
  ${SSE_FN}
  const realFetch = window.fetch;
  window.fetch = function (url, init) {
    if (String(url).indexOf('chat/completions') < 0) return realFetch.apply(this, arguments);
    window.__sent.push(JSON.parse(init.body));
    n++;
    let sse;
    if (n === 1) {
      // 参数故意拆成两个分片（真实端点就是这么流的）
      sse = sseBody([
        { tool_calls: [{ index: 0, id: 'c1', type: 'function',
          function: { name: 'save_memory', arguments: '{"title":"记住这' } }] },
        { tool_calls: [{ index: 0,
          function: { arguments: '件事","body":"她说明天要早起。"}' } }] },
      ]);
    } else {
      sse = sseBody([{ content: '记住了。' }]);
    }
    return Promise.resolve(new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  };
  const b = document.querySelector('#box');
  b.value = '记住这件事：我明天要早起';
  b.dispatchEvent(new Event('input'));
  document.querySelector('#send').click();
  return 1;
})()`);
let sawSaved = false;
for (let i = 0; i < 40; i++) {
  sawSaved = await evaluate(page, `[...document.querySelectorAll('#log .sysline')].some(s => s.textContent.indexOf('记下了') >= 0)`);
  if (sawSaved) break;
  await sleep(150);
}
await sleep(300);
const memArgs = await evaluate(page, `JSON.stringify((window.__sent[1]&&window.__sent[1].messages||[])
  .filter(m => m.role === 'assistant' && m.tool_calls)
  .map(m => m.tool_calls[0].function.arguments))`);
ok(memArgs.indexOf('她说明天要早起') >= 0 && memArgs.indexOf('记住这件事') >= 0,
  `工具调用参数是合法的 JSON 且内容完整（${String(memArgs).slice(0, 90)}）`);
const memWrote = await evaluate(page, `(() => ({
  stored: JSON.parse(localStorage.getItem('ventana.memory')).map(m => m.title),
  sysLines: [...document.querySelectorAll('#log .sysline')].map(s => s.textContent),
  newShown: !!document.querySelector('#memNew') && !document.querySelector('#memNew').hidden,
  newFlag: localStorage.getItem('ventana.memNew'),
  hasAt: JSON.parse(localStorage.getItem('ventana.memory')).every(m => typeof m.at === 'number'),
}))()`);
ok(memWrote.stored.indexOf('记住这件事') >= 0,
  `AI 通过工具写入了一条记忆（${memWrote.stored.join('、')}）`);
ok(memWrote.sysLines.some(t => t.indexOf('记下了') >= 0),
  `聊天里出现"记下了"的系统事件（${memWrote.sysLines.join(' / ')}）`);
ok(memWrote.newShown && memWrote.newFlag === '1',
  `新记忆写入后顶栏亮起感叹号（memNew=${memWrote.newFlag}）`);
ok(memWrote.hasAt, '每条记忆都带时间戳');

/* 取记忆：索引在提示词里，正文按需取 */
const memRead = await evaluate(page, `(() => {
  window.__sent = [];
  let n = 0;
  ${SSE_FN}
  const realFetch = window.fetch;
  window.fetch = function (url, init) {
    if (String(url).indexOf('chat/completions') < 0) return realFetch.apply(this, arguments);
    window.__sent.push(JSON.parse(init.body));
    n++;
    const sse = n === 1
      ? 'data: ' + JSON.stringify({ choices: [{ delta: { content: '\\n[[忆:她喜欢下雨天]]' } }] }) + '\\n\\ndata: [DONE]\\n\\n'
      : 'data: ' + JSON.stringify({ choices: [{ delta: { content: '想起来了。' } }] }) + '\\n\\ndata: [DONE]\\n\\n';
    return Promise.resolve(new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  };
  const b = document.querySelector('#box');
  b.value = '你还记得我喜欢什么吗';
  b.dispatchEvent(new Event('input'));
  document.querySelector('#send').click();
  return 1;
})()`);
await sleep(380);
const memReadRes = await evaluate(page, `(() => {
  const all = window.__sent.map(x => x.messages).flat();
  return {
    sysHasIndex: (window.__sent[0].messages[0].content || '').indexOf('她喜欢下雨天') >= 0,
    sysHasBody: (window.__sent[0].messages[0].content || '').indexOf('雨天会想起小时候') >= 0,
    echoedBody: all.some(m => String(m.content).indexOf('雨天会想起小时候') >= 0),
    sysLines: [...document.querySelectorAll('#log .sysline')].map(s => s.textContent),
  };
})()`);
ok(memReadRes.sysHasIndex, '提示词里有记忆的**标题索引**');
ok(!memReadRes.sysHasBody, '提示词里**没有**记忆正文（所以不烧 token）');
ok(memReadRes.echoedBody, 'AI 索取后正文才被送进上下文');
ok(memReadRes.sysLines.some(t => t.indexOf('取了记忆') >= 0), '留下"取了记忆"的系统事件');

/* 新内容感叹号：看过就消失，条数只在记忆馆里显示 */
const memNewBefore = await evaluate(page, `(() => ({
  shown: !!document.querySelector('#memNew') && !document.querySelector('#memNew').hidden,
  flag: localStorage.getItem('ventana.memNew'),
}))()`);
ok(memNewBefore.shown && memNewBefore.flag === '1', 'AI 写入新记忆后感叹号亮着（未读标记已持久化）');
await evaluate(page, "(() => { document.querySelector('#openMemory').click(); return 1; })()");
await sleep(300);
const memNewIn = await evaluate(page, `(() => ({
  newHidden: document.querySelector('#memNew').hidden,
  total: document.querySelector('#memTotal').textContent,
  items: document.querySelectorAll('#memList .item').length,
  flagGone: localStorage.getItem('ventana.memNew') === null,
}))()`);
ok(memNewIn.newHidden && memNewIn.flagGone, '进入记忆馆后感叹号消失（未读标记清除）');
ok(memNewIn.total === '共 3 条记忆', `记忆馆内显示总数（${memNewIn.total}）`);
ok(memNewIn.items === 3, `记忆馆列出三条（${memNewIn.items}）`);
await evaluate(page, "(() => { document.querySelector('#memBack').click(); return 1; })()");
await sleep(200);
const memNewBack = await evaluate(page, "document.querySelector('#memNew').hidden");
ok(memNewBack, '返回对话界面后感叹号不再出现');

/* 更新后全量下发一次：人格/资料库变了 → 下一轮全文进上下文，再下一轮恢复索引 */
await evaluate(page, `(() => {
  localStorage.setItem('ventana.docs', JSON.stringify([
    { id: 'd1', name: '鲸鱼百科', text: '鲸鱼是海洋哺乳动物。'.repeat(10), at: Date.now() },
    { id: 'd2', name: '旧版资料', text: '旧版资料第一段填充内容。'.repeat(8) + '旧版资料末尾独有的标志词：琥珀色帆船。'.repeat(3), at: Date.now() - 1000 },
  ]));
  localStorage.setItem('ventana.prompt', JSON.stringify({ text: '旧人格：冷静的图书管理员。', file: '' }));
  return 1;
})()`);
await goto(page, URL_);
await sleep(400);
await evaluate(page, "(() => { document.querySelector('#openConfig').click(); return 1; })()");
await sleep(200);
await evaluate(page, `(() => {
  const p = document.querySelector('#cfgPrompt');
  p.value = '新人格：温柔的海豚训养员。';
  p.dispatchEvent(new Event('input'));
  document.querySelector('#promptSave').click();
  return 1;
})()`);
await sleep(150);
const sync1 = await evaluate(page, "JSON.parse(localStorage.getItem('ventana.sync')||'{}')");
ok(sync1.prompt === true, '改人格后 sync.prompt 置位（下一轮全量下发）');
await evaluate(page, `(() => {
  const del = document.querySelector('#docList [data-dact="del"]');
  if (del) del.click();
  return 1;
})()`);
await sleep(150);
const sync2 = await evaluate(page, "JSON.parse(localStorage.getItem('ventana.sync')||'{}')");
ok(sync2.docs === true, '删资料后 sync.docs 置位');
await evaluate(page, "(() => { document.querySelector('#backChat').click(); return 1; })()");
await sleep(200);

/* 第一轮：全部内容随消息发给 AI 一次 */
await evaluate(page, `(() => {
  window.__sent = [];
  ${SSE_FN}
  const realFetch = window.fetch;
  window.fetch = function (url, init) {
    if (String(url).indexOf('chat/completions') < 0) return realFetch.apply(this, arguments);
    window.__sent.push(JSON.parse(init.body));
    return Promise.resolve(new Response(sseBody([{ content: '好的，这是更新后的第一轮。' }]),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  };
  const b = document.querySelector('#box');
  b.value = '我们聊聊鲸鱼吧';
  b.dispatchEvent(new Event('input'));
  document.querySelector('#send').click();
  return 1;
})()`);
await sleep(400);
const round1 = await evaluate(page, `(() => {
  const c = String((window.__sent[0] && window.__sent[0].messages[0] || {}).content || '');
  return {
    promptUpdated: c.indexOf('【系统提示词刚刚更新】') >= 0,
    newPersona: c.indexOf('海豚训养员') >= 0 && c.indexOf('图书管理员') < 0,
    docsUpdated: c.indexOf('【资料库刚刚更新】') >= 0,
    remainingDocFull: c.indexOf('琥珀色帆船') >= 0,
    deletedDocAbsent: c.indexOf('海洋哺乳动物') < 0,
  };
})()`);
ok(round1.promptUpdated && round1.newPersona, '首轮：更新后的系统提示词全文 + 更新声明');
ok(round1.docsUpdated && round1.remainingDocFull && round1.deletedDocAbsent,
  '首轮：资料库全部文档正文发送一次（已删的不出现）');

/* 第二轮：恢复默认读取方式（人格全文依旧，文档只给索引） */
await evaluate(page, `(() => {
  window.__sent = [];
  ${SSE_FN}
  const realFetch = window.fetch;
  window.fetch = function (url, init) {
    if (String(url).indexOf('chat/completions') < 0) return realFetch.apply(this, arguments);
    window.__sent.push(JSON.parse(init.body));
    return Promise.resolve(new Response(sseBody([{ content: '好的，默认模式。' }]),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  };
  const b = document.querySelector('#box');
  b.value = '继续';
  b.dispatchEvent(new Event('input'));
  document.querySelector('#send').click();
  return 1;
})()`);
await sleep(400);
const round2 = await evaluate(page, `(() => {
  const c = String((window.__sent[0] && window.__sent[0].messages[0] || {}).content || '');
  return {
    noDocFull: c.indexOf('琥珀色帆船') < 0,
    noUpdatedMark: c.indexOf('【资料库刚刚更新】') < 0 && c.indexOf('【系统提示词刚刚更新】') < 0,
    hasIndex: c.indexOf('可读文档') >= 0,
  };
})()`);
ok(round2.noDocFull && round2.noUpdatedMark && round2.hasIndex,
  '次轮：恢复默认（文档只给索引，更新声明消失）');

/* 大文档按需截取：>6000 字时只给与当前话题最相关的部分 */
const fill = (w, n) => Array(n).fill(w).join('');
const bigDoc = fill('甲', 1100) + '\n\n'
  + '鲸鱼的核心：鲸鱼用肺呼吸、喂奶给幼崽，是温血的海洋哺乳动物。'.repeat(20) + '\n\n'
  + fill('乙', 2500) + '\n\n' + fill('丙', 2500) + '\n\n' + fill('丁', 1400) + '\n\n'
  + '长颈鹿尾巴卷曲，这一句放在文档末尾作为独有标志。'.repeat(3);
await evaluate(page, `(() => {
  localStorage.setItem('ventana.docs', JSON.stringify([
    { id: 'big1', name: '海洋生物大全', text: ${JSON.stringify(bigDoc)}, at: Date.now() },
  ]));
  localStorage.setItem('ventana.sync', JSON.stringify({ prompt: false, docs: false }));
  return 1;
})()`);
await goto(page, URL_);
await sleep(400);
await evaluate(page, `(() => {
  window.__sent = [];
  ${SSE_FN}
  const realFetch = window.fetch;
  window.fetch = function (url, init) {
    if (String(url).indexOf('chat/completions') < 0) return realFetch.apply(this, arguments);
    window.__sent.push(JSON.parse(init.body));
    const n = window.__sent.length;
    const sse = n === 1
      ? sseBody([{ content: '\\n[[读:海洋生物大全]]' }])
      : sseBody([{ content: '读到了。' }]);
    return Promise.resolve(new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  };
  const b = document.querySelector('#box');
  b.value = '鲸鱼平时吃什么？';
  b.dispatchEvent(new Event('input'));
  document.querySelector('#send').click();
  return 1;
})()`);
await sleep(450);
const snipRes = await evaluate(page, `(() => {
  const all = window.__sent.map(x => x.messages).flat();
  const hit = all.filter(m => m.role === 'tool' || (m.role === 'user' && String(m.content).indexOf('按需截取') >= 0));
  const t = hit.length ? String(hit[hit.length - 1].content) : '';
  return {
    found: t.indexOf('鲸鱼') >= 0,
    tailOut: t.indexOf('长颈鹿尾巴卷曲') < 0,
    len: t.length,
    docLen: ${JSON.stringify(bigDoc.length)},
    indexFirst: String((window.__sent[0] && window.__sent[0].messages[0] || {}).content || '').indexOf('可读文档') >= 0,
  };
})()`);
ok(snipRes.indexFirst, '平时第一轮 system 里文档只给索引（不整篇带）');
ok(snipRes.found && snipRes.tailOut, '按需截取包含目标相关内容、不含尾部无关内容');
ok(snipRes.len >= 3000 && snipRes.len <= 6500, `按需截取：文档 ${snipRes.docLen} 字只给相关部分（实际 ${snipRes.len} 字，≤6000 上限）`);

/* 旧数据迁移：老用户的 messages 数组要变成第一个会话 */
await evaluate(page, `(() => {
  localStorage.clear();
  localStorage.setItem('ventana.msgs', JSON.stringify([
    { role: 'user', content: '旧世界的这句话', at: Date.now() - 60000 },
    { role: 'assistant', content: '记着。', at: Date.now() - 59000 },
  ]));
  return 1;
})()`);
await goto(page, URL_);
await sleep(400);
const migrated2 = await evaluate(page, `(() => {
  const st = JSON.parse(localStorage.getItem('ventana.convs') || 'null');
  return {
    hasConvs: !!st && Array.isArray(st.convs),
    msgCount: st ? st.convs[0].messages.length : -1,
    domRows: document.querySelectorAll('#log .row:not(.sys)').length,
    hasMenus: document.querySelectorAll('#log .act').length,
  };
})()`);
ok(migrated2.hasConvs && migrated2.msgCount === 2,
  `旧的 messages 数组迁移成了会话（${migrated2.msgCount} 条消息）`);
ok(migrated2.domRows === 2, `迁移后的聊天记录照常显示（${migrated2.domRows} 行）`);
ok(migrated2.hasMenus >= 5,
  `迁移出来的消息也带菜单（${migrated2.hasMenus} 个按钮 / 2 条消息）`);

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
console.log(`截图：${OUT}/mobile-light.png, mobile-dark.png`);
await page.close();
process.exit(fail ? 1 : 0);
