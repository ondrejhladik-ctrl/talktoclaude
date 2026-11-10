import { renderMarkdown, speakable } from './markdown.js';
import { createBlob } from './blob.js';

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const line = (cls, text) => el('div', `ln ${cls}`, text);

const store = {
  get(k, d) { try { const v = localStorage.getItem(`ttc.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`ttc.${k}`, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(`ttc.${k}`); } catch {} },
};

const settings = Object.assign(
  { lang: 'cs-CZ', speak: 'always', rate: 1.05, autoSend: true, vibrate: true, wakeLock: true },
  store.get('settings', {}),
);
if (settings.speak === 'voice') settings.speak = 'always';
const saveSettings = () => store.set('settings', settings);

const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const SUGGESTIONS = ['co je v téhle složce?', 'najdi v projektu chyby a oprav je', 'shrň, na čem jsem naposledy pracoval'];
const ICON = {
  mic: '<svg viewBox="0 0 24 24" width="15" height="15"><rect x="9" y="3.5" width="6" height="10.5" rx="3" fill="currentColor"/><path d="M5.8 11.2a6.2 6.2 0 0 0 12.4 0M12 17.4v3.1" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="12" height="12"><rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor"/></svg>',
  enter: '⏎',
};
const TOOL_LABEL = {
  Bash: 'příkaz', PowerShell: 'příkaz', Read: 'čtu', Write: 'zapisuju', Edit: 'upravuju', MultiEdit: 'upravuju',
  Glob: 'hledám soubory', Grep: 'hledám v textu', WebFetch: 'otevírám web', WebSearch: 'hledám na webu',
  Task: 'pomocník', Agent: 'pomocník', NotebookEdit: 'notebook', Skill: 'dovednost',
};
const PERM_TITLE = {
  Bash: 'Spustit příkaz', PowerShell: 'Spustit příkaz', Write: 'Zapsat soubor', Edit: 'Upravit soubor',
  MultiEdit: 'Upravit soubor', NotebookEdit: 'Upravit notebook', WebFetch: 'Otevřít web',
  WebSearch: 'Hledat na webu', Read: 'Přečíst soubor', Task: 'Spustit pomocníka', Agent: 'Spustit pomocníka',
};

const S = {
  token: null, ws: null, retry: 0, retryTimer: null, connState: 'connecting',
  sessions: [], recent: [], defaults: {}, hasQr: false, link: null, mode: 'default',
  sid: store.get('sid', null), meta: null, events: [], nodes: new Map(), toolNodes: new Map(),
  liveText: '', liveRaf: 0, listening: false, speaking: false,
  voiceDraft: false, queued: null, browsePath: null,
};

const lines = $('lines');
const body = $('tBody');
const inputEl = $('input');
const blob = createBlob($('blobCanvas'));

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
  S.connState = state;
  $('conn').className = `conn ${state}`;
  updateHead();
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
      showLogin('Neplatný kód. Otevři znovu odkaz z počítače.');
      return;
    }
    setConn('offline');
    // Adresa tunelu se po restartu PC mění – po pár neúspěších přejdi na stálý odkaz, ten najde novou.
    const launcher = store.get('launcher', null);
    if (S.retry >= 3 && launcher && location.hostname.endsWith('.trycloudflare.com')) {
      location.replace(launcher);
      return;
    }
    S.retryTimer = setTimeout(connect, Math.min(1000 * 2 ** S.retry++, 10000));
  };
}

function rememberLauncher(link) {
  try { if (link && new URL(link).hostname.endsWith('.github.io')) store.set('launcher', link); } catch {}
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
      rememberLauncher(S.link);
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
      updateHead();
      break;
    case 'meta': upsertMeta(m.session); break;
    case 'link': S.link = m.link; S.hasQr = !!m.link; rememberLauncher(m.link); break;
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

// ======================================================== konverzace → terminál

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
  refresh();
}

const folderName = p => (p || '').split(/[\\/]/).filter(Boolean).pop() || p || '';

function updateHead() {
  const host = String(S.defaults.host || 'pc').toLowerCase();
  const folder = folderName(S.meta ? S.meta.cwd : (S.recent[0] || S.defaults.cwd || ''));
  let text = `claude@${host} ~ ${folder}`;
  if (S.connState === 'connecting') text = 'připojuji se k počítači…';
  else if (S.connState === 'offline') text = 'odpojeno – zkouším znovu…';
  $('tHead').textContent = text;
  const waiting = S.sessions.filter(s => s.id !== S.sid && s.pending > 0).length;
  $('menuBadge').hidden = !waiting;
  $('menuBadge').textContent = waiting;
}

function refresh() {
  updateHead();
  updatePill();
  updateTail();
  setBlobMode();
  updateWakeLock();
}

function renderIntro() {
  lines.append(
    line('dim', '# ahoj, tady Claude – pracuju přímo na tvém počítači'),
    line('dim', '# řekni nebo napiš, co mám udělat. třeba:'),
  );
  for (const s of SUGGESTIONS) {
    const d = line('sugg', `  → ${s}`);
    d.onclick = () => sendText(s);
    lines.append(d);
  }
}

function renderAll() {
  lines.textContent = '';
  S.nodes.clear();
  S.toolNodes.clear();
  if (!S.events.length) renderIntro();
  for (const ev of S.events) renderEvent(ev);
  refresh();
  scrollBottom(true);
}

function onEvent(ev) {
  const i = S.events.findIndex(e => e.n === ev.n);
  if (i >= 0) {
    S.events[i] = ev;
    const old = S.nodes.get(ev.n);
    const node = buildNode(ev);
    if (old && node) { old.replaceWith(node); S.nodes.set(ev.n, node); }
    refresh();
    return;
  }
  const near = isNearBottom();
  if (!S.events.length) lines.textContent = '';
  S.events.push(ev);
  if (ev.k === 'text') { clearLive(); blob.pulse(0.35); }
  if (ev.k === 'tool') blob.pulse(0.25);
  renderEvent(ev);
  if (ev.k === 'perm' && ev.status === 'pending') {
    buzz([80, 60, 80]);
    blob.pulse(0.6);
    if (wantSpeech()) say(ev.kind === 'question' ? 'Na něco se ptám.' : 'Potřebuju tvoje povolení.');
  }
  if (ev.k === 'result') onTurnDone(ev);
  refresh();
  if (near || ev.k === 'user' || ev.k === 'perm') scrollBottom();
}

function renderEvent(ev) {
  if (ev.k === 'tool_result') { attachResult(ev); return; }
  const node = buildNode(ev);
  if (!node) return;
  S.nodes.set(ev.n, node);
  lines.appendChild(node);
}

const fmtDur = ms => (ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);
const shortPath = p => (typeof p === 'string' ? p.replace(/^.*[\\/](?=[^\\/]+[\\/][^\\/]+$)/, '…/') : '');

function buildNode(ev) {
  switch (ev.k) {
    case 'user': {
      const d = line('cmd');
      d.append(el('span', 'ps', '~ $ '), document.createTextNode(ev.text));
      if (ev.voice) d.append(el('span', 'dim', '  🎤'));
      return d;
    }
    case 'text': {
      const d = el('div', 'ln out md');
      d.innerHTML = renderMarkdown(ev.text);
      return d;
    }
    case 'tool': return buildTool(ev);
    case 'perm': return buildPerm(ev);
    case 'result':
      if (ev.interrupted) return line('dim', '■ přerušeno');
      if (ev.ok) return line('dim', `✓ hotovo${ev.ms ? ` · ${fmtDur(ev.ms)}` : ''}`);
      return line('err', `✗ ${ev.text || ev.subtype || 'chyba'}`);
    case 'error': return line('err', `✗ ${ev.text}`);
    case 'info': return line('dim', `# ${ev.text}`);
    default: return null;
  }
}

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
    case 'Skill': return inp.skill || inp.command;
    default: return name.startsWith('mcp__') ? name.split('__').slice(1).join(' · ') : '';
  }
}

