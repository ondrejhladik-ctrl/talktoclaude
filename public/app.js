import { renderMarkdown, speakable, esc } from './markdown.js';

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const store = {
  get(k, d) { try { const v = localStorage.getItem(`ttc.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`ttc.${k}`, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(`ttc.${k}`); } catch {} },
};

const settings = Object.assign(
  { lang: 'cs-CZ', speak: 'voice', rate: 1.05, autoSend: true, vibrate: true, wakeLock: true },
  store.get('settings', {}),
);
const saveSettings = () => store.set('settings', settings);

const TOOL_LABEL = {
  Bash: 'Příkaz', PowerShell: 'PowerShell', Read: 'Čte', Write: 'Zapisuje', Edit: 'Upravuje', MultiEdit: 'Upravuje',
  Glob: 'Hledá soubory', Grep: 'Hledá v textu', WebFetch: 'Otevírá web', WebSearch: 'Hledá na webu',
  Task: 'Pomocník', Agent: 'Pomocník', TodoWrite: 'Úkoly', NotebookEdit: 'Notebook', Skill: 'Dovednost',
};
const PERM_TITLE = {
  Bash: 'Spustit příkaz', PowerShell: 'Spustit příkaz', Write: 'Zapsat soubor', Edit: 'Upravit soubor',
  MultiEdit: 'Upravit soubor', NotebookEdit: 'Upravit notebook', WebFetch: 'Otevřít webovou stránku',
  WebSearch: 'Hledat na webu', Read: 'Přečíst soubor', Task: 'Spustit pomocníka', Agent: 'Spustit pomocníka',
};

const S = {
  token: null, ws: null, retry: 0, retryTimer: null,
  sessions: [], recent: [], defaults: {}, hasQr: false, link: null, mode: 'bypassPermissions',
  sid: store.get('sid', null), meta: null, events: [], nodes: new Map(), toolNodes: new Map(),
  liveText: '', liveRaf: 0,
  voiceDraft: false, queued: null, browsePath: null,
};

const list = $('list');
const messagesEl = $('messages');
const inputEl = $('input');

// ======================================================== připojení

function readToken() {
  const t = new URLSearchParams(location.hash.slice(1)).get('t');
  if (t) { store.set('token', t); return t; }
  return store.get('token', null);
}

function showLogin(msg) {
  $('app').hidden = true;
  $('login').hidden = false;
  if (msg) $('loginMsg').textContent = msg;
}

function setConn(state) {
  $('conn').className = `conn ${state}`;
  if (state !== 'online') $('subText').textContent = state === 'connecting' ? 'Připojuji k počítači…' : 'Odpojeno – zkouším znovu…';
  else updateHeader();
}

function connect() {
  if (!S.token) { showLogin(); return; }
  clearTimeout(S.retryTimer);
  if (S.ws && S.ws.readyState <= 1) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws?t=${encodeURIComponent(S.token)}`);
  S.ws = ws;
  setConn('connecting');
  ws.onopen = () => { S.retry = 0; };
  ws.onmessage = e => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    handle(m);
  };
  ws.onclose = e => {
    if (S.ws !== ws) return;
    S.ws = null;
    if (e.code === 4401) {
      store.del('token');
      S.token = null;
      showLogin('Neplatný přístupový kód. Otevři znovu odkaz nebo QR kód z terminálu na počítači.');
      return;
    }
    setConn('offline');
    S.retryTimer = setTimeout(connect, Math.min(1000 * 2 ** S.retry++, 10000));
  };
}

function wsSend(m) {
  if (S.ws && S.ws.readyState === 1) { S.ws.send(JSON.stringify(m)); return true; }
  toast('Nejsi připojený k počítači.', true);
  return false;
}

function handle(m) {
  switch (m.t) {
    case 'init':
      setConn('online');
      S.sessions = m.sessions;
      S.recent = m.recent || [];
      S.defaults = m.defaults || {};
      S.hasQr = !!m.hasQr;
      S.link = m.link || null;
      if (m.mode) S.mode = m.mode;
      renderSessions();
      if (S.sid && S.sessions.some(s => s.id === S.sid)) wsSend({ t: 'open', sid: S.sid });
      else if (S.sessions.length) wsSend({ t: 'open', sid: S.sessions[0].id });
      else showSession(null, []);
      break;
    case 'sessions':
      S.sessions = m.sessions;
      if (m.recent) S.recent = m.recent;
      renderSessions();
      break;
    case 'meta': upsertMeta(m.session); break;
    case 'link': S.link = m.link; S.hasQr = true; break;
    case 'mode':
      S.mode = m.mode;
      $('setAsk').checked = m.mode !== 'bypassPermissions';
      toast(m.mode === 'bypassPermissions' ? 'Claude teď dělá cokoliv bez ptaní.' : 'Claude se teď ptá před akcemi.');
      break;
    case 'session':
      showSession(m.session, m.events);
      if (S.queued) { const q = S.queued; S.queued = null; wsSend({ t: 'send', sid: S.sid, ...q }); }
      break;
    case 'ev': if (m.sid === S.sid) onEvent(m.ev); break;
    case 'delta': if (m.sid === S.sid) onDelta(m); break;
    case 'ls': renderDirs(m); break;
    case 'deleted':
      if (m.sid === S.sid) {
        S.sid = null;
        const next = S.sessions.find(s => s.id !== m.sid);
        if (next) wsSend({ t: 'open', sid: next.id }); else showSession(null, []);
      }
      break;
    case 'error': toast(m.message, true); break;
  }
}

// ======================================================== konverzace

function showSession(meta, events) {
  S.sid = meta ? meta.id : null;
  store.set('sid', S.sid);
  S.meta = meta;
  S.events = events || [];
  if (meta) upsertMeta(meta, true);
  clearLive();
  renderAll();
}

function upsertMeta(meta, quiet) {
  const i = S.sessions.findIndex(s => s.id === meta.id);
  const prev = i >= 0 ? S.sessions[i] : null;
  if (i >= 0) S.sessions[i] = meta; else S.sessions.unshift(meta);
  if (meta.id === S.sid) S.meta = meta;
  else if (!quiet && meta.pending > (prev?.pending || 0)) {
    toast(`„${meta.title}“ čeká na tvoje povolení`);
    buzz([80, 60, 80]);
  }
  renderSessions();
  updateHeader();
  updateComposer();
  updateWorking();
  updateWakeLock();
}

function updateHeader() {
  const m = S.meta;
  $('title').textContent = m ? m.title : 'Claude';
  if ($('conn').classList.contains('online')) {
    $('subText').textContent = m ? folderName(m.cwd) : `Připojeno k ${S.defaults.host || 'počítači'}`;
  }
  const waiting = S.sessions.filter(s => s.id !== S.sid && s.pending > 0).length;
  $('menuBadge').hidden = !waiting;
  $('menuBadge').textContent = waiting;
}

const folderName = p => (p || '').split(/[\\/]/).filter(Boolean).pop() || p || '';

function renderAll() {
  list.textContent = '';
  S.nodes.clear();
  S.toolNodes.clear();
  for (const ev of S.events) renderEvent(ev);
  $('empty').hidden = !!S.events.length;
  $('emptyCwd').textContent = S.meta ? S.meta.cwd : (S.recent[0] || S.defaults.cwd || '');
  updateHeader();
  updateComposer();
  updateWorking();
  scrollBottom(true);
}

function onEvent(ev) {
  const i = S.events.findIndex(e => e.n === ev.n);
  if (i >= 0) {
    S.events[i] = ev;
    const old = S.nodes.get(ev.n);
    const node = buildNode(ev);
    if (old && node) { node.dataset.n = ev.n; old.replaceWith(node); S.nodes.set(ev.n, node); }
    updateComposer();
    updateWorking();
    return;
  }
  const near = isNearBottom();
  S.events.push(ev);
  $('empty').hidden = true;
  if (ev.k === 'text') clearLive();
  renderEvent(ev);
  if (ev.k === 'perm' && ev.status === 'pending') {
    buzz([80, 60, 80]);
    if (wantSpeech()) say(ev.kind === 'question' ? 'Claude se na něco ptá.' : 'Claude potřebuje tvoje povolení.');
  }
  if (ev.k === 'result') onTurnDone(ev);
  updateComposer();
  updateWorking();
  if (near || ev.k === 'user' || ev.k === 'perm') scrollBottom();
}

function renderEvent(ev) {
  if (ev.k === 'tool_result') { attachResult(ev); return; }
  const node = buildNode(ev);
  if (!node) return;
  node.dataset.n = ev.n;
  S.nodes.set(ev.n, node);
  list.appendChild(node);
}

function buildNode(ev) {
  switch (ev.k) {
    case 'user': {
      const n = el('div', 'msg user');
      const b = el('div', 'bubble', ev.text);
      if (ev.voice) b.appendChild(el('span', 'via', 'nadiktováno'));
      n.appendChild(b);
      return n;
    }
    case 'text': {
      const n = el('div', 'msg assistant md');
      n.innerHTML = renderMarkdown(ev.text);
      return n;
    }
    case 'tool': return buildTool(ev);
    case 'perm': return buildPerm(ev);
    case 'result': {
      if (ev.interrupted) return el('div', 'msg result', '⏹ Přerušeno');
      if (ev.ok) return el('div', 'msg result', `✓ Hotovo${ev.ms ? ` · ${fmtDur(ev.ms)}` : ''}`);
      return el('div', 'msg error', `Chyba: ${ev.text || ev.subtype || 'neznámá'}`);
    }
    case 'error': return el('div', 'msg error', ev.text);
    case 'info': return el('div', 'msg info', ev.text);
    default: return null;
  }
}

const fmtDur = ms => (ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);
const shortPath = p => (typeof p === 'string' ? p.replace(/^.*[\\/](?=[^\\/]+[\\/][^\\/]+$)/, '…/') : '');

function toolSummary(name, inp = {}) {
  switch (name) {
    case 'Bash': case 'PowerShell': return inp.description || inp.command;
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': return shortPath(inp.file_path);
    case 'NotebookEdit': return shortPath(inp.notebook_path);
    case 'Glob': return inp.pattern;
    case 'Grep': return inp.pattern + (inp.path ? ` · ${shortPath(inp.path)}` : '');
    case 'WebFetch': return inp.url;
    case 'WebSearch': return inp.query;
    case 'Task': case 'Agent': return inp.description || (inp.prompt || '').slice(0, 80);
    case 'TodoWrite': {
      const t = inp.todos || [];
      return `${t.filter(x => x.status === 'completed').length}/${t.length} hotovo`;
    }
    case 'Skill': return inp.skill || inp.command;
    default: return name.startsWith('mcp__') ? name.split('__').slice(1).join(' · ') : '';
  }
}

function toolDetail(name, inp = {}) {
  const box = el('div');
  if (name === 'Bash' || name === 'PowerShell') {
    box.appendChild(el('pre', 'pre', `$ ${inp.command || ''}`));
  } else if (name === 'Edit' || name === 'MultiEdit') {
    const edits = name === 'MultiEdit' ? inp.edits || [] : [inp];
    box.appendChild(el('div', 'perm-sub', inp.file_path || ''));
    for (const e of edits) box.appendChild(diffPre(e.old_string, e.new_string));
  } else if (name === 'Write') {
    box.appendChild(el('div', 'perm-sub', inp.file_path || ''));
    const lines = String(inp.content || '').split('\n');
    box.appendChild(el('pre', 'pre', lines.slice(0, 60).join('\n') + (lines.length > 60 ? `\n… (+${lines.length - 60} řádků)` : '')));
  } else {
    box.appendChild(el('pre', 'pre', JSON.stringify(inp, null, 2)));
  }
  return box;
}

function diffPre(oldS, newS) {
  const pre = el('pre', 'pre');
  for (const l of String(oldS || '').split('\n')) pre.appendChild(el('span', 'diff-del', `- ${l}`));
  for (const l of String(newS || '').split('\n')) pre.appendChild(el('span', 'diff-add', `+ ${l}`));
  return pre;
}

function buildTool(ev) {
  if (ev.name === 'TodoWrite') {
    const n = el('div', 'msg tool');
    const ul = el('ul', 'todos');
    for (const t of ev.input?.todos || []) {
      const li = el('li', t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'doing' : '');
      li.textContent = `${t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'} ${t.content || t.activeForm || ''}`;
      ul.appendChild(li);
    }
    n.appendChild(ul);
    return n;
  }
  const n = el('div', 'msg tool');
  const head = el('button', 'tool-head');
  head.append(
    el('span', 'tool-ico', '⚙'),
    el('span', 'tool-name', TOOL_LABEL[ev.name] || ev.name),
    el('span', 'tool-sum', toolSummary(ev.name, ev.input) || ''),
    el('span', 'tool-chev', '›'),
  );
  const body = el('div', 'tool-body');
  body.hidden = true;
  head.onclick = () => {
    if (!body.firstChild) body.appendChild(toolDetail(ev.name, ev.input));
    body.hidden = !body.hidden;
    n.classList.toggle('open', !body.hidden);
    if (n._out && !body.contains(n._out)) body.appendChild(n._out);
  };
  n.append(head, body);
  S.toolNodes.set(ev.id, n);
  const running = S.meta?.running && !S.events.some(e => e.k === 'tool_result' && e.id === ev.id);
  if (running) { n.classList.add('run'); head.firstChild.textContent = '◌'; }
  return n;
}

function attachResult(ev) {
  const n = S.toolNodes.get(ev.id);
  if (!n) return;
  n.classList.remove('run');
  n.classList.add(ev.isError ? 'err' : 'ok');
  const ico = n.querySelector('.tool-ico');
  if (ico) ico.textContent = ev.isError ? '✗' : '✓';
  if (ev.text) {
    const t = ev.text.length > 4000 ? `${ev.text.slice(0, 4000)}\n…` : ev.text;
    n._out = el('pre', 'pre out', t);
    const body = n.querySelector('.tool-body');
    if (body && body.firstChild) body.appendChild(n._out);
  }
}

// ---------------- povolení, otázky, plán

function buildPerm(ev) {
  if (ev.status !== 'pending') return buildPermDone(ev);
  if (ev.kind === 'question') return buildQuestion(ev);
  const n = el('div', 'msg card perm');
  if (ev.kind === 'plan') {
    n.appendChild(el('div', 'perm-title', '📋 Claude navrhuje plán'));
    const plan = el('div', 'plan md');
    plan.innerHTML = renderMarkdown(ev.input?.plan || '');
    n.appendChild(plan);
    n.appendChild(actions([
      ['Schválit', 'primary', () => decide(ev, 'allow')],
      ['Schválit + upravovat sám', '', () => decide(ev, 'allowEdits')],
      ['Zamítnout', 'danger', () => decide(ev, 'deny')],
    ]));
  } else {
    n.appendChild(el('div', 'perm-title', `🔐 ${PERM_TITLE[ev.tool] || `Použít nástroj ${ev.tool}`}`));
    const sub = [ev.title, ev.description].filter(Boolean).join(' · ');
    if (sub) n.appendChild(el('div', 'perm-sub', sub));
    n.appendChild(toolDetail(ev.tool, ev.input));
    const btns = [['Povolit', 'primary', () => decide(ev, 'allow')]];
    if (ev.canAlways) btns.push(['Vždy povolit', '', () => decide(ev, 'always')]);
    btns.push(['Zamítnout', 'danger', () => decide(ev, 'deny')]);
    n.appendChild(actions(btns));
  }
  n.appendChild(el('div', 'perm-tip', 'Nebo napiš / řekni, co má udělat jinak.'));
  return n;
}

function actions(btns) {
  const row = el('div', 'actions');
  for (const [label, cls, fn] of btns) {
    const b = el('button', `btn ${cls}`, label);
    b.onclick = () => { row.querySelectorAll('button').forEach(x => { x.disabled = true; }); fn(); };
    row.appendChild(b);
  }
  return row;
}

function decide(ev, decision, extra = {}) {
  unlockAudio();
  wsSend({ t: 'perm', sid: S.sid, id: ev.n, decision, ...extra });
}

function buildQuestion(ev) {
  const n = el('div', 'msg card perm');
  n.appendChild(el('div', 'perm-title', '❓ Claude se ptá'));
  const qs = ev.input?.questions || [];
  const state = qs.map(() => ({ sel: new Set(), other: '' }));
  const submit = el('button', 'btn primary', 'Odpovědět');
  const refresh = () => { submit.disabled = !state.every(s => s.sel.size || s.other.trim()); };
  qs.forEach((q, qi) => {
    const box = el('div', 'q');
    if (q.header) box.appendChild(el('div', 'q-head', q.header));
    box.appendChild(el('div', 'q-text', q.question));
    const opts = el('div', 'q-opts');
    for (const o of q.options || []) {
      const b = el('button', 'opt');
      b.appendChild(el('b', '', o.label));
      if (o.description) b.appendChild(el('span', '', o.description));
      b.onclick = () => {
        const s = state[qi];
        if (q.multiSelect) { s.sel.has(o.label) ? s.sel.delete(o.label) : s.sel.add(o.label); }
        else { s.sel.clear(); s.sel.add(o.label); }
        opts.querySelectorAll('.opt').forEach(x => x.classList.toggle('sel', s.sel.has(x.firstChild.textContent)));
        refresh();
      };
      opts.appendChild(b);
    }
    const other = el('input', 'q-other');
    other.placeholder = 'Jiná odpověď…';
    other.oninput = () => { state[qi].other = other.value; refresh(); };
    box.append(opts, other);
    n.appendChild(box);
  });
  submit.onclick = () => {
    const answers = {};
    qs.forEach((q, qi) => {
      const parts = [...state[qi].sel];
      if (state[qi].other.trim()) parts.push(state[qi].other.trim());
      answers[q.question] = parts.join(', ');
    });
    submit.disabled = true;
    decide(ev, 'answer', { answers });
  };
  const skip = el('button', 'btn', 'Přeskočit');
  skip.onclick = () => decide(ev, 'deny');
  const row = el('div', 'actions');
  row.append(submit, skip);
  n.appendChild(row);
  refresh();
  return n;
}

function buildPermDone(ev) {
  const n = el('div', `msg perm-done ${ev.status === 'denied' || ev.status === 'cancelled' ? 'denied' : ''}`);
  const what = ev.kind === 'question' ? 'Otázka' : ev.kind === 'plan' ? 'Plán' : `${PERM_TITLE[ev.tool] || ev.tool}: ${toolSummary(ev.tool, ev.input) || ''}`;
  const label = { allowed: '✓ Povoleno', always: '✓ Povoleno vždy', answered: '✓ Zodpovězeno', denied: '✗ Zamítnuto', cancelled: '– Zrušeno' }[ev.status] || ev.status;
  n.innerHTML = `<b>${esc(label)}</b> · ${esc(what)}`;
  if (ev.answers) {
    for (const [q, a] of Object.entries(ev.answers)) n.appendChild(el('div', '', `${q} → ${a}`));
  }
  return n;
}

// ---------------- živý text a indikátor práce

function onDelta(m) {
  if (m.reset) { if (S.liveText) S.liveText += '\n\n'; return; }
  if (!m.text) return;
  S.liveText += m.text;
  if (!S.liveRaf) {
    S.liveRaf = requestAnimationFrame(() => {
      S.liveRaf = 0;
      const near = isNearBottom();
      const live = $('live');
      live.hidden = !S.liveText;
      live.innerHTML = renderMarkdown(S.liveText);
      updateWorking();
      if (near) scrollBottom();
    });
  }
}

function clearLive() {
  S.liveText = '';
  if (S.liveRaf) { cancelAnimationFrame(S.liveRaf); S.liveRaf = 0; }
  $('live').hidden = true;
  $('live').textContent = '';
}

let workTimer = 0;
function updateWorking() {
  const running = !!S.meta?.running;
  const pending = S.events.some(e => e.k === 'perm' && e.status === 'pending');
  const show = running && !pending && !S.liveText;
  $('working').hidden = !show;
  clearInterval(workTimer);
  if (show) {
    const lastUser = [...S.events].reverse().find(e => e.k === 'user');
    const tick = () => {
      const s = lastUser ? Math.max(0, Math.round((Date.now() - lastUser.ts) / 1000)) : 0;
      $('workingText').textContent = `Pracuju… ${s >= 3 ? fmtDur(s * 1000) : ''}`;
    };
    tick();
    workTimer = setInterval(tick, 1000);
  }
}

function onTurnDone(ev) {
  clearLive();
  buzz(ev.ok ? [40] : [100, 50, 100]);
  if (!wantSpeech()) return;
  let last = null;
  for (let i = S.events.length - 1; i >= 0; i--) {
    const e = S.events[i];
    if (e.k === 'user') break;
    if (e.k === 'text') { last = e.text; break; }
  }
  if (last) speak(last);
  else if (!ev.ok && !ev.interrupted) say('Něco se pokazilo.');
}

// ======================================================== composer

function updateComposer() {
  const has = !!inputEl.value.trim();
  const running = !!S.meta?.running;
  $('sendBtn').hidden = !has;
  $('stopBtn').hidden = has || !running;
  document.body.classList.toggle('busy', running);
  const pending = S.events.some(e => e.k === 'perm' && e.status === 'pending');
  inputEl.placeholder = pending ? 'Napiš nebo řekni, co udělat jinak…' : 'Napiš, nebo klepni na mikrofon…';
}

function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight + 2, window.innerHeight * 0.4)}px`;
}

function sendText(textArg) {
  const text = (textArg ?? inputEl.value).trim();
  if (!text) return;
  const voice = S.voiceDraft;
  unlockAudio();
  stopSpeaking();
  if (!S.sid) {
    S.queued = { text, voice };
    if (!wsSend({ t: 'new', cwd: S.recent[0] || S.defaults.cwd })) { S.queued = null; return; }
  } else if (!wsSend({ t: 'send', sid: S.sid, text, voice })) return;
  S.voiceDraft = false;
  inputEl.value = '';
  autoGrow();
  updateComposer();
}

inputEl.addEventListener('input', () => {
  if (!inputEl.value.trim()) S.voiceDraft = false;
  autoGrow();
  updateComposer();
});
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
    e.preventDefault();
    sendText();
  }
});
$('sendBtn').onclick = () => sendText();
$('stopBtn').onclick = () => { if (S.sid) wsSend({ t: 'interrupt', sid: S.sid }); };
document.querySelectorAll('.sugg').forEach(b => { b.onclick = () => sendText(b.textContent); });

// ======================================================== hlas – rozpoznávání řeči

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let recFinal = '';
let recBase = '';

if (!SR || !window.isSecureContext) $('micBtn').classList.add('unavailable');

function startListening() {
  if (!window.isSecureContext) {
    toast('Mikrofon v prohlížeči funguje jen přes HTTPS. Otevři adresu https://… z terminálu, nebo použij diktování na klávesnici.', true);
    return;
  }
  if (!SR) {
    toast('Tento prohlížeč neumí rozpoznávat řeč. Použij diktování na klávesnici (ikona mikrofonu na klávesnici). Nejlíp funguje Chrome.', true);
    return;
  }
  stopSpeaking();
  unlockAudio();
  rec = new SR();
  rec.lang = settings.lang;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  recBase = inputEl.value.trim() ? `${inputEl.value.trim()} ` : '';
  recFinal = '';
  rec.onresult = e => {
    let fin = '';
    let interim = '';
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) fin += r[0].transcript; else interim += r[0].transcript;
    }
    recFinal = fin;
    inputEl.value = recBase + fin + interim;
    S.voiceDraft = true;
    autoGrow();
    updateComposer();
  };
  rec.onerror = e => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Přístup k mikrofonu je zakázaný. Povol ho v nastavení prohlížeče pro tuto stránku.', true);
    else if (e.error === 'no-speech') toast('Nic jsem neslyšel.');
    else if (e.error === 'network') toast('Rozpoznávání řeči potřebuje internet.', true);
    else if (e.error !== 'aborted') toast(`Chyba rozpoznávání řeči: ${e.error}`, true);
  };
  rec.onend = () => {
    rec = null;
    setListening(false);
    if (settings.autoSend && recFinal.trim() && inputEl.value.trim()) sendText();
  };
  try {
    rec.start();
    setListening(true);
  } catch (err) {
    rec = null;
    toast(`Mikrofon nejde spustit: ${err.message}`, true);
  }
}

function setListening(on) {
  $('micBtn').classList.toggle('listening', on);
  $('orbBtn').classList.toggle('listening', on);
}
const toggleMic = () => { if (rec) rec.stop(); else startListening(); };
$('micBtn').onclick = toggleMic;
$('orbBtn').onclick = toggleMic;

// ======================================================== hlas – předčítání

let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked || !('speechSynthesis' in window)) return;
  audioUnlocked = true;
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch {}
}

function wantSpeech() {
  if (!('speechSynthesis' in window) || settings.speak === 'never') return false;
  if (settings.speak === 'always') return true;
  const lastUser = [...S.events].reverse().find(e => e.k === 'user');
  return !!lastUser?.voice;
}

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  const lang = settings.lang.toLowerCase();
  return voices.find(v => v.lang.replace('_', '-').toLowerCase() === lang) ||
    voices.find(v => v.lang.toLowerCase().startsWith(lang.slice(0, 2))) || null;
}

function say(text) {
  if (!('speechSynthesis' in window)) return;
  const chunks = (text.match(/[^.!?…]+[.!?…]*\s*/g) || [text]).reduce((acc, s) => {
    if (acc.length && (acc[acc.length - 1] + s).length < 220) acc[acc.length - 1] += s; else acc.push(s);
    return acc;
  }, []);
  speechSynthesis.cancel();
  const voice = pickVoice();
  chunks.forEach((c, i) => {
    const u = new SpeechSynthesisUtterance(c.trim());
    u.lang = settings.lang;
    u.rate = settings.rate;
    if (voice) u.voice = voice;
    if (i === chunks.length - 1) u.onend = u.onerror = () => { $('speaking').hidden = true; };
    speechSynthesis.speak(u);
  });
  $('speaking').hidden = false;
}

function speak(md) {
  let text = speakable(md);
  if (!text) return;
  if (text.length > 1500) {
    const cut = text.lastIndexOf('. ', 1500);
    text = `${text.slice(0, cut > 600 ? cut + 1 : 1500)} Zbytek najdeš v aplikaci.`;
  }
  say(text);
}

function stopSpeaking() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  $('speaking').hidden = true;
}
$('stopSpeakBtn').onclick = stopSpeaking;
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => {};

// ======================================================== drobnosti

function buzz(pattern) {
  if (settings.vibrate && navigator.vibrate) { try { navigator.vibrate(pattern); } catch {} }
}

let wakeLock = null;
async function updateWakeLock() {
  const want = settings.wakeLock && !!S.meta?.running && !document.hidden;
  if (want && !wakeLock && 'wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch {}
  } else if (!want && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

let toastTimer = 0;
function toast(text, isError) {
  const t = $('toast');
  t.textContent = text;
  t.className = `toast${isError ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 3500);
}
$('toast').onclick = () => { $('toast').hidden = true; };

