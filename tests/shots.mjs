/**
 * shots.mjs —— 逐状态截图（移动端 390×844，日间 + 夜间）
 *
 * 用途：改动界面后留一组"看见过"的凭据，也方便人手核对。
 * 截图不替代断言 —— 断言在 mobile.mjs 里；这里只负责把画面留下来。
 *
 * 用法：node ventana/tests/shots.mjs [输出目录]     默认 /tmp/ventana-shots
 */
import { connect, emulateMobile, setColorScheme, goto, evaluate, screenshot, sleep } from './cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';

const URL_ = process.env.CHAMBRE_URL || 'http://127.0.0.1:5210/index.html';
const OUT = process.argv[2] || '/tmp/ventana-shots';
fs.mkdirSync(OUT, { recursive: true });

const page = await connect();
await page.send('Runtime.enable');
await page.send('Page.enable');
await emulateMobile(page, { width: 390, height: 844, dpr: 3 });

const shot = async (name) => {
  const file = path.join(OUT, name + '.png');
  await screenshot(page, file);
  console.log('  · ' + path.relative(process.cwd(), file));
};

async function fresh(scheme) {
  await setColorScheme(page, scheme);
  await goto(page, URL_);
  await evaluate(page, '(() => { try { localStorage.clear(); } catch (e) {} return 1; })()');
  await goto(page, URL_);
}

for (const scheme of ['light', 'dark']) {
  const tag = scheme === 'light' ? '日间' : '夜间';
  console.log(`\n${tag}：`);
  await fresh(scheme);
  await shot(`01-${scheme}-首次打开`);

  await evaluate(page, `(() => {
    const b = document.querySelector('#box');
    b.value = '在吗？我到家了。';
    b.dispatchEvent(new Event('input'));
    document.querySelector('#send').click();
    return 1;
  })()`);
  await sleep(220);                       // 正在输入 / 刚开始吐字
  await shot(`02-${scheme}-正在输入`);
  await sleep(1400);                      // 多条连发中
  await shot(`03-${scheme}-连发中`);
  await sleep(2600);                      // 说完了
  await shot(`04-${scheme}-说完`);

  // 长消息 / 换行 / 代码块 的表现
  await evaluate(page, `(() => {
    const b = document.querySelector('#box');
    b.value = '换行第一行\\n第二行\\n\\n还有一段空的\\n' + '很长的一句话'.repeat(8) + '\\n\\n\`\`\`js\\nconst a = 1;\\nconsole.log(a)\\n\`\`\`';
    b.dispatchEvent(new Event('input'));
    document.querySelector('#send').click();
    return 1;
  })()`);
  await sleep(900);
  await evaluate(page, "(() => { const s = document.querySelector('#send'); if (s.classList.contains('stop')) s.click(); return 1; })()");
  await sleep(400);
  await shot(`05-${scheme}-长文本与代码块`);

  // 连接设置页（含系统提示词、资料库、会话三块）
  await evaluate(page, "(() => { document.querySelector('#openConfig').click(); return 1; })()");
  await sleep(250);
  await shot(`06-${scheme}-连接设置`);
  await evaluate(page, "(() => { document.querySelector('#backChat').click(); return 1; })()");
  await sleep(150);

  // 记忆馆（先塞两条记忆和一段归档会话，否则是空态）
  await evaluate(page, `(() => {
    const now = Date.now();
    localStorage.setItem('ventana.memory', JSON.stringify([
      { id: 'm1', at: now - 86400000, title: '她喜欢下雨天', body: '说过三次，雨天会想起小时候。', from: '' },
      { id: 'm2', at: now, title: '聊过世界设定', body: '前面聊了很多设定，摘要：……', from: '' },
    ]));
    const st = JSON.parse(localStorage.getItem('ventana.convs') || '{"convs":[],"activeId":null}');
    st.convs.push({ id: 'old1', title: '上周那次长谈', createdAt: now - 7 * 86400000,
      updatedAt: now - 7 * 86400000, archived: true,
      messages: [
        { role: 'user', content: '我们聊了很久', at: now - 7 * 86400000 },
        { role: 'assistant', content: '嗯，我记着。', at: now - 7 * 86400000 + 1000 },
      ] });
    localStorage.setItem('ventana.convs', JSON.stringify(st));
    return 1;
  })()`);
  await goto(page, URL_);
  await sleep(300);
  await evaluate(page, "(() => { document.querySelector('#openMemory').click(); return 1; })()");
  await sleep(300);
  await shot(`09-${scheme}-记忆馆`);
  await evaluate(page, "(() => { document.querySelector('#memBack').click(); return 1; })()");
  await sleep(200);

  // 键盘弹起后（用缩小视口模拟）
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 420, deviceScaleFactor: 3, mobile: true,
    screenWidth: 390, screenHeight: 844,
  });
  await sleep(300);
  await shot(`07-${scheme}-键盘弹起后`);
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    screenWidth: 390, screenHeight: 844,
  });
  await sleep(200);
}

// 桌面宽度也看一眼（当前只有移动断点，留个对照）
await setColorScheme(page, 'light');
await page.send('Emulation.setDeviceMetricsOverride', {
  width: 1280, height: 800, deviceScaleFactor: 2, mobile: false,
});
await goto(page, URL_);
await sleep(300);
console.log('\n桌面 1280×800（仅供参考，未做桌面适配）：');
await shot('08-桌面参考');

console.log(`\n截图目录：${OUT}`);
await page.close();
process.exit(0);