function detailNode(name, inp = {}, out) {
  const d = line('detail');
  if (name === 'Bash' || name === 'PowerShell') {
    d.append(`$ ${inp.command || ''}`);
  } else if (name === 'Edit' || name === 'MultiEdit') {
    d.append(`${inp.file_path || ''}\n`);
    for (const e of name === 'MultiEdit' ? inp.edits || [] : [inp]) {
      for (const l of String(e.old_string || '').split('\n').slice(0, 30)) d.append(el('span', 'del', `- ${l}`));
      for (const l of String(e.new_string || '').split('\n').slice(0, 30)) d.append(el('span', 'add', `+ ${l}`));
    }
  } else if (name === 'Write') {
    const l = String(inp.content || '').split('\n');
    d.append(`${inp.file_path || ''}\n${l.slice(0, 40).join('\n')}${l.length > 40 ? `\n… (+${l.length - 40} řádků)` : ''}`);
  } else {
    d.append(JSON.stringify(inp, null, 2));
  }
  if (out) d.append(`\n\n${out.length > 2000 ? `${out.slice(0, 2000)}…` : out}`);
  return d;
}

function buildTool(ev) {
  if (ev.name === 'TodoWrite') {
    const box = el('div');
    for (const t of ev.input?.todos || []) {
      const mark = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
      box.append(line(t.status === 'in_progress' ? 'out' : 'dim', `${mark} ${t.content || t.activeForm || ''}`));
    }
    return box;
  }
  const d = line('tool');
  d.append(`→ ${TOOL_LABEL[ev.name] || ev.name}  ${toolSummary(ev.name, ev.input) || ''}`, el('span', 'st'));
  S.toolNodes.set(ev.id, d);
  const done = S.events.find(e => e.k === 'tool_result' && e.id === ev.id);
  if (!done && S.meta?.running) { d.classList.add('run'); d.lastChild.textContent = '…'; }
  d.onclick = () => {
    if (d._detail) { d._detail.remove(); d._detail = null; return; }
    d._detail = detailNode(ev.name, ev.input, d._out);
    d.after(d._detail);
  };
  return d;
}