const isNearBottom = () => messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140;
function scrollBottom(instant) {
  requestAnimationFrame(() => messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: instant ? 'auto' : 'smooth' }));
}

function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'teď';
  if (s < 3600) return `před ${Math.floor(s / 60)} min`;
  if (s < 86400) return `před ${Math.floor(s / 3600)} h`;
  if (s < 172800) return 'včera';
  return new Date(ts).toLocaleDateString('cs-CZ');
}

// ======================================================== dialogy

for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', e => { if (e.target === d) d.close(); });
  d.querySelectorAll('[data-close]').forEach(b => { b.onclick = () => d.close(); });
}

$('menuBtn').onclick = () => { renderSessions(); $('drawer').showModal(); };

function renderSessions() {
  const box = $('sessList');
  box.textContent = '';
  if (!S.sessions.length) { box.appendChild(el('div', 'sess-empty', 'Zatím žádné konverzace.')); return; }
  for (const s of S.sessions) {
    const row = el('div', `sess${s.id === S.sid ? ' active' : ''}`);
    const main = el('button', 'sess-main');
    main.append(el('div', 'sess-title', s.title), el('div', 'sess-sub', `${folderName(s.cwd)} · ${timeAgo(s.updatedAt)}`));
    main.onclick = () => { $('drawer').close(); if (s.id !== S.sid) wsSend({ t: 'open', sid: s.id }); };
    row.appendChild(main);
    if (s.pending) row.appendChild(el('span', 'sess-flag wait', 'čeká'));
    else if (s.running) row.appendChild(el('span', 'sess-flag run', '●'));
    const del = el('button', 'sess-del', '✕');
    del.setAttribute('aria-label', 'Smazat konverzaci');
    del.onclick = () => {
      if (del.classList.contains('confirm')) { wsSend({ t: 'delete', sid: s.id }); return; }
      del.classList.add('confirm');
      del.textContent = 'Smazat?';
      setTimeout(() => { del.classList.remove('confirm'); del.textContent = '✕'; }, 3000);
    };
    row.appendChild(del);
    box.appendChild(row);
  }
}

