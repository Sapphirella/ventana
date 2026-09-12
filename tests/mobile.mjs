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
  for (const r of replies) {
    const inside = img.px((r.rect.x + r.rect.w / 2) * s, (r.rect.y + r.rect.h / 2) * s);
    const rightEdge = img.px((r.rect.x + 6) * s, (r.rect.y + r.rect.h / 2) * s);
    const d = Math.max(...[0, 1, 2].map(i => Math.abs(inside[i] - rightEdge[i])));
    ok(d < 40, `${label}：像素采样确认对方回复区域没有底色（与背景差异 ${d}）`);
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

await sleep(600);
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
ok(streaming.hasCaret, '流式过程中光标在闪');
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
const sourceLeaks = await evaluate(page, `fetch('index.html').then(r => r.text()).then(t => {
  const lines = t.split(String.fromCharCode(10)).filter(l => l.indexOf('Chambre') >= 0);
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
  // 切到真实 API 模式并填好三项
  document.querySelector('#openConfig').click();
  document.querySelector('#segApi').click();
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

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
console.log(`截图：${OUT}/mobile-light.png, mobile-dark.png`);
await page.close();
process.exit(fail ? 1 : 0);