function attachResult(ev) {
  const d = S.toolNodes.get(ev.id);
  if (!d) return;
  d.classList.remove('run');
  d.classList.add(ev.isError ? 'bad' : 'ok');
  d.lastChild.textContent = ev.isError ? '✗' : '✓';
  d._out = ev.text || '';
}

function pendingPerm() {
  for (let i = S.events.length - 1; i >= 0; i--) {
    const e = S.events[i];
    if (e.k === 'perm' && e.status === 'pending') return e;
  }
  return null;
}

function buildPerm(ev) {
  const what = ev.kind === 'question' ? 'otázka' : ev.kind === 'plan' ? 'plán' : `${PERM_TITLE[ev.tool] || ev.tool}: ${toolSummary(ev.tool, ev.input) || ''}`;
  if (ev.status !== 'pending') {
    const label = { allowed: '✓ povoleno', always: '✓ povoleno vždy', answered: '✓ odpověď', denied: '✗ zamítnuto', cancelled: '– zrušeno' }[ev.status] || ev.status;
    const box = el('div');
    box.append(line(ev.status === 'denied' ? 'err' : 'dim', `${label} · ${what}`));
    for (const [q, a] of Object.entries(ev.answers || {})) box.append(line('dim', `  ${q} → ${a}`));
    return box;
  }
  const box = el('div');
  if (ev.kind === 'question') {
    const qs = ev.input?.questions || [];
    const answers = qs.map(() => null);
    const submit = () => {
      if (answers.some(a => a == null)) return;
      const out = {};
      qs.forEach((q, i) => { out[q.question] = answers[i]; });
      decide(ev, 'answer', { answers: out });
    };
    qs.forEach((q, qi) => {
      box.append(line('ask', `? ${q.question}`));
      const opts = el('div', 'opts');
      const picked = new Set();
      for (const o of q.options || []) {
        const b = el('button', 'opt', o.label);
        if (o.description) b.title = o.description;
        b.onclick = () => {
          if (q.multiSelect) {
            picked.has(o.label) ? picked.delete(o.label) : picked.add(o.label);
            b.classList.toggle('sel', picked.has(o.label));
          } else {
            opts.querySelectorAll('.opt').forEach(x => x.classList.remove('sel'));
            b.classList.add('sel');
            answers[qi] = o.label;
            submit();
          }
        };
        opts.append(b);
      }
      if (q.multiSelect) {
        const ok = el('button', 'opt', 'hotovo ⏎');
        ok.onclick = () => { if (picked.size) { answers[qi] = [...picked].join(', '); submit(); } };
        opts.append(ok);
      }
      box.append(opts);
    });
    return box;
  }
  if (ev.kind === 'plan') {
    box.append(line('ask', '? navrhuju tento plán:'));
    const plan = el('div', 'ln out md');
    plan.innerHTML = renderMarkdown(ev.input?.plan || '');
    box.append(plan);
    return box;
  }
  box.append(line('ask', `? ${PERM_TITLE[ev.tool] || `použít ${ev.tool}`} – můžu?`));
  const sub = [ev.title, ev.description].filter(Boolean).join(' · ');
  if (sub) box.append(line('dim', sub));
  box.append(detailNode(ev.tool, ev.input));
  return box;
}