// ---------------- nová konverzace (výběr složky)

// Jedním klepnutím: nová konverzace ve stejné složce jako ta aktuální.
function newQuick() {
  if ($('drawer').open) $('drawer').close();
  wsSend({ t: 'new', cwd: S.meta?.cwd || S.recent[0] || S.defaults.cwd });
  inputEl.focus();
}
$('newBtn').onclick = newQuick;
$('newQuickBtn').onclick = newQuick;

$('newFolderBtn').onclick = () => {
  $('drawer').close();
  const chips = $('recent');
  chips.textContent = '';
  for (const p of S.recent) {
    const b = el('button', '', folderName(p));
    b.title = p;
    b.onclick = () => browse(p);
    chips.appendChild(b);
  }
  browse(S.meta?.cwd || S.recent[0] || S.defaults.cwd);
  $('newDlg').showModal();
};

function browse(p) {
  S.browsePath = p;
  $('cwdPath').textContent = p === '::drives' ? 'Tento počítač' : p;
  $('dirList').innerHTML = '<div class="dir-msg">Načítám…</div>';
  wsSend({ t: 'ls', path: p });
}

function renderDirs(m) {
  S.browsePath = m.path;
  $('cwdPath').textContent = m.path === '::drives' ? 'Tento počítač' : m.path;
  $('startHereBtn').disabled = m.path === '::drives';
  const box = $('dirList');
  box.textContent = '';
  if (m.parent) {
    const up = el('button', 'dir');
    up.append(el('b', '', '↑'), el('span', '', 'O úroveň výš'));
    up.onclick = () => browse(m.parent);
    box.appendChild(up);
  }
  if (m.error) box.appendChild(el('div', 'dir-msg', m.error));
  else if (!m.dirs.length) box.appendChild(el('div', 'dir-msg', 'Žádné podsložky.'));
  for (const d of m.dirs) {
    const b = el('button', 'dir');
    b.append(el('b', '', '📁'), el('span', '', d.name), el('b', '', '›'));
    b.onclick = () => browse(d.path);
    box.appendChild(b);
  }
}

