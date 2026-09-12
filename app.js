  var VERSION = 'v0.7';
  var $ = function (s) { return document.querySelector(s); };
  var logEl = $('#log'), box = $('#box'), sendBtn = $('#send');

  /* ---------- localStorage 键 ----------
     从 Chambre 改名过来的。改名时**不要**把这些键改回旧的，
     也不要删掉下面的 migrateKeys —— 已经配好的 API Key 和聊天记录
     都存在旧键里，改名后如果直接读新键，使用者会看到"设置全没了"。 */
  var K_CFG = 'ventana.cfg';
  var K_MSGS = 'ventana.msgs';        // 旧的"一条 messages 数组"，迁移用
  var K_PROMPT = 'ventana.prompt';
  var K_CONVS = 'ventana.convs';      // 会话表（当前 + 归档）
  var K_DOCS = 'ventana.docs';        // 技能文档库（按需读取，不整段塞提示词）
  var K_MEM = 'ventana.memory';       // 记忆馆条目
  var OLD_KEYS = { 'chambre.cfg': K_CFG, 'chambre.msgs': K_MSGS };
  (function migrateKeys() {
    try {
      Object.keys(OLD_KEYS).forEach(function (old) {
        var v = localStorage.getItem(old);
        if (v !== null && localStorage.getItem(OLD_KEYS[old]) === null) {
          localStorage.setItem(OLD_KEYS[old], v);
        }
      });
    } catch (e) {}   // 无痕模式 / 禁止存储：静默跳过
  })();

  /* ============================================================
     通用小工具
     ============================================================ */
  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return (v === null || v === undefined) ? fallback : v;
    } catch (e) { return fallback; }
  }
  /** 写盘。配额满了会抛 QuotaExceededError —— 必须让调用方知道，不能静默丢数据 */
  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      if (String(e && e.name).indexOf('Quota') >= 0) {
        toast('这台设备的存储满了，刚才的内容没能保存');
      }
      return false;
    }
  }
  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 7);
  }
  function nowMs() { return Date.now(); }

  /* ============================================================
     会话（conversations）
     ------------------------------------------------------------
     存两个集合：活跃的（active）与归档的（archived）。
     归档只是打标记，不移动数据 —— 这样"归档 → 取消归档"是无损的，
     也不用担心迁移时丢东西。
     结构：
       { id, title, createdAt, updatedAt, archived: false, messages: [...] }
     messages 里每条：{ role: 'user'|'assistant', content, at }
     ============================================================ */
  var store = { convs: [], activeId: null };
  var current = null;          // 当前会话对象（引用 store.convs 里的元素）

  function loadStore() {
    var raw = readJSON(K_CONVS, null);
    if (raw && Array.isArray(raw.convs)) {
      store.convs = raw.convs;
      store.activeId = raw.activeId || (raw.convs[0] && raw.convs[0].id) || null;
    } else {
      // 从旧的单数组 messages 迁移第一次
      var legacy = readJSON(K_MSGS, null);
      var conv = {
        id: uid('c'), title: '第一个会话',
        createdAt: firstLegacyAt(legacy), updatedAt: nowMs(),
        archived: false, messages: Array.isArray(legacy) ? legacy.slice() : [],
      };
      store.convs = [conv];
      store.activeId = conv.id;
    }
    // 修复：activeId 指向不存在的会话（或指向已归档的）时，落回一个活跃会话
    current = store.convs.filter(function (c) {
      return c.id === store.activeId && !c.archived;
    })[0] || null;
    if (!current) {
      current = store.convs.filter(function (c) { return !c.archived; })[0] || null;
      if (!current) current = newConv(false);
      store.activeId = current.id;
    }
    saveStore();
  }
  function firstLegacyAt(list) {
    if (Array.isArray(list) && list[0] && list[0].at) return list[0].at;
    return nowMs();
  }
  function saveStore() { writeJSON(K_CONVS, { convs: store.convs, activeId: store.activeId }); }
  function newConv(activate) {
    var c = {
      id: uid('c'), title: '', createdAt: nowMs(), updatedAt: nowMs(),
      archived: false, messages: [],
    };
    store.convs.push(c);
    if (activate) { store.activeId = c.id; current = c; }
    saveStore();
    return c;
  }
  function convTitle(c) {
    if (c.title) return c.title;
    var firstUser = (c.messages || []).filter(function (m) { return m.role === 'user'; })[0];
    if (firstUser) {
      var t = firstUser.content.replace(/\s+/g, ' ').trim();
      return t.length > 18 ? t.slice(0, 18) + '…' : t;
    }
    return '还没有说话 · ' + fmtDay(c.createdAt);
  }
  function activeConvs() {
    return store.convs.filter(function (c) { return !c.archived; })
      .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  }
  function archivedConvs() {
    return store.convs.filter(function (c) { return c.archived; })
      .sort(function (a, b) { return b.createdAt - a.createdAt; });   // 按创建时间
  }

  /* ============================================================
     技能文档库（docs）
     ------------------------------------------------------------
     为什么不能把文档当提示词塞进去：用户上传的文档可能几万字，
     每一轮都整段发出去，token 会烧得很快，而且大多数轮次根本用不到。
     所以：正文只存本地（和聊天记录一样），系统提示词里只放一份**索引**
     （标题 + 开头 60 字），模型需要时用 [[读:标题]] 主动索取。
     ============================================================ */
  var docs = [];
  function loadDocs() { docs = readJSON(K_DOCS, []); if (!Array.isArray(docs)) docs = []; }
  function saveDocs() { return writeJSON(K_DOCS, docs); }
  function findDoc(nameOrId) {
    var q = String(nameOrId || '').trim();
    if (!q) return null;
    var low = q.toLowerCase();
    return docs.filter(function (d) {
      return d.id === q || d.name.toLowerCase() === low;
    })[0] || docs.filter(function (d) {
      // 再宽松一点：包含匹配，取最短的那个（最接近的）
      return d.name.toLowerCase().indexOf(low) >= 0 || low.indexOf(d.name.toLowerCase()) >= 0;
    }).sort(function (a, b) { return a.name.length - b.name.length; })[0] || null;
  }
  function docIndexText() {
    if (!docs.length) return '';
    var lines = docs.map(function (d) {
      var head = (d.text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      return '- 《' + d.name + '》（' + d.text.length + ' 字）：' + head + '…';
    });
    return '【可读文档】你手上还有这些资料，现在只看到索引。'
      + '需要哪一份就在回复里单独写一行 [[读:文档名]]，系统会把全文给你。'
      + '不要凭空猜里面的内容，也不要一次要好几份。\n' + lines.join('\n');
  }

  /* ============================================================
     记忆馆（memory）
     ------------------------------------------------------------
     完全由 AI 按需读写：它想记住什么就写一条，每条带时间戳。
     用户能做的只有"看"和"删"—— 不提供手工新建，避免变成又一个表单。
     结构：{ id, at, title, body, from convId }
     ============================================================ */
  var memories = [];
  function loadMemories() { memories = readJSON(K_MEM, []); if (!Array.isArray(memories)) memories = []; }
  function saveMemories() { return writeJSON(K_MEM, memories); }
  function addMemory(title, body, convId) {
    var item = {
      id: uid('m'), at: nowMs(),
      title: String(title || '').trim().slice(0, 40) || '没标题的一段',
      body: String(body || '').trim(),
      from: convId || (current && current.id) || '',
    };
    memories.push(item);
    memories.sort(function (a, b) { return b.at - a.at; });
    saveMemories();
    return item;
  }
  function memoryIndexText() {
    if (!memories.length) return '';
    var lines = memories.slice(0, 30).map(function (m) {
      return '- [' + fmtDay(m.at) + '] ' + m.title;
    });
    return '【记忆馆】你之前自己记下过这些（只有标题，正文没给你）：\n'
      + lines.join('\n')
      + '\n需要看哪一条就写一行 [[忆:标题]] 取正文。';
  }
  function findMemory(nameOrId) {
    var q = String(nameOrId || '').trim();
    if (!q) return null;
    var low = q.toLowerCase();
    return memories.filter(function (m) {
      return m.id === q || m.title.toLowerCase() === low;
    })[0] || memories.filter(function (m) {
      return m.title.toLowerCase().indexOf(low) >= 0 || low.indexOf(m.title.toLowerCase()) >= 0;
    })[0] || null;
  }

  /* ---------- 配置读写（localStorage 可能被禁/不透明 origin 拒绝，一律 try/catch） ---------- */
  var cfg = loadCfg();
  function loadCfg() {
    var d = { base: '', key: '', model: '', demo: true };
    try {
      var raw = localStorage.getItem(K_CFG);
      if (raw) {
        var c = JSON.parse(raw);
        d.base = c.base || ''; d.key = c.key || ''; d.model = c.model || '';
        d.demo = c.demo !== false;
      }
    } catch (e) {}
    return d;
  }
  function persistCfg() {
    try { localStorage.setItem(K_CFG, JSON.stringify(cfg)); } catch (e) {}
  }

  /* ---------- 系统提示词（人格） ----------
     一个 textarea + 一个文件上传入口。上传就是把文件内容读进 textarea，
     不做"导入成第二条提示词"——多份提示词怎么拼是产品决策，现在只有一份，
     拼错了比不拼更糟。要换性格就整体替换，textarea 里永远就是最终送给模型的那段。
     格式不限（.md / .txt / .json / .yaml 都行）：模型看到的是纯文本，
     所谓 skill.md 只是内容长什么样的约定，不是解析格式。 */
  var persona = { text: '', file: '' };
  function loadPersona() {
    try {
      var raw = localStorage.getItem(K_PROMPT);
      if (raw) {
        var p = JSON.parse(raw);
        persona.text = p.text || '';
        persona.file = p.file || '';
      }
    } catch (e) {}
  }
  function savePersona() {
    try { localStorage.setItem(K_PROMPT, JSON.stringify(persona)); } catch (e) {}
  }

  /* 送给模型的系统消息：留空就完全不加，不塞默认人格。
     （演示模式下不生效——那走的是内置回复。） */
  /* 系统消息 = 人格 + 文档索引 + 记忆索引。
     注意后两者只是**索引**（标题 + 开头几个字），正文要模型自己索取 ——
     这一层就是"不烧 token"的关键：文档再长，每轮的固定开销也只有几行。 */
  function buildMessages(list) {
    var parts = [];
    var sys = (persona.text || '').trim();
    if (sys) parts.push(sys);
    var di = docIndexText();
    if (di) parts.push(di);
    var mi = memoryIndexText();
    if (mi) parts.push(mi);
    if (!parts.length) return list;
    return [{ role: 'system', content: parts.join('\n\n') }].concat(list);
  }

  /* ---------- 消息区 ----------
     结构（和 dwell 参考一致）：
       .row.sys > .sysline            系统事件，居中
       .row     > .body.reply         对方回复：直接落在背景上，不是盒子
       .row.me  > .body.bubble        我方消息：右对齐气泡
     行与行之间由 flex gap 撑开，气泡外的留白归 .row，方便以后加头像。 */
  var busy = false;
  var abortCtrl = null;
  var currentAiEl = null;      // 正在流式接收的那个 DOM 节点
  var currentAiMsg = null;     // 它对应的那条会话记录
  var replyEls = [];           // 本轮回复被拆成的多个气泡
  var cur = null;              // 当前正在吐字的气泡

  /** 当前会话的消息数组。会话切换后指向新数组，所以每次都现取 */
  function msgs() { return (current && current.messages) || []; }
  function saveMsgs() {
    if (!current) return;
    current.updatedAt = nowMs();
    saveStore();
  }
  function clearMsgs() { if (current) current.messages = []; saveMsgs(); }

  /* 时间戳：只在「隔了足够久」或「跨天」时才插一条，不每条都盖个章 */
  var GAP_MS = 5 * 60 * 1000;
  var lastShownAt = 0;
  function fmtTime(ts) {
    var d = new Date(ts), now = new Date();
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    var sameDay = d.toDateString() === now.toDateString();
    var y = new Date(now.getTime() - 86400000);
    if (sameDay) return hm;
    if (d.toDateString() === y.toDateString()) return '昨天 ' + hm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }
  function addStamp(ts, force) {
    if (!force && ts - lastShownAt < GAP_MS) return;
    if (ts - lastShownAt < 1000 && !force) return;
    lastShownAt = ts;
    var s = document.createElement('div');
    s.className = 'tstamp';
    s.textContent = fmtTime(ts);
    logEl.appendChild(s);
  }

  /* 行的结构：
        .row            —— 负责"靠哪边"（我方靠右，对方靠左）
        .row > .col     —— 竖排容器：气泡/文字在上，图标排在下
        .col > .body    —— 气泡（我方）或纯文字（对方）
        .col > .acts    —— 复制 / 重新生成 / 删除 那一排小图标
     .acts 必须是 .col 的子元素而不是 .row 的：.row 是横排 flex，
     把图标当兄弟节点会变成"再开一列"，在窄屏上会被挤成几十像素宽（踩过）。 */
  function makeRow(kind) {
    var row = document.createElement('div');
    row.className = 'row' + (kind === 'me' ? ' me' : kind === 'sys' ? ' sys' : '');
    var col = document.createElement('div');
    col.className = 'col';
    var body = document.createElement('div');
    body.className = 'body ' + (kind === 'me' ? 'bubble' : 'reply');
    col.appendChild(body);
    row.appendChild(col);
    return { row: row, body: body, col: col };
  }

  /* ---------- 每条消息下面的小菜单（复制 / 重新生成 / 删除） ----------
     放在气泡**下面**而不是悬浮在气泡上：
     悬浮按钮在手机上要么挡字，要么得长按才出来，两个都不好用。
     常驻的一行小字更直接 —— 每个都在屏幕上是"能看见就能点"的东西。 */
  /* 图标用内联 SVG（1.7px 描边、24 视框，和顶栏那套一致）。
     用文字按钮的问题是：中文两个字比图标宽一倍多，三个并排就把整行撑得比气泡还长，
     视觉上"挂在气泡右边"—— 用户明确说不要那样。 */
  function actIcon(name) {
    var d = {
      copy: '<rect x="9" y="9" width="12" height="12" rx="2.4"></rect>'
          + '<path d="M6 15H5.5A1.5 1.5 0 0 1 4 13.5v-8A1.5 1.5 0 0 1 5.5 4h8A1.5 1.5 0 0 1 15 5.5V6"></path>',
      regen: '<path d="M20 11a8 8 0 1 0-2.3 5.7"></path><path d="M20 4.5V11h-6.2"></path>',
      del: '<path d="M4 7h16"></path><path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"></path>'
          + '<path d="M6.4 7l.8 12.1A1.5 1.5 0 0 0 8.7 20.5h6.6a1.5 1.5 0 0 0 1.5-1.4L17.6 7"></path>'
          + '<path d="M10.5 11v6"></path><path d="M13.5 11v6"></path>',
    };
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = d[name] || '';
    return svg;
  }

  var ACT_LABEL = { copy: '复制', regen: '重新生成', del: '删除' };

  function actionMenu(kind, msgIndex) {
    var bar = document.createElement('div');
    bar.className = 'acts';
    var acts = ['copy'];
    if (kind !== 'me') acts.push('regen');     // 我方消息没有"重新生成"
    acts.push('del');

    acts.forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'act' + (a === 'del' ? ' danger' : '');
      b.setAttribute('data-act', a);
      b.setAttribute('aria-label', ACT_LABEL[a] + '这条消息');
      b.title = ACT_LABEL[a];
      b.appendChild(actIcon(a));
      bar.appendChild(b);
    });
    bar._msgIndex = msgIndex;
    bar._kind = kind;
    return bar;
  }

  /** 加一条消息。streaming=true 时先挂「正在输入」三点，等首个字到达再换成光标 */
  function addMsg(kind, text, streaming) {
    var r = makeRow(kind);
    logEl.appendChild(r.row);
    if (streaming) {
      var th = document.createElement('div');
      th.className = 'thinking';
      th.innerHTML = '<i></i><i></i><i></i>';
      r.body.appendChild(th);
      r.body._thinking = th;
    } else if (text) {
      r.body.textContent = text;
    }
    return r.body;
  }

  /** 给一条已经落地的消息补上菜单栏（流式结束后调用） */
  function attachActions(body, kind) {
    if (!body || !body.parentNode) return;
    // 幂等：重新渲染（切会话、归档、重新生成）会走同一条路径，
    // 不给判断的话菜单会叠成两层 —— 看起来像"删一次少两行"
    var existing = body.parentNode.querySelector(':scope > .acts');   // .col > .acts
    if (existing) { body._acts = existing; return; }
    var idx = body._msgIndex;
    if (idx === undefined || idx < 0) return;
    var bar = actionMenu(kind, idx);
    body.parentNode.appendChild(bar);
    body._acts = bar;
  }

  /* 整个消息区用一个委托监听，不给每条消息单独挂 handler ——
     消息会被频繁重画（切会话、重新生成），一个个挂容易漏、也容易内存泄漏。 */
  logEl.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('.act') : null;
    if (!btn) return;
    var bar = btn.parentNode;
    var idx = bar._msgIndex;
    var act = btn.getAttribute('data-act');
    if (act === 'copy') doCopy(idx, btn);
    else if (act === 'del') doDelete(idx);
    else if (act === 'regen') doRegen(idx);
  });

  function copyText(t) {
    t = String(t || '');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(t).then(function () { return true; },
        function () { return legacyCopy(t); });
    }
    return Promise.resolve(legacyCopy(t));
  }
  function legacyCopy(t) {
    // 不是所有环境都给 clipboard API（http 非安全上下文、旧 WebView）
    try {
      var ta = document.createElement('textarea');
      ta.value = t;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (e) { return false; }
  }
  function doCopy(idx, btn) {
    var m = msgs()[idx];
    if (!m) return;
    copyText(m.content).then(function (ok) {
      toast(ok ? '已复制' : '这台设备不允许自动复制，长按文字手动选吧');
      if (ok) {
        btn.classList.add('done');
        setTimeout(function () { btn.classList.remove('done'); }, 900);
      }
    });
  }
  function doDelete(idx) {
    if (busy) { toast('等它说完再改'); return; }
    var m = msgs()[idx];
    if (!m) return;
    msgs().splice(idx, 1);
    saveMsgs();
    restoreLog();
    scrollLog();
    toast('已删除这条');
  }
  /** 重新生成：从这一条开始往后全部丢掉，然后重新问一次 */
  function doRegen(idx) {
    if (busy) { toast('等它说完再改'); return; }
    var list = msgs();
    var m = list[idx];
    if (!m || m.role !== 'assistant') return;
    // 往前找回对应用户消息；找不到就别动（比如它已经是被删过的孤儿）
    var userIdx = -1;
    for (var i = idx - 1; i >= 0; i--) { if (list[i].role === 'user') { userIdx = i; break; } }
    if (userIdx < 0) { toast('这条找不到对应的问题，删掉重发吧'); return; }
    list.splice(userIdx + 1);          // 从这一条回答开始往后全清
    saveMsgs();
    // 先拆掉旧的回复节点。不拆的话 currentAiMsg 会被 beginReply 之后的新对象覆盖，
    // 而 endReply 又会拿新对象去 msgs().indexOf —— 旧的那条记录虽然已经从数组里
    // splice 掉了，DOM 上的旧气泡却还留着，看起来像"重新生成没生效"。
    replyEls.forEach(function (el) {
      var r = el.parentNode;
      if (r) r.remove();
    });
    restoreLog();
    scrollLog();
    setBusy(true);
    beginReply();
    if (!apiConfigured()) { runDemo(); return; }
    runApi();
  }

  function addSystem(text) {
    var row = document.createElement('div');
    row.className = 'row sys';
    var s = document.createElement('div');
    s.className = 'sysline';
    s.textContent = text;
    row.appendChild(s);
    logEl.appendChild(row);
    return s;
  }

  function restoreLog() {
    logEl.innerHTML = '';
    lastShownAt = 0;
    var last = 0;
    msgs().forEach(function (m, i) {
      var ts = m.at || Date.now();
      if (!last || ts - last >= GAP_MS) addStamp(ts, !last);
      last = ts;
      var b;
      if (m.role === 'user') {
        b = addMsg('me', m.content);
      } else {
        b = addMsg('ai', '', false);
        if (m.greet) {
          var h = document.createElement('p');
          h.className = 'hello';
          h.textContent = 'Ventana';
          b.appendChild(h);
        }
        renderMarkdown(b, m.content || '');
      }
      b._msgIndex = i;
      attachActions(b, m.role === 'user' ? 'me' : 'ai');
    });
  }
  // 会话数据由启动段的 loadStore() 装载（见文件末尾「启动」一节）

  /* ---------- 滚动 ---------- */
  var toBottomBtn = $('#toBottom');
  function scrollLog() { logEl.scrollTop = logEl.scrollHeight; }
  function atBottom() {
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 90;
  }
  function scrollFollow() { if (atBottom()) scrollLog(); }
  function syncToBottomBtn() { toBottomBtn.classList.toggle('show', !atBottom()); }
  logEl.addEventListener('scroll', syncToBottomBtn, { passive: true });
  toBottomBtn.addEventListener('click', function () { scrollLog(); syncToBottomBtn(); });

  /* 输入卡是 fixed 的，高度随字数变化（最多 5 行）；把它写进 CSS 变量，
     消息区的下内边距跟着走，最后一条永远不被输入卡压住。 */
  var composerWrap = $('#composerWrap');
  function syncComposer() {
    var h = Math.round(composerWrap.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--composer-h', h + 'px');
  }
  if (window.ResizeObserver) new ResizeObserver(syncComposer).observe(composerWrap);
  window.addEventListener('orientationchange', function () { setTimeout(syncComposer, 260); });

  /* ---------- 流式渲染：合帧 + 孤尾保护（思路借鉴 dwell paintStream） ---------- */
  var ORPHAN_TAIL = /[`*~]+$/;

  /* 合帧绘制。requestAnimationFrame 把一帧内的多次增量合并成一次 DOM 写入 ——
     但它**不保证会触发**：页面不可见时（切到后台标签页、被遮住的窗口、
     某些无头环境）浏览器完全不产帧，`document.hidden === true` 时 rAF 会被无限期挂起。
     真发生的话表现是：字都收到了，屏幕上一个字都不出，只有"正在输入"三点一直转 ——
     本轮就在无头 Chrome 里撞上了这个（document.hidden 为 true，rAF 一次都不触发）。
     所以配一个兜底定时器：谁先到谁画，画完取消另一个，保证一定落地。 */
  var PAINT_FALLBACK_MS = 120;
  function paintSoon(el, fn) {
    var done = false, timer = null;
    var run = function () {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!el.isConnected) return;      // 气泡已经被移除（比如用户按了停止）
      fn();
    };
    timer = setTimeout(run, PAINT_FALLBACK_MS);
    // rAF 本身也包一层 try：某些环境（或被打成桩的测试环境）调用它就会抛。
    // 抛出去的话 el._paint 永远不复位，那条气泡从此再也不会更新 —— 表现是
    // "只有正在输入三点一直转"。踩过一次，别再让它裸奔。
    try { requestAnimationFrame(run); } catch (e) { /* 兜底定时器已经在跑了 */ }
  }

  function appendDelta(el, t) {
    el._raw = (el._raw || '') + t;
    if (el._thinking) { el._thinking.remove(); el._thinking = null; }   // 第一个字到了就撤掉"正在输入"
    if (el._paint || el._final) return;
    el._paint = true;
    paintSoon(el, function () {
      el._paint = false;
      if (el._final || !el.isConnected) return;
      el.textContent = '';
      el.appendChild(document.createTextNode((el._raw || '').replace(ORPHAN_TAIL, '')));
      el.appendChild(spanCaret());
      scrollFollow();
    });
  }
  function spanCaret() {
    var c = document.createElement('span');
    c.className = 'caret';
    return c;
  }

  function finalize(el, errMsg) {
    el._final = true;
    if (el._thinking) { el._thinking.remove(); el._thinking = null; }
    el.textContent = '';
    if (errMsg) {
      el.classList.add('err');
      el.textContent = errMsg;
      return;
    }
    renderMarkdown(el, el._raw || '');
  }

  /* ---------- 落盘 ----------
     一处容易漏的地方：用户按「停止」时，回复是半截的。
     旧写法只在整段成功回调里 push 消息，于是被中断的那条刷新后整条消失。
     所以改成「每次定稿就立刻把这一轮已吐出的文字写回 localStorage」。 */
  function pushMsg(m) {
    m.at = m.at || Date.now();
    msgs().push(m);
    saveMsgs();
    return m;
  }
  /** 把当前已定稿的若干气泡合并成一条 assistant 消息写回 */
  function commitReply(msg, els) {
    msg.content = els.map(function (el) { return el._raw || ''; })
      .filter(Boolean).join('\n\n');
    saveMsgs();
  }

  /* ---------- 轻量 markdown 渲染（定稿时调用） ---------- */
  var URL_RE = /(https?:\/\/[^\s<>"']+)/g;
  var INLINE_RE = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(~~([^~]+)~~)/g;

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function cleanUrl(u) {
    var m = u.match(/[，。；：！？、,.;:!?"']+$/);
    return m ? u.slice(0, u.length - m[0].length) : u;
  }

  function renderMarkdown(el, src) {
    var parts = String(src || '').split(/```/);
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var seg = parts[i].replace(/\n$/, '');
        var nl = seg.indexOf('\n');
        if (nl >= 0) seg = seg.slice(nl + 1);
        var pre = document.createElement('pre');
        var code = document.createElement('code');
        code.textContent = seg;
        pre.appendChild(code);
        el.appendChild(pre);
      } else {
        appendParas(el, parts[i]);
      }
    }
  }

  function appendParas(el, text) {
    var paras = String(text).split(/\n\n+/);
    for (var i = 0; i < paras.length; i++) {
      var para = paras[i];
      if (!para.trim()) continue;
      var p = document.createElement('p');
      var lines = para.split('\n');
      for (var j = 0; j < lines.length; j++) {
        if (j) p.appendChild(document.createElement('br'));
        appendInline(p, lines[j]);
      }
      el.appendChild(p);
    }
  }

  function appendInline(el, text) {
    var last = 0, m, node, url;
    while ((m = URL_RE.exec(text))) {
      if (m.index > last) appendInlineMarkup(el, text.slice(last, m.index));
      url = cleanUrl(m[1]);
      node = document.createElement('a');
      node.href = url;
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
      node.textContent = url;
      el.appendChild(node);
      last = m.index + m[0].length;
    }
    if (last < text.length) appendInlineMarkup(el, text.slice(last));
  }

  function appendInlineMarkup(el, text) {
    INLINE_RE.lastIndex = 0;
    var last = 0, m, node;
    while ((m = INLINE_RE.exec(text))) {
      if (m.index > last) el.append(text.slice(last, m.index));
      if (m[1] !== undefined) {
        node = document.createElement('strong'); node.textContent = m[2];
      } else if (m[3] !== undefined) {
        node = document.createElement('code'); node.textContent = m[4];
      } else {
        node = document.createElement('s'); node.textContent = m[6];
      }
      el.appendChild(node);
      last = m.index + m[0].length;
    }
    if (last < text.length) el.append(text.slice(last));
  }

  /* ---------- 真实 API 流式（OpenAI 兼容 SSE） ---------- */
  /* ============================================================
     流式请求（OpenAI 兼容）
     ------------------------------------------------------------
     带上 tools：模型可以主动"读文档"和"取记忆"。
     为什么用 tools 而不是让模型直接输出全文：文档可能几万字，
     整段塞进提示词就等于每轮都在为它付钱；工具调用是**按需**的，
     只有真要用的那一轮才把内容拉进上下文。

     返回值：{ text, calls } —— text 是这一轮的正文，
     calls 是模型请求的工具调用（可能为空）。
     ============================================================ */
  var TOOLS = [
    {
      type: 'function',
      function: {
        name: 'read_doc',
        description: '读取一份已上传资料的全文。只在确实需要里面的内容时调用；'
          + '不要为了"了解一下"而调用，也不要一次调用多个。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '资料的名字，和索引里列的一致' },
          },
          required: ['name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'save_memory',
        description: '往记忆馆写一条笔记。适合记下值得长期记住的事实、约定、'
          + '对方的状态或偏好。不要记录寒暄。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '一句话标题，10 字以内' },
            body: { type: 'string', description: '正文，写给未来的自己看' },
          },
          required: ['title', 'body'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_memory',
        description: '读取记忆馆里某一条的正文（索引里只有标题）。',
        parameters: {
          type: 'object',
          properties: { title: { type: 'string', description: '记忆的标题' } },
          required: ['title'],
        },
      },
    },
  ];
  var toolsEnabled = true;    // 某些端点不支持 tools，被拒一次后就一直是 false

  function streamChat(cfg_, history, onDelta, signal) {
    var base = (cfg_.base || '').replace(/\/+$/, '');
    return new Promise(function (resolve, reject) {
      var body = {
        model: cfg_.model,
        messages: history,
        stream: true,
      };
      if (toolsEnabled) { body.tools = TOOLS; body.tool_choice = 'auto'; }

      fetch(base + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (cfg_.key || '')
        },
        body: JSON.stringify(body),
        signal: signal
      }).then(function (res) {
        if (!res.ok) {
          return res.text().then(function (t) {
            var detail = '';
            try { var j = JSON.parse(t); detail = j.error && (j.error.message || j.error.code) || ''; } catch (e) {}
            var err = new Error('HTTP ' + res.status + (detail ? ' - ' + detail : ''));
            err.status = res.status;
            err.detail = detail;
            reject(err);
          });
        }
        var reader = res.body.getReader();
        var dec = new TextDecoder();
        var buf = '';
        var text = '';
        var calls = [];            // [{ id, name, args }]
        (function pump() {
          reader.read().then(function (chunk) {
            if (chunk.done) { resolve({ text: text, calls: calls }); return; }
            buf += dec.decode(chunk.value, { stream: true });
            var idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
              var line = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (line.indexOf('data:') !== 0) continue;
              var data = line.slice(5).trim();
              if (data === '[DONE]') { resolve({ text: text, calls: calls }); return; }
              try {
                var j = JSON.parse(data);
                var delta = j.choices && j.choices[0] && j.choices[0].delta;
                if (!delta) continue;
                if (delta.content) { text += delta.content; onDelta(delta.content); }
                /* 工具调用的参数是**分片**流进来的：先给 id 和函数名，
                   后面的分片只给 args 的一小段，必须按 index 拼接。
                   这是最容易写错的地方 —— 当成完整 JSON 解析会一直失败。 */
                if (delta.tool_calls) {
                  delta.tool_calls.forEach(function (tc) {
                    var slot = tc.index === undefined ? 0 : tc.index;
                    if (!calls[slot]) calls[slot] = { id: '', name: '', args: '' };
                    if (tc.id) calls[slot].id = tc.id;
                    if (tc.function) {
                      if (tc.function.name) calls[slot].name = tc.function.name;
                      if (tc.function.arguments) calls[slot].args += tc.function.arguments;
                    }
                  });
                }
              } catch (e) {}
            }
            pump();
          }).catch(function (err) {
            if (err && err.name === 'AbortError') reject(new Error('已停止'));
            else reject(err);
          });
        })();
      }).catch(function (err) {
        if (err && err.name === 'AbortError') reject(new Error('已停止'));
        else reject(err);
      });
    });
  }

  /* ============================================================
     文本协议：[[读:名字]] / [[记:标题|正文]] / [[忆:标题]]
     ------------------------------------------------------------
     为什么在 tools 之外还要有它：
       · 不是所有端点都支持 tools（自建服务、老网关），被拒一次就全废
       · 小模型经常不老老实实走 function calling，但写一行标记很自然
     两条路都留着：模型走 tools 就走 tools，走文本标记我们也能认出来。
     ============================================================ */
  var MARK_RE = /^[ \t]*\[\[(读|记|忆)\s*[:：]\s*([\s\S]*?)\]\][ \t]*$/;
  // 文本里出现 [[ 就认为可能要触发协议：此时不要带光标，免得把半截标记画出来
  function looksLikeMarker(text) { return /\[\[/.test(text); }

  /** 在一段完整文本里找出所有标记行，返回 [{ kind, arg, raw }] */
  function findMarkers(text) {
    var out = [];
    String(text || '').split('\n').forEach(function (line) {
      var m = line.match(MARK_RE);
      if (m) out.push({ kind: m[1], arg: m[2], raw: line });
    });
    return out;
  }

  /** 执行一条标记/工具调用，返回给模型看的结果文本，并产生一条系统事件 */
  function runAction(kind, arg) {
    if (kind === '读') {
      var doc = findDoc(arg);
      if (!doc) {
        addSystem('想读《' + String(arg).trim() + '》，但资料库里没有这份');
        return '资料库里没有叫《' + String(arg).trim() + '》的文档。现有：'
          + (docs.map(function (d) { return d.name; }).join('、') || '（空的）');
      }
      addSystem('读了《' + doc.name + '》（' + doc.text.length + ' 字）');
      return '《' + doc.name + '》全文：\n\n' + doc.text;
    }
    if (kind === '忆') {
      var memo = findMemory(arg);
      if (!memo) {
        addSystem('想取记忆「' + String(arg).trim() + '」，但没找到');
        return '记忆馆里没有这一条。现有标题：'
          + (memories.map(function (m) { return m.title; }).join('、') || '（空的）');
      }
      addSystem('取了记忆「' + memo.title + '」');
      return '[' + fmtDay(memo.at) + '] ' + memo.title + '\n' + memo.body;
    }
    if (kind === '记') {
      var bar = String(arg).indexOf('|') >= 0 ? '|' : (String(arg).indexOf('｜') >= 0 ? '｜' : null);
      var title, body;
      if (bar) {
        var parts = String(arg).split(bar);
        title = parts[0]; body = parts.slice(1).join(bar);
      } else {
        title = String(arg).slice(0, 16); body = String(arg);
      }
      if (!String(body).trim()) return '没写内容，这条没有记下来。';
      var item = addMemory(title, body);
      addSystem('记下了 · ' + item.title);
      renderMemoryBadge();
      return '已记下「' + item.title + '」。';
    }
    return '不认识的指令：' + kind;
  }

  /** 把 OpenAI 风格的 tool_calls 执行掉，返回要回给模型的 tool 消息 */
  function runToolCalls(calls) {
    return calls.map(function (c) {
      var args = {};
      try { args = JSON.parse(c.args || '{}'); } catch (e) {}
      var out;
      if (c.name === 'read_doc') out = runAction('读', args.name || '');
      else if (c.name === 'save_memory') out = runAction('记', (args.title || '') + '|' + (args.body || ''));
      else if (c.name === 'read_memory') out = runAction('忆', args.title || '');
      else out = '没有这个工具：' + c.name;
      return { role: 'tool', tool_call_id: c.id, content: String(out).slice(0, 20000) };
    });
  }

  /* ---------- 演示模式：内置回复模拟流式 ----------
     故意拆成多条、彼此间留停顿 —— 真人的回复从来不是一坨，是一条一条来的。
     接入真实 API 后这层会被真流式替换，但「多条 + 停顿」的节奏要保留。 */
  var DEMO_REPLY = [
    '你好，我是 **Ventana** —— 住在这台手机里的一个小房间。',
    '现在还是演示模式：我正用内置回复跟你说话。'
      + '流式打字、多条连发、中间那几段停顿，都已经在跑了。',
    '想让我真的开口：\n'
      + '1. 点右上角那枚齿轮\n'
      + '2. 连接方式切成「真实 API」\n'
      + '3. 填好接口地址、API Key 和模型名\n'
      + '4. 点「试一试」确认能通，再点「保存」',
    '然后我们就能真的聊起来。'
  ];

  function demoStream(parts, onDelta) {
    return new Promise(function (resolve) {
      var pi = 0, ci = 0, timer = null, emitted = false;
      function tick() {
        if (!busy) { timer = null; return; }        // 被用户按了停止
        if (pi >= parts.length) { timer = null; resolve(); return; }
        var seg = parts[pi];
        /* 一条气泡只发一次新气泡标记，而且必须和第一个字同一次 tick 发出：
           分开成两次会留下一个空气泡（第一个标记已经建了气泡，字还没到）。 */
        if (ci === 0 && !emitted) { emitted = true; onDelta('__NEW__'); }
        if (ci < seg.length) {
          onDelta(seg[ci]); ci++;
          timer = setTimeout(tick, 14 + Math.random() * 12);
        } else {
          pi++; ci = 0; emitted = false;
          timer = setTimeout(tick, 420 + Math.random() * 520);   // 气泡之间的停顿
        }
      }
      timer = setTimeout(tick, 260);
    });
  }

  /* ============================================================
     发送流程（含"多轮工具调用"循环）
     ------------------------------------------------------------
     一轮回答可能是这样产生的：
       模型输出一段字 → 要求读文档 → 我们给全文 → 模型接着输出 → 定稿
     所以发送不再是一次请求，而是一个循环：
       请求 → 有工具调用就执行、再请求 → 没工具调用就结束
     每段文字落在自己的气泡里，工具调用落成中间那条居中的系统行。
     循环有次数上限，模型抽风反复调同一个工具时不会把手机烧穿。
     ============================================================ */
  var MAX_ROUNDS = 4;

  /** 当前正在吐字的气泡。没有就新开一个（工具调用之后需要新开） */
  function bubbleFor() {
    if (!cur || cur._final || !cur.isConnected) {
      cur = addMsg('ai', '', true);
      cur._msgIndex = currentAiMsg ? msgs().indexOf(currentAiMsg) : -1;
      replyEls.push(cur);
      currentAiEl = cur;
      scrollLog();
    }
    return cur;
  }

  function beginReply() {
    replyEls = [];
    cur = null;
    currentAiMsg = pushMsg({ role: 'assistant', content: '' });
    // 「正在输入」在输入卡上方单独显示，不占气泡 ——
    // 否则遇到"这一轮只调工具、没有正文"的情况，会先冒一个空气泡再消失。
    showTyping(true);
  }

  function endReply() {
    showTyping(false);
    replyEls.forEach(function (el) { if (!el._final) finalize(el); });
    if (currentAiMsg) commitReply(currentAiMsg, replyEls);
    // 流式结束才挂菜单：生成过程中挂上去，重新生成/删除按钮是能点但会出错的
    var idx = currentAiMsg ? msgs().indexOf(currentAiMsg) : -1;
    replyEls.forEach(function (el, i) {
      el._msgIndex = idx;
      if (i === 0) attachActions(el, 'ai');
    });
    replyEls = [];
    cur = null;
    currentAiEl = null;
    currentAiMsg = null;
    setBusy(false);
  }

  function send() {
    if (busy) { stopChat(); return; }
    var text = box.value.trim();
    if (!text) return;

    addStamp(Date.now());
    var meEl = addMsg('me', text);
    var meMsg = pushMsg({ role: 'user', content: text });
    meEl._msgIndex = msgs().indexOf(meMsg);
    attachActions(meEl, 'me');
    scrollLog();

    box.value = '';
    autoGrow();
    refreshSend();
    setBusy(true);
    beginReply();

    if (!apiConfigured()) { runDemo(); return; }
    runApi();
  }

  /* ---------- 演示模式：内置回复 ---------- */
  function runDemo() {
    demoStream(DEMO_REPLY, function (t) {
      if (t === '__NEW__') {
        var prev = cur;
        if (prev && !prev._final) { finalize(prev); commitReply(currentAiMsg, replyEls); }
        cur = addMsg('ai', '', true);
        cur._msgIndex = currentAiMsg ? msgs().indexOf(currentAiMsg) : -1;
        replyEls.push(cur);
        currentAiEl = cur;
        scrollLog();
        return;
      }
      appendDelta(bubbleFor(), t);
    })
      .then(endReply)
      .catch(function () { endReply(); });
  }

  /* ---------- 真实 API：多轮循环 ---------- */
  function runApi() {
    abortCtrl = new AbortController();
    /* 发给模型的对话：system（人格 + 文档索引 + 记忆索引）+ 历史。
       历史里**去掉**空的占位消息（正在生成的这条），它还没有内容。 */
    var history = buildMessages(msgs().filter(function (m) {
      return m.content && m.content.length;
    }));

    (function round(n) {
      if (n >= MAX_ROUNDS) { endReply(); return; }
      var sawMarker = false;      // 这一轮是否需要走文本协议
      streamChat(cfg, history, function (t) {
        if (looksLikeMarker(t) || sawMarker) { sawMarker = true; return; }   // 标记片段先不画
        appendDelta(bubbleFor(), t);
      }, abortCtrl.signal)
        .then(function (res) {
          var body = res.text || '';
          var calls = (res.calls || []).filter(function (c) { return c && c.name; });

          /* 1) 原生工具调用 */
          if (calls.length) {
            var el0 = bubbleFor();
            if (body.trim() && !sawMarker) { el0._raw = body; finalize(el0); }
            else { el0._raw = ''; el0._final = true; removeEmptyBubble(el0); }
            history = history.concat([{
              role: 'assistant', content: body || null,
              tool_calls: calls.map(function (c) {
                return { id: c.id || uid('call'), type: 'function',
                         function: { name: c.name, arguments: c.args || '{}' } };
              }),
            }], runToolCalls(calls));
            commitReply(currentAiMsg, replyEls);
            return round(n + 1);
          }

          /* 2) 文本协议（端不支持 tools 时的退路，也兼容小模型的自发写法） */
          var marks = findMarkers(body);
          if (marks.length) {
            var plain = body.split('\n').filter(function (line) { return !line.match(MARK_RE); })
              .join('\n').trim();
            var el = bubbleFor();
            if (plain) { el._raw = plain; finalize(el); }
            else { el._final = true; removeEmptyBubble(el); }
            var results = marks.map(function (mk) { return runAction(mk.kind, mk.arg); });
            history = history.concat([
              { role: 'assistant', content: body },
              { role: 'user', content: '[系统] 执行结果：\n' + results.join('\n\n') },
            ]);
            commitReply(currentAiMsg, replyEls);
            return round(n + 1);
          }

          /* 3) 正常收尾 */
          var last = bubbleFor();
          if (sawMarker || !last._raw) {
            // 标记型输出没有正文可画，或这一段本来就是空的
            if (body.trim()) { last._raw = body; finalize(last); }
            else { last._final = true; removeEmptyBubble(last); }
          }
          endReply();
        })
        .catch(function (err) {
          var el = bubbleFor();
          var msg = (err.message || '网络出问题了');
          /* 端点不认 tools 的话，去掉 tools 再来一次 —— 不让"不支持"变成"不能用" */
          if (/tool|function|param/i.test(err.detail || '') && toolsEnabled) {
            toolsEnabled = false;
            if (!el._raw) removeEmptyBubble(el);
            return runApi();
          }
          finalize(el, '没接上：' + msg);
          endReply();
        });
    })(0);
  }

  /* 输入卡上方那条"正在输入"：只在**还没吐出第一个字**时显示。
     比空气泡干净，也不会因为"这一轮只调工具"就闪一个空气泡出来 */
  var typingEl = null;
  function showTyping(on) {
    // 注意顺序：必须先 ensureTypingRow() 再判断 typingEl。
    // 写成"先 if (!typingEl) return"的话，元素还没建时会把整个显示逻辑吞掉，
    // 表现是"正在输入"永远不出现（本轮踩过：元素在 HTML 里本来就不存在）。
    ensureTypingRow();
    if (!typingEl) return;
    typingEl.classList.toggle('show', !!on);
  }
  function ensureTypingRow() {
    if (typingEl && typingEl.parentNode) return;
    typingEl = document.createElement('div');
    typingEl.id = 'typing';
    typingEl.className = 'typingbar';
    typingEl.innerHTML = '<i></i><i></i><i></i>';
    var wrap = document.getElementById('composerWrap');
    if (wrap && wrap.parentNode) wrap.parentNode.insertBefore(typingEl, wrap);
    else document.body.appendChild(typingEl);
  }

  /** 撤掉一个字都没有的气泡（工具调用前后会留下这种空壳） */
  function removeEmptyBubble(el) {
    if (!el) return;
    if ((el._raw || '').length) return;
    var row = el.parentNode;
    if (row) row.remove();
    replyEls = replyEls.filter(function (x) { return x !== el; });
    if (cur === el) cur = null;
    if (currentAiEl === el) currentAiEl = null;
  }

  function stopChat() {
    if (abortCtrl) { try { abortCtrl.abort(); } catch (e) {} abortCtrl = null; }
    /* 要撤的是「还没吐出字」的那条（停顿期间已经建好、只有三点的那个），
       不是 last —— last 是下一条，已经定稿，删掉会把上一条一起带走。 */
    if (currentAiEl && !currentAiEl._final) {
      currentAiEl._final = true;
      if (currentAiEl._thinking) { currentAiEl._thinking.remove(); currentAiEl._thinking = null; }
      if (currentAiEl._raw) {
        currentAiEl.textContent = '';
        renderMarkdown(currentAiEl, currentAiEl._raw);
      }
    }
    for (var i = replyEls.length - 1; i >= 0; i--) {
      var el = replyEls[i];
      if (el._final && (el._raw || '').length) continue;   // 有内容的留着
      var r = el.parentNode;
      if (r) r.remove();
      replyEls.splice(i, 1);
    }
    if (!replyEls.length) {
      // 一条都没留下来：给个交代，别让屏幕像什么都没发生
      var note = addMsg('ai', '', false);
      note.classList.add('err');
      note.textContent = '停下了。';
      replyEls.push(note);
    }
    if (currentAiMsg) commitReply(currentAiMsg, replyEls);
    cur = null;
    currentAiEl = null;
    currentAiMsg = null;
    setBusy(false);
  }

  function setBusy(b) {
    busy = b;
    sendBtn.classList.toggle('stop', b);
    sendBtn.disabled = b ? false : !box.value.trim();
  }

  /* ---------- 输入框丝滑 ---------- */
  function autoGrow() {
    box.style.height = 'auto';
    box.style.height = Math.min(box.scrollHeight, 132) + 'px';
    syncComposer();
  }
  function refreshSend() {
    if (!busy) sendBtn.disabled = !box.value.trim();
  }

  box.addEventListener('input', function () { autoGrow(); refreshSend(); });
  box.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener('click', send);

  /* ---------- 顶部标签 / 视图切换 ---------- */
  var modelTag = $('#modelTag'), ctxChip = $('#ctxChip');
  function updateModelTag() {
    var ready = apiConfigured();
    modelTag.textContent = ready ? cfg.model : '演示模式';
    ctxChip.classList.toggle('live', ready);
    var who = persona.file || (persona.text.trim() ? '自定义人格' : '');
    ctxChip.title = (ready ? '当前模型：' + cfg.model : '还没有连上模型，回复来自内置示例')
      + (who ? ' · 人格：' + who : ' · 未设人格');
  }

  function showView(which) {
    $('#viewChat').classList.toggle('hidden', which !== 'chat');
    $('#viewConfig').classList.toggle('hidden', which !== 'config');
    $('#viewMemory').classList.toggle('hidden', which !== 'memory');
  }

  function openConfig() { fillCfgForm(); showView('config'); }
  function openMemory() { renderMemory(); renderArchives(); showView('memory'); }
  $('#openMemory').addEventListener('click', openMemory);
  $('#memBack').addEventListener('click', function () { showView('chat'); scrollLog(); });
  $('#memArchive').addEventListener('click', function () {
    // 顶栏那个箱子：滚到归档区，方便一键找到
    var h = document.querySelector('#archList');
    if (h && h.scrollIntoView) h.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#convArchive').addEventListener('click', function () {
    archiveCurrent();
    showView('chat');
  });
  $('#openConfig').addEventListener('click', openConfig);
  ctxChip.addEventListener('click', openConfig);
  $('#backChat').addEventListener('click', function () {
    // 还没点保存就走了的话，输入框里的内容不该丢 —— 静默存下来
    if (fPrompt && fPrompt.value !== persona.text) savePrompt(true);
    showView('chat');
  });

  /* ---------- 配置页 ---------- */
  var apiBanner = $('#apiBanner');
  var fBase = $('#cfgBase'), fKey = $('#cfgKey'), fModel = $('#cfgModel');
  var fPrompt = $('#cfgPrompt'), promptStat = $('#promptStat'), promptFileInput = $('#promptFile');
  var cfgMsg = $('#cfgMsg');
  var PROMPT_SOFT_LIMIT = 8000;       // 字数超过就提示（不是硬限制）

  function sayMsg(t, bad) {
    cfgMsg.textContent = t || '';
    cfgMsg.className = 'ap-msg' + (bad ? ' bad' : '');
  }

  function updatePromptStat() {
    var n = (persona.text || '').length;
    if (!n) {
      promptStat.textContent = '还没写。空着就是通用助手，没有性格。';
      promptStat.className = 'hint';
      return;
    }
    var msg = (persona.file ? persona.file + ' · ' : '') + n + ' 字';
    if (n > PROMPT_SOFT_LIMIT) {
      msg += '（偏长了，每轮都会整段发给模型，建议压到 ' + PROMPT_SOFT_LIMIT + ' 字以内）';
      promptStat.className = 'hint bad';
    } else {
      msg += ' · 每轮对话都会带上';
      promptStat.className = 'hint ok';
    }
    promptStat.textContent = msg;
  }

  /* 当前用不用真实 API —— **算出来的，不是存下来的**。
     上一版有个「演示模式 / 真实 API」的滑块（cfg.demo 存在 localStorage 里），
     它的问题是会和实际配置脱节：三项都填好了但滑块停在演示模式，或者反过来。
     现在只认一个事实：三项齐了就调 API，缺一项就走演示兜底。
     于是演示模式不需要用户"开启"，它就是未配置状态的默认行为。 */
  function apiConfigured() {
    return !!(cfg.base && cfg.key && cfg.model);
  }

  function renderBanner() {
    apiBanner.classList.add('show');
    if (apiConfigured()) {
      apiBanner.innerHTML = '已连接 · <b>' + escapeHtml(cfg.model) + '</b>'
        + '　改完三项记得点「保存」。';
    } else {
      var missing = [];
      if (!cfg.base) missing.push('接口地址');
      if (!cfg.key) missing.push('API Key');
      if (!cfg.model) missing.push('模型名');
      apiBanner.innerHTML = '现在是<b>演示模式</b>：还没有连上模型，'
        + '回复来自 App 内置的示例，不是真的角色。<br>'
        + '把' + missing.join('、') + '填好并保存，就会自动切过去 —— 不用手动开关。';
    }
  }

  function fillCfgForm() {
    fBase.value = cfg.base; fKey.value = cfg.key; fModel.value = cfg.model;
    fPrompt.value = persona.text || '';
    updatePromptStat();
    renderBanner();
    sayMsg('');
  }

  /* 人格：保存按钮单独走一条路。
     它和 API 三项是两回事 —— 只想改性格的人不该被"API 三项没填完"挡住。 */
  function savePrompt(quiet) {
    persona.text = fPrompt.value;
    savePersona();
    updatePromptStat();
    updateModelTag();
    if (!quiet) toast(persona.text.trim() ? '人格已保存' : '人格已清空');
  }

  $('#promptSave').addEventListener('click', function () { savePrompt(); });

  $('#promptClear').addEventListener('click', function () {
    fPrompt.value = '';
    persona.file = '';
    savePrompt(true);
    sayMsg('已清空人格。');
    toast('人格已清空');
  });

  $('#promptUpload').addEventListener('click', function () { promptFileInput.click(); });

  promptFileInput.addEventListener('change', function () {
    var file = promptFileInput.files && promptFileInput.files[0];
    if (!file) return;
    var MAX = 400 * 1024;              // 400KB：再大就不是提示词了
    if (file.size > MAX) {
      sayMsg('文件太大（' + Math.round(file.size / 1024) + 'KB），请不要超过 400KB。', true);
      promptFileInput.value = '';
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      persona.text = String(reader.result || '');
      persona.file = file.name;
      fPrompt.value = persona.text;
      savePersona();
      updatePromptStat();
      updateModelTag();
      sayMsg('已读入 ' + file.name + '（' + persona.text.length + ' 字），检查一遍内容再决定要不要改。');
      toast(file.name + ' 已读入');
    };
    reader.onerror = function () { sayMsg('这个文件读不出来，换一个试试。', true); };
    reader.readAsText(file, 'utf-8');
    promptFileInput.value = '';        // 允许重复选同一个文件
  });

  /* ---------- 资料库上传 ----------
     上传的是"资料"不是"人格"：它不进提示词，只进索引，需要时才被读取。
     所以这里没有"整段替换"的语义 —— 多份文档是各自独立的，可以并存、可以删。 */
  var docFileInput = $('#docFile');
  $('#docUpload').addEventListener('click', function () { docFileInput.click(); });

  docFileInput.addEventListener('change', function () {
    var files = [].slice.call(docFileInput.files || []);
    if (!files.length) return;
    var MAX = 2 * 1024 * 1024;      // 单份 2MB：本地存储够用，也不会让"读取"变得没意义
    var added = 0, skipped = [];
    var pending = files.length;

    files.forEach(function (f) {
      if (f.size > MAX) { skipped.push(f.name + '（超过 2MB）'); done(); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var d = addDoc(f.name, String(reader.result || ''));
        if (d) added++; else skipped.push(f.name + '（存储满了）');
        done();
      };
      reader.onerror = function () { skipped.push(f.name + '（读不出来）'); done(); };
      reader.readAsText(f, 'utf-8');
    });

    function done() {
      pending--;
      if (pending > 0) return;
      if (added) toast('已加入资料库 ' + added + ' 份');
      if (skipped.length) sayMsg('有 ' + skipped.length + ' 份没加进来：' + skipped.join('、'), true);
      else if (added) sayMsg('已加入 ' + added + ' 份资料。它们不会占提示词，聊到相关的事才会被读取。');
      docFileInput.value = '';
    }
  });

  /* 在设置页按 Ctrl/⌘ + S 保存（人格和 API 一起），手机上不适用但桌面顺手 */
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
      if ($('#viewConfig').classList.contains('hidden')) return;
      e.preventDefault();
      savePrompt(true);
      $('#cfgSave').click();
    }
  });

  $('#cfgSave').addEventListener('click', function () {
    cfg.base = fBase.value.trim();
    cfg.key = fKey.value.trim();
    cfg.model = fModel.value.trim();
    savePrompt(true);                    // 人格跟着一起存，避免以为存了其实没存
    persistCfg();
    updateModelTag();
    renderBanner();
    if (!apiConfigured()) {
      sayMsg('已保存。连接三项还没齐，仍然走演示模式。');
      toast('已保存 · 仍是演示模式');
      return;
    }
    sayMsg('已保存，已连上 ' + cfg.model + '。');
    toast('设置已保存');
  });

  /* 清除连接 —— 这也是"回到演示模式"的唯一入口，
     免得用户为了试试演示模式去手动删 Key。 */
  $('#cfgForget').addEventListener('click', function () {
    cfg.base = ''; cfg.key = ''; cfg.model = '';
    persistCfg();
    fillCfgForm();
    updateModelTag();
    sayMsg('连接已清除，回到演示模式。人格保留着。');
    toast('已回到演示模式');
  });

  $('#cfgTest').addEventListener('click', function () {
    var base = fBase.value.trim().replace(/\/+$/, '');
    var key = fKey.value.trim();
    var model = fModel.value.trim();
    if (!base || !key || !model) { sayMsg('先把三项填完再试。', true); return; }
    sayMsg('正在敲门…');
    var btn = this;
    btn.disabled = true;
    fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false
      })
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          var d = '';
          try { var j = JSON.parse(t); d = (j.error && (j.error.message || j.error.code)) || ''; } catch (e) {}
          sayMsg('没通（HTTP ' + r.status + '）' + (d ? ' - ' + d : ''), true);
        });
      }
      return r.json().then(function (j) {
        sayMsg('通了 —— 对面回的模型是 ' + (j.model || '(没报名字)'));
      });
    }).catch(function (err) {
      sayMsg('没通：' + err.message, true);
    }).then(function () { btn.disabled = false; });
  });

  $('#cfgClear').addEventListener('click', function () {
    clearMsgs();
    logEl.innerHTML = '';
    lastShownAt = 0;
    welcome();
    toast('对话已清空');
  });

  /* ---------- toast ---------- */
  var toastEl = $('#toast'), toastTimer = null;
  function toast(t) {
    toastEl.textContent = t;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 1900);
  }

  /* ---------- 欢迎语 ----------
     它是一条**真实消息**（进门就写进会话），不是一个凭空画上去的装饰：
     这样它也有索引、也能被复制/删除，不会变成"看得见但点不动"的幽灵。 */
  function welcomeText() {
    return '你好，我是 **Ventana** —— 住在这台手机里的一个小房间。\n\n'
      + (apiConfigured()
          ? '已经接上真实模型了，随时可以开始。'
          : '现在还没有连上模型，我说的话来自 App 内置的示例 —— 不是真的角色。'
            + '点顶栏那枚齿轮填好接口、Key 和模型名，我就会换成真的。');
  }
  /** 只在空会话时种下欢迎语。**自己负责渲染**，调用方不要再调 restoreLog */
  function welcome() {
    if (msgs().length) return false;
    var m = { role: 'assistant', content: welcomeText(), at: nowMs(), greet: true };
    msgs().push(m);
    saveMsgs();
    restoreLog();
    return true;
  }

  /* ============================================================
     记忆馆（UI）
     ============================================================ */
  var memListEl = $('#memList'), archListEl = $('#archList'), memCountEl = $('#memCount');

  function renderMemoryBadge() {
    if (!memCountEl) return;
    memCountEl.hidden = !memories.length;
    memCountEl.textContent = memories.length;
  }

  function fmtDay(ts) {
    var d = new Date(ts), n = new Date();
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    if (d.toDateString() === n.toDateString()) return '今天 ' + hm;
    var y = new Date(n.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return '昨天 ' + hm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }

  function renderMemory() {
    renderMemoryBadge();
    if (!memListEl) return;
    if (!memories.length) {
      memListEl.innerHTML = '<div class="empty-note">还是空的。<br>'
        + '跟它说一句「记住这件事」，这里就会有第一条。</div>';
      return;
    }
    memListEl.innerHTML = '';
    // 按时间倒序渲染。addMemory 自己会排，但"AI 刚写完"和"刚从存储读出来"是两条路径，
    // 不在这里统一排一次的话，新写的那条会挂在列表末尾（看起来像没写进去）。
    memories.sort(function (a, b) { return b.at - a.at; });
    memories.forEach(function (m) {
      var el = document.createElement('div');
      el.className = 'item';
      el.setAttribute('data-id', m.id);
      var h = document.createElement('h3');
      h.appendChild(document.createTextNode(m.title));
      var t = document.createElement('time');
      t.textContent = fmtDay(m.at);
      h.appendChild(t);
      var body = document.createElement('p');
      body.textContent = m.body;
      var acts = document.createElement('div');
      acts.className = 'acts2';
      [['expand', '展开'], ['copy', '复制'], ['del', '删除']].forEach(function (d) {
        var b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('data-mact', d[0]);
        b.textContent = d[1];
        if (d[0] === 'del') b.className = 'danger';
        acts.appendChild(b);
      });
      el.appendChild(h); el.appendChild(body); el.appendChild(acts);
      memListEl.appendChild(el);
    });
  }

  memListEl.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('[data-mact]') : null;
    if (!btn) return;
    var item = btn.closest('.item');
    var id = item.getAttribute('data-id');
    var memo = memories.filter(function (m) { return m.id === id; })[0];
    if (!memo) return;
    var act = btn.getAttribute('data-mact');
    if (act === 'expand') {
      item.classList.toggle('open');
      btn.textContent = item.classList.contains('open') ? '收起' : '展开';
    } else if (act === 'copy') {
      copyText(memo.body).then(function (ok) { toast(ok ? '已复制' : '这台设备不允许自动复制'); });
    } else if (act === 'del') {
      memories = memories.filter(function (m) { return m.id !== id; });
      saveMemories();
      renderMemory();
      toast('已删除这条记忆');
    }
  });

  /* ============================================================
     已归档会话
     ============================================================ */
  /** 把一次会话导出成可读 txt（不依赖任何库） */
  function convToText(c) {
    var lines = [];
    lines.push('Ventana 会话记录');
    lines.push('标题：' + convTitle(c));
    lines.push('开始：' + new Date(c.createdAt).toLocaleString());
    lines.push('结束：' + new Date(c.updatedAt).toLocaleString());
    lines.push('消息：' + (c.messages || []).length + ' 条');
    lines.push('');
    lines.push('────────────────');
    lines.push('');
    (c.messages || []).forEach(function (m) {
      lines.push('[' + new Date(m.at || c.createdAt).toLocaleString() + '] '
        + (m.role === 'user' ? '我' : 'TA'));
      lines.push(m.content || '');
      lines.push('');
    });
    return lines.join('\n');
  }
  function download(filename, text, mime) {
    try {
      var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      return true;
    } catch (e) { return false; }
  }
  function safeName(t) { return String(t || 'conversation').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40); }

  function archiveCurrent() {
    if (!current) return;
    if (!msgs().length) { toast('这个会话还是空的，不用归档'); return; }
    current.archived = true;
    current.updatedAt = nowMs();
    // 归档完立刻开一个新会话 —— 不放着"当前会话是已归档的"这种怪状态
    newConv(true);
    saveStore();
    logEl.innerHTML = '';
    welcome();
    scrollLog();
    renderMemory();
    toast('已归档，开了一个新会话');
  }

  function renderArchives() {
    if (!archListEl) return;
    var list = archivedConvs();
    if (!list.length) {
      archListEl.innerHTML = '<div class="empty-note">还没有归档过会话。</div>';
      return;
    }
    archListEl.innerHTML = '';
    list.forEach(function (c) {
      var el = document.createElement('div');
      el.className = 'item';
      el.setAttribute('data-cid', c.id);
      var h = document.createElement('h3');
      h.appendChild(document.createTextNode(convTitle(c)));
      var t = document.createElement('time');
      t.textContent = fmtDay(c.createdAt);
      h.appendChild(t);
      var p = document.createElement('p');
      var last = (c.messages || []).slice(-1)[0];
      p.textContent = last ? ((last.role === 'user' ? '我：' : 'TA：') + (last.content || '')) : '';
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = (c.messages || []).length + ' 条消息';
      var acts = document.createElement('div');
      acts.className = 'acts2';
      [['restore', '取消归档'], ['export', '导出 txt'], ['del', '删除'], ['rename', '改名']]
        .forEach(function (d) {
          var b = document.createElement('button');
          b.type = 'button';
          b.setAttribute('data-cact', d[0]);
          b.textContent = d[1];
          if (d[0] === 'del') b.className = 'danger';
          acts.appendChild(b);
        });
      el.appendChild(h); el.appendChild(p); el.appendChild(meta); el.appendChild(acts);
      archListEl.appendChild(el);
    });
  }

  archListEl.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('[data-cact]') : null;
    if (!btn) return;
    var item = btn.closest('.item');
    var id = item.getAttribute('data-cid');
    var c = store.convs.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    var act = btn.getAttribute('data-cact');
    if (act === 'restore') {
      c.archived = false;
      c.updatedAt = nowMs();
      saveStore(); renderMemory();
      toast('已取消归档，回到对话列表');
    } else if (act === 'export') {
      var ok = download(safeName(convTitle(c)) + '.txt', convToText(c), 'text/plain');
      toast(ok ? '已导出 txt' : '这台设备不允许下载');
    } else if (act === 'rename') {
      var name = prompt('给这个会话起个名字', convTitle(c));
      if (name !== null) { c.title = String(name).trim().slice(0, 40); saveStore(); renderArchives(); }
    } else if (act === 'del') {
      if (!confirm('删除后无法恢复（没有导出的话就真没了）。确定删除？')) return;
      store.convs = store.convs.filter(function (x) { return x.id !== id; });
      saveStore();
      renderMemory();
      renderArchives();      // 不重画的话列表里还留着刚删掉的那条
      toast('已删除');
    }
  });

  /* 切换会话：把当前会话换成指定 id（归档里的也可以，会被拉回活跃） */
  function switchTo(convId) {
    var c = store.convs.filter(function (x) { return x.id === convId; })[0];
    if (!c) return;
    c.archived = false;
    store.activeId = c.id;
    current = c;
    saveStore();
    restoreLog();
    if (!msgs().length) welcome();
    scrollLog();
  }

  /* ============================================================
     资料库（技能文档）：只存本地 + 只给索引，按需读取
     ============================================================ */
  function addDoc(name, text) {
    var d = { id: uid('d'), name: String(name || '未命名').slice(0, 60),
              text: String(text || ''), at: nowMs() };
    docs.push(d);
    var ok = saveDocs();
    if (!ok) { docs.pop(); return null; }
    renderDocs();
    return d;
  }

  function renderDocs() {
    var wrap = $('#docList');
    if (!wrap) return;
    if (!docs.length) {
      wrap.innerHTML = '<div class="hint" id="docStat">资料库是空的。'
        + '上传的文档不会进提示词，只在需要时被读取。</div>';
      var b = $('#docCount');
      if (b) b.textContent = '';
      return;
    }
    wrap.innerHTML = '';
    docs.forEach(function (d) {
      var el = document.createElement('div');
      el.className = 'docitem';
      el.setAttribute('data-did', d.id);
      var info = document.createElement('div');
      info.className = 'docinfo';
      var n = document.createElement('b'); n.textContent = d.name;
      var s = document.createElement('span');
      s.textContent = d.text.length + ' 字 · ' + fmtDay(d.at) + ' · 需要时才读';
      info.appendChild(n); info.appendChild(s);
      var del = document.createElement('button');
      del.type = 'button'; del.className = 'act danger';
      del.setAttribute('data-dact', 'del');
      del.textContent = '删除';
      el.appendChild(info); el.appendChild(del);
      wrap.appendChild(el);
    });
  }

  var docListEl = $('#docList');
  if (docListEl) docListEl.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('[data-dact]') : null;
    if (!btn) return;
    var el = btn.closest('.docitem');
    var id = el.getAttribute('data-did');
    docs = docs.filter(function (d) { return d.id !== id; });
    saveDocs();
    renderDocs();
    toast('已删除这份资料');
  });

  /* ---------- 启动 ---------- */
  loadStore();          // 会话（必须在消息区任何操作之前）
  loadDocs();
  loadMemories();
  loadPersona();
  updateModelTag();
  syncComposer();
  renderMemoryBadge();
  renderDocs();

  /* 移动端键盘：interactive-widget=resizes-content 已由浏览器接管；这里兜底适配 */
  if (window.visualViewport) {
    var lastVV = window.visualViewport.height;
    window.visualViewport.addEventListener('resize', function () {
      var h = window.visualViewport.height;
      if (lastVV - h > 60 && atBottom() && window.visualViewport.offsetTop > 0) {
        setTimeout(function () { scrollLog(); syncComposer(); }, 60);
      }
      lastVV = h;
      syncComposer();
    });
  }

  if (msgs().length) { restoreLog(); scrollLog(); } else { welcome(); }
  syncToBottomBtn();

  /* PWA 注册：仅 http(s) 下生效，直接双击打开 file:// 时自动跳过。
     版本号写在 sw.js 的注册 URL 里 —— 换了版本浏览器就会当成新的 Service Worker
     去安装，装上后 activate 清掉旧缓存。不加这一句，"改了代码看不到"会反复出现。 */
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    var hadController = !!navigator.serviceWorker.controller;
    var reloading = false;
    var reloadOnce = function () {
      if (reloading) return;      // 每次加载只刷一次，避免意外循环
      reloading = true;
      location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      // 新版本接管时自动刷一次，免得手机上一直看着旧代码
      if (hadController) reloadOnce();
    });
    navigator.serviceWorker.addEventListener('message', function (ev) {
      // Service Worker 说「这一页是从缓存里拿的旧版本」（换版本后旧 SW 还在服务，
      // 或者断网）。在线的话刷一次就能拿到新的。
      var d = ev.data || {};
      if (d.type === 'stale-page' && navigator.serviceWorker.controller && navigator.onLine) reloadOnce();
    });
    navigator.serviceWorker.register('sw.js?v=' + encodeURIComponent(VERSION))
      .catch(function () {});
  }

  $('#verLine').textContent = 'Ventana ' + VERSION + ' · 本地存储 · 无服务器';