function decide(ev, decision, extra = {}) {
  unlockAudio();
  wsSend({ t: 'perm', sid: S.sid, id: ev.n, decision, ...extra });
}

// ---------------- živý text, poslední řádek terminálu

function onDelta(m) {
  if (m.reset) { if (S.liveText) S.liveText += '\n\n'; return; }
  if (!m.text) return;
  S.liveText += m.text;
  blob.pulse(0.3);
  if (!S.liveRaf) {
    S.liveRaf = requestAnimationFrame(() => {
      S.liveRaf = 0;
      const near = isNearBottom();
      $('tLive').hidden = !S.liveText;
      $('tLive').innerHTML = renderMarkdown(S.liveText);
      updateTail();
      if (near) scrollBottom();
    });
  }
}

function clearLive() {
  S.liveText = '';
  if (S.liveRaf) { cancelAnimationFrame(S.liveRaf); S.liveRaf = 0; }
  $('tLive').hidden = true;
  $('tLive').textContent = '';
}

let tailTimer = 0;
function updateTail() {
  const tail = $('tTail');
  clearInterval(tailTimer);
  tail.textContent = '';
  const running = !!S.meta?.running;
  if (pendingPerm() || (running && S.liveText)) { tail.hidden = true; return; }
  tail.hidden = false;
  if (running) {
    tail.className = 'ln tail dim';
    const lastUser = [...S.events].reverse().find(e => e.k === 'user');
    const frames = ['|', '/', '-', '\\'];
    let f = 0;
    const tick = () => {
      const s = lastUser ? Math.max(0, Math.round((Date.now() - lastUser.ts) / 1000)) : 0;
      tail.textContent = `${frames[f++ % 4]} pracuju…${s >= 3 ? ` ${fmtDur(s * 1000)}` : ''}`;
    };
    tick();
    tailTimer = setInterval(tick, 150);
    return;
  }
  tail.className = 'ln tail';
  tail.append(el('span', 'ps', '~ $ '), document.createTextNode(inputEl.value), el('span', 'cursor'));
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

// ======================================================== skleněný pruh

function updatePill() {
  const p = pendingPerm();
  const choice = !!p && p.kind !== 'question';
  $('pillChoice').hidden = !choice;
  $('pillInput').hidden = choice;
  if (choice) {
    $('choiceLabel').textContent = p.kind === 'plan' ? 'Schválit plán?' : `${PERM_TITLE[p.tool] || p.tool}?`;
    $('alwaysBtn').hidden = p.kind === 'plan' || !p.canAlways;
    $('yesBtn').firstChild.textContent = p.kind === 'plan' ? 'Schválit ' : 'Povolit ';
    return;
  }
  const has = !!inputEl.value.trim();
  const running = !!S.meta?.running;
  let label = 'Mluv';
  let icon = ICON.mic;
  if (S.listening) { label = 'Hotovo'; icon = ICON.stop; }
  else if (has) { label = 'Spustit'; icon = ICON.enter; }
  else if (running) { label = 'Stop'; icon = ICON.stop; }
  $('actLabel').textContent = label;
  $('actIcon').innerHTML = icon;
  $('actBtn').classList.toggle('listening', S.listening);
  inputEl.placeholder = S.listening ? 'Poslouchám…'
    : p?.kind === 'question' ? 'Nebo napiš vlastní odpověď…'
      : running ? 'Napiš další pokyn…' : 'Řekni nebo napiš…';
}

function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, window.innerHeight * 0.3)}px`;
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
  updatePill();
  updateTail();
}

inputEl.addEventListener('input', () => {
  if (!inputEl.value.trim()) S.voiceDraft = false;
  autoGrow();
  updatePill();
  updateTail();
});
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
    e.preventDefault();
    sendText();
  }
});
$('actBtn').onclick = () => {
  if (S.listening) stopListening();
  else if (inputEl.value.trim()) sendText();
  else if (S.meta?.running) { if (S.sid) wsSend({ t: 'interrupt', sid: S.sid }); }
  else startListening();
};
const choose = d => { const p = pendingPerm(); if (p) decide(p, d); };
$('yesBtn').onclick = () => choose('allow');
$('noBtn').onclick = () => choose('deny');
$('alwaysBtn').onclick = () => choose('always');
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !$('pillChoice').hidden && e.target !== inputEl && !document.querySelector('dialog[open]')) {
    e.preventDefault();
    choose('allow');
  }
});

// ======================================================== hlas – rozpoznávání řeči

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let recFinal = '';
let recBase = '';

function setListening(on) {
  S.listening = on;
  updatePill();
  setBlobMode();
  if (on && !isMobile) blob.attachMic();
  if (!on) blob.detachMic();
}

function stopListening() { rec?.stop(); }

function startListening() {
  if (!window.isSecureContext) { toast('Mikrofon funguje jen přes https odkaz. Použij diktování na klávesnici.', true); return; }
  if (!SR) { toast('Tenhle prohlížeč neumí rozpoznávat řeč. Použij Chrome, nebo diktování na klávesnici.', true); return; }
  stopSpeaking();
  unlockAudio();
  rec = new SR();
  rec.lang = settings.lang;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  recBase = inputEl.value.trim() ? `${inputEl.value.trim()} ` : '';
  recFinal = '';
  rec.onsoundstart = () => blob.pulse(0.4);
  rec.onspeechstart = () => blob.pulse(0.5);
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
    blob.pulse(0.55);
    autoGrow();
    updateTail();
  };
  rec.onerror = e => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Přístup k mikrofonu je zakázaný. Povol ho v prohlížeči pro tuhle stránku.', true);
    else if (e.error === 'no-speech') toast('Nic jsem neslyšel.');
    else if (e.error === 'network') toast('Rozpoznávání řeči potřebuje internet.', true);
    else if (e.error !== 'aborted') toast(`Chyba rozpoznávání řeči: ${e.error}`, true);
  };
  rec.onend = () => {
    rec = null;
    setListening(false);
    if (settings.autoSend && recFinal.trim() && inputEl.value.trim()) sendText();
    else updateTail();
  };
  try {
    rec.start();
    setListening(true);
  } catch (err) {
    rec = null;
    toast(`Mikrofon nejde spustit: ${err.message}`, true);
  }
}

// ======================================================== hlas – předčítání

let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked || !('speechSynthesis' in window)) return;
  audioUnlocked = true;
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch {}
}
document.addEventListener('pointerdown', unlockAudio, { once: true });

function wantSpeech() {
  return 'speechSynthesis' in window && settings.speak === 'always';
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
  S.speaking = true;
  setBlobMode();
  chunks.forEach((c, i) => {
    const u = new SpeechSynthesisUtterance(c.trim());
    u.lang = settings.lang;
    u.rate = settings.rate;
    if (voice) u.voice = voice;
    u.onboundary = () => blob.pulse(0.45);
    if (i === chunks.length - 1) u.onend = u.onerror = () => { S.speaking = false; setBlobMode(); };
    speechSynthesis.speak(u);
  });
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
  S.speaking = false;
  setBlobMode();
}

function setBlobMode() {
  blob.setMode(S.listening ? 'listening' : S.speaking ? 'speaking' : S.meta?.running ? 'working' : 'idle');
}

// Zvuk Zap / Vyp pod plochou
function updateSeg() {
  for (const b of $('soundSeg').querySelectorAll('button')) {
    b.classList.toggle('on', (b.dataset.v === 'on') === (settings.speak === 'always'));
  }
}
for (const b of $('soundSeg').querySelectorAll('button')) {
  b.onclick = () => {
    settings.speak = b.dataset.v === 'on' ? 'always' : 'never';
    saveSettings();
    updateSeg();
    unlockAudio();
    if (settings.speak === 'never') stopSpeaking();
  };
}
updateSeg();

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
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 3000);
}
$('toast').onclick = () => { $('toast').hidden = true; };

const isNearBottom = () => body.scrollHeight - body.scrollTop - body.clientHeight < 80;
function scrollBottom(instant) {
  requestAnimationFrame(() => body.scrollTo({ top: body.scrollHeight, behavior: instant ? 'auto' : 'smooth' }));
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

function newQuick() {
  if ($('drawer').open) $('drawer').close();
  wsSend({ t: 'new', cwd: S.meta?.cwd || S.recent[0] || S.defaults.cwd });
  if (!isMobile) inputEl.focus();
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

$('settingsBtn').onclick = () => {
  if ($('drawer').open) $('drawer').close();
  $('setAsk').checked = S.mode !== 'bypassPermissions';
  $('setLang').value = settings.lang;
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
  showLogin('Odpojeno. Pro nové připojení otevři odkaz z počítače.');
};

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

$('actIcon').innerHTML = ICON.mic;
renderAll();
S.token = readToken();
if (S.token) connect(); else showLogin();