$('startHereBtn').onclick = () => {
  if (!S.browsePath || S.browsePath === '::drives') return;
  if (wsSend({ t: 'new', cwd: S.browsePath })) $('newDlg').close();
};

// ---------------- nastavení

$('settingsBtn').onclick = () => {
  $('drawer').close();
  $('setAsk').checked = S.mode !== 'bypassPermissions';
  $('setLang').value = settings.lang;
  $('setSpeak').value = settings.speak;
  $('setRate').value = settings.rate;
  $('rateVal').textContent = `${Number(settings.rate).toFixed(2)}×`;
  $('setAutoSend').checked = settings.autoSend;
  $('setVibrate').checked = settings.vibrate;
  $('setWake').checked = settings.wakeLock;
  $('qrBox').hidden = !S.hasQr;
  if (S.hasQr) $('qrImg').src = `/qr.svg?t=${encodeURIComponent(S.token)}&v=${Date.now()}`;
  $('linkOut').hidden = !S.link;
  if (S.link) { $('linkOut').href = S.link; $('linkOut').textContent = S.link.replace(/#.*/, ''); }
  $('settingsDlg').showModal();
};
$('setAsk').onchange = e => wsSend({ t: 'mode', mode: e.target.checked ? 'default' : 'bypassPermissions' });
$('setLang').onchange = e => { settings.lang = e.target.value; saveSettings(); };
$('setSpeak').onchange = e => { settings.speak = e.target.value; saveSettings(); };
$('setRate').oninput = e => { settings.rate = Number(e.target.value); $('rateVal').textContent = `${settings.rate.toFixed(2)}×`; saveSettings(); };
$('setRate').onchange = () => say('Takhle rychle budu číst odpovědi.');
$('setAutoSend').onchange = e => { settings.autoSend = e.target.checked; saveSettings(); };
$('setVibrate').onchange = e => { settings.vibrate = e.target.checked; saveSettings(); };
$('setWake').onchange = e => { settings.wakeLock = e.target.checked; saveSettings(); updateWakeLock(); };
$('logoutBtn').onclick = () => {
  store.del('token');
  store.del('sid');
  S.token = null;
  const ws = S.ws;
  S.ws = null;
  ws?.close();
  $('settingsDlg').close();
  history.replaceState(null, '', location.pathname);
  showLogin('Odpojeno. Pro nové připojení naskenuj QR kód z terminálu na počítači.');
};

// ---------------- přihlášení

$('tokenBtn').onclick = () => {
  const raw = $('tokenInput').value.trim();
  if (!raw) return;
  const m = raw.match(/[#?&]t=([0-9a-f]+)/i);
  S.token = m ? m[1] : raw;
  store.set('token', S.token);
  $('login').hidden = true;
  $('app').hidden = false;
  connect();
};

// ======================================================== start

// iOS: přizpůsobení výšky při otevřené klávesnici
if (window.visualViewport) {
  const fit = () => document.documentElement.style.setProperty('--app-h', `${window.visualViewport.height}px`);
  window.visualViewport.addEventListener('resize', fit);
  fit();
}

document.addEventListener('visibilitychange', () => {
  updateWakeLock();
  if (!document.hidden && S.token && (!S.ws || S.ws.readyState > 1)) { S.retry = 0; connect(); }
});
window.addEventListener('online', () => { if (S.token && !S.ws) { S.retry = 0; connect(); } });
setInterval(() => { if (S.ws?.readyState === 1) S.ws.send('{"t":"ping"}'); }, 25000);

S.token = readToken();
if (S.token) connect(); else showLogin();
