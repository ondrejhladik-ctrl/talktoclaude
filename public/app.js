import { renderMarkdown, speakable } from './markdown.js';
import { createBlob } from './blob.js';
import { $, el, store, settings, saveSettings, S, toast, buzz, isMobile, deepMerge, DEFAULT_CFG, rid, timeAgo } from './core.js';
import { createLink } from './link.js';
import { parseIntent, describeEvents, fmtWhen, hhmm, phoneDigits } from './intents.js';
import { buildAction } from './phone.js';
import { initPanels } from './panels.js';

// Aplikaci nejde vložit do cizí stránky.
if (window.top !== window.self) document.documentElement.hidden = true;

const line = (cls, text) => el('div', `ln ${cls}`, text);
const short = (s, n = 60) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

const ASSISTANT = 'assistant';
const SUGGESTIONS = ['co je v téhle složce?', 'najdi v projektu chyby a oprav je', 'shrň, na čem jsem naposledy pracoval'];
const SUGG_ASSISTANT = ['napiš Petrovi na WhatsApp, že dorazím v pět', 'přidej do kalendáře zítra v 10 zubaře', 'otevři VS Code', 'co je nového?'];
const SUGG_PHONE = ['napiš Petrovi na WhatsApp, že dorazím v pět', 'přidej do kalendáře zítra v 10 zubaře', 'připomeň mi za 20 minut vypnout troubu', 'naviguj domů'];
const ICON = {
  mic: '<svg viewBox="0 0 24 24" width="15" height="15"><rect x="9" y="3.5" width="6" height="10.5" rx="3" fill="currentColor"/><path d="M5.8 11.2a6.2 6.2 0 0 0 12.4 0M12 17.4v3.1" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="12" height="12"><rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor"/></svg>',
  enter: '⏎',
};
const TOOL_LABEL = {
  Bash: 'příkaz', PowerShell: 'příkaz', Read: 'čtu', Write: 'zapisuju', Edit: 'upravuju', MultiEdit: 'upravuju',
  Glob: 'hledám soubory', Grep: 'hledám v textu', WebFetch: 'otevírám web', WebSearch: 'hledám na webu',
  Task: 'pomocník', Agent: 'pomocník', NotebookEdit: 'notebook', Skill: 'dovednost', ToolSearch: 'hledám nástroj',
};
const SKILL_LABEL = {
  send_message: 'zpráva', call_contact: 'hovor', open_on_phone: 'telefon', calendar_add: 'kalendář', calendar_list: 'kalendář',
  remind: 'připomínka', alert_user: 'upozornění', open_vscode: 'VS Code', open_on_pc: 'počítač', do_not_disturb: 'nerušit',
  start_coding_task: 'úkol pro Claude Code',
};
const PERM_TITLE = {
  Bash: 'Spustit příkaz', PowerShell: 'Spustit příkaz', Write: 'Zapsat soubor', Edit: 'Upravit soubor',
  MultiEdit: 'Upravit soubor', NotebookEdit: 'Upravit notebook', WebFetch: 'Otevřít web',
  WebSearch: 'Hledat na webu', Read: 'Přečíst soubor', Task: 'Spustit pomocníka', Agent: 'Spustit pomocníka',
};

Object.assign(S, { serverV: 0, assistantId: ASSISTANT, shownAlerts: new Set(), linkInfo: null, lastHeartbeat: null, heartbeatTimer: null });

const lines = $('lines');
const body = $('tBody');
const inputEl = $('input');
const blob = createBlob($('blobCanvas'));
const online = () => S.conn === 'online';
const hasSkills = () => online() && S.serverV >= 2;
const isAssistant = () => !S.meta || S.meta.kind === 'assistant';

// ======================================================== přihlášení

function readToken() {
  const h = new URLSearchParams(location.hash.slice(1));
  const t = h.get('t');
  if (t) {
    store.set('token', t);
    h.delete('t');
    const rest = h.toString();
    try { history.replaceState(null, '', location.pathname + location.search + (rest ? `#${rest}` : '')); } catch {}
    return t;
  }
  let v = store.get('token', null);
  if (typeof v !== 'string') {                 // starší verze ukládala kód bez uvozovek
    const raw = store.raw('token');
    v = raw && /^[0-9a-f]{16,}$/i.test(raw) ? raw : null;
    if (v) store.set('token', v);
  }
  return v;
}

function showLogin(msg) {
  $('app').hidden = true;
  $('login').hidden = false;
  if (msg) $('loginMsg').textContent = msg;
}

// ======================================================== spojení s počítačem

const link = createLink({
  getToken: () => S.token,
  onState: onLinkState,
  onMessage: handle,
  onAuthFail(kind) {
    link.stop();
    store.del('token');
    S.token = null;
    showLogin(kind === 'mismatch' ? 'Tenhle kód k počítači nepasuje. Otevři znovu odkaz z počítače.' : 'Neplatný kód. Otevři znovu odkaz z počítače.');
  },
});
S.link = link;

function onLinkState(info) {
  const prev = S.conn;
  S.conn = info.state;
  S.linkInfo = info;
  if (info.state !== 'online') S.flushRid = null;
  if (info.state === 'offline' && prev !== 'offline') {
    if (S.meta && !S.meta.local) { S.meta = { ...S.meta, running: false, pending: 0 }; }
    if (!S.meta || S.meta.kind === 'assistant') showAssistantLocal();
    clearLive();
  }
  // Stránka načtená přímo z adresy tunelu, která už neplatí → přejít na stálou adresu.
  if (!info.hosted && info.state === 'offline' && info.fails >= 3 && location.hostname.endsWith('.trycloudflare.com')) {
    const launcher = store.get('launcher', null);
    if (launcher) { location.replace(launcher); return; }
  }
  refresh();
  panels.onConn();
}

function wsSend(m, quiet) {
  if (link.send(m)) return true;
  if (!quiet) toast('Počítač teď není připojený.', true);
  return false;
}

function rememberLauncher(l) {
  try { if (l && new URL(l).hostname.endsWith('.github.io')) store.set('launcher', l); } catch {}
}

$('setupBtn').onclick = () => {
  const cfg = S.cfg;
  if (!cfg.watch?.mail?.on) {
    $('prioBtn').click();
  } else {
    $('pushBtn').click();
  }
};

function checkSetupGuide() {
  const cfg = S.cfg;
  const needsSetup = !cfg.watch?.mail?.on || pushState() !== 'on';
  
  if (needsSetup && !$('setupGuide').hidden) return;
  if (!needsSetup && $('setupGuide').hidden) return;
  
  $('setupGuide').hidden = !needsSetup;
  if (needsSetup) {
    let text = 'Pro plné funkce ';
    const parts = [];
    if (!cfg.watch?.mail?.on) parts.push('zapni <strong>hlídání e-mailů</strong>');
    const ps = pushState();
    if (ps !== 'on') {
      if (ps === 'unsupported') parts.push('přidej aplikaci na <strong>plochu</strong>');
      else if (ps === 'denied') parts.push('povol <strong>upozornění</strong>');
      else parts.push('zapni <strong>push upozornění</strong>');
    }
    text += parts.join(' a ');
    $('setupText').innerHTML = text + '.';
  }
}

function handle(m) {
  switch (m.t) {
    case 'init': onInit(m); break;
    case 'sessions':
      S.sessions = m.sessions;
      if (m.recent) S.recent = m.recent;
      renderSessions();
      updateHead();
      break;
    case 'meta': upsertMeta(m.session); break;
    case 'link': S.shareLink = m.link; rememberLauncher(m.link); break;
    case 'pc-heartbeat':
      // Sledování připojení PC - každých 10s by měla přijít zpráva
      S.lastHeartbeat = Date.now();
      // Pokud je to první heartbeat, inicializujeme timer
      if (!S.heartbeatTimer) {
        S.heartbeatTimer = setInterval(() => {
          // Pokud nejsou žádní klienti připojeni přes WebSocket
          if (S.conn !== 'online' && S.lastHeartbeat && Date.now() - S.lastHeartbeat > 15000) {
            // Po 15s bez heartbeat uvažujeme PC jako offline
            if (S.conn !== 'offline') {
              console.log('PC neodpovídá - odpojuji');
              onLinkState({ state: 'offline', fails: 1 });
            }
          }
        }, 1000);
      }
      break;
    case 'mode':
      S.auto = m.mode === 'bypassPermissions';
      store.set('auto', S.auto);
      updateAuto();
      toast(S.auto ? 'Automaticky: Claude dělá všechno bez ptaní.' : 'Claude se teď před akcemi ptá.');
      break;
    case 'session':
      showSession(m.session, m.events);
      if (m.session.id === S.assistantId) flushOffline();
      if (S.queued) { const q = S.queued; S.queued = null; wsSend({ t: 'send', sid: S.sid, ...q }); }
      break;
    case 'ev': if (m.sid === S.sid) onEvent(m.ev); break;
    case 'delta': if (m.sid === S.sid) onDelta(m); break;
    case 'ls': renderDirs(m); break;
    case 'deleted':
      if (m.sid === S.sid) {
        S.sid = null;
        wsSend({ t: 'open', sid: S.assistantId }, true);
      }
      break;
    case 'goto': wsSend({ t: 'open', sid: m.sid }, true); break;
    case 'skill-result': { const w = skillWaiters.get(m.rid); if (w) { skillWaiters.delete(m.rid); w(m); } break; }
    case 'logged': if (m.rid && m.rid === S.flushRid) { store.del('off'); S.flushRid = null; } break;
    case 'settings': S.cfg = deepMerge(DEFAULT_CFG, m.settings); store.set('cfg', S.cfg); panels.onCfg(); break;
    case 'watch-status': S.status = m; panels.onStatus(); break;
    case 'mail-test': panels.onMailTest(m); break;
    case 'mistral-test': panels.onMistralTest(m); break;
    case 'test-call': panels.onCallTest(m); break;
    case 'push-ok': panels.onPush(); break;
    case 'quick-model': S.quickModel = m.model; panels.onCfg(); break;
    case 'agenda': S.agenda = m.events || []; store.set('agenda', S.agenda); break;
    case 'alert': onAlert(m.item); if (m.unseen != null) setUnseen(m.unseen); break;
    case 'inbox': S.inbox.items = m.items || []; setUnseen(m.unseen || 0); panels.onInbox(); break;
    case 'inbox-count': setUnseen(m.unseen || 0); break;
    case 'phone': offerAction(m.action, { fromServer: true }); break;
    case 'phone-clear': dropAction(m.id); break;
    case 'qr': panels.onQr(m); break;
    case 'error': toast(m.message, true); break;
  }
}

function onInit(m) {
  S.serverV = m.v || 1;
  S.assistantId = m.assistant || ASSISTANT;
  S.sessions = m.sessions || [];
  S.recent = m.recent || [];
  S.defaults = m.defaults || {};
  S.shareLink = m.link || null;
  S.caps = m.caps || {};
  S.vapid = m.vapid || null;
  if (m.quickModel != null) S.quickModel = m.quickModel;
  rememberLauncher(S.shareLink);

  // co se změnilo v telefonu, když byl počítač pryč, má přednost
  const autoPending = store.get('autoPending', null);
  if (autoPending != null) {
    store.del('autoPending');
    S.auto = !!autoPending;
    if ((m.mode === 'bypassPermissions') !== S.auto) wsSend({ t: 'mode', mode: S.auto ? 'bypassPermissions' : 'default' }, true);
  } else if (m.mode) S.auto = m.mode === 'bypassPermissions';
  store.set('auto', S.auto);

  const cfgPending = store.get('cfgPending', null);
  if (m.settings) {
    S.cfg = deepMerge(DEFAULT_CFG, m.settings);
    if (cfgPending) { S.cfg = deepMerge(S.cfg, cfgPending); wsSend({ t: 'settings-set', patch: cfgPending }, true); store.del('cfgPending'); }
    store.set('cfg', S.cfg);
    checkSetupGuide();
  }
  if (Array.isArray(m.agenda)) { S.agenda = m.agenda; store.set('agenda', S.agenda); }
  setUnseen(m.inboxUnseen || 0);

  if (S.serverV >= 2) {
    flushOffline();
    for (const k of store.get('pendingSkills', [])) wsSend({ t: 'skill', sid: S.assistantId, id: k.id, args: k.args }, true);
    store.del('pendingSkills');
    clearLocalReminders();
    wsSend({ t: 'vis', visible: !document.hidden }, true);
    for (const a of m.phone || []) offerAction(a, { fromServer: true, quiet: true });
    resubscribePush();
  }

  renderSessions();
  const want = S.sid && S.sessions.some(s => s.id === S.sid) ? S.sid
    : S.sessions.some(s => s.id === S.assistantId) ? S.assistantId : S.sessions[0]?.id;
  if (want) wsSend({ t: 'open', sid: want }); else showSession(null, []);
  refresh();
  panels.onCfg();
}

// ======================================================== konverzace → terminál

const CACHE_KINDS = new Set(['user', 'text', 'quick', 'alert', 'result', 'info', 'error']);
const slim = ev => {
  const o = { k: ev.k, n: ev.n, ts: ev.ts };
  for (const key of ['text', 'voice', 'quick', 'id', 'ok', 'item', 'interrupted', 'ms', 'cost', 'subtype', 'cid', 'off']) if (ev[key] != null) o[key] = ev[key];
  if (typeof o.text === 'string' && o.text.length > 1500) o.text = `${o.text.slice(0, 1500)}…`;
  return o;
};
let cacheTimer = 0;
function cacheAssistant() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    if (S.sid !== S.assistantId || S.meta?.local) return;
    store.set('asst', S.events.filter(e => CACHE_KINDS.has(e.k)).slice(-120).map(slim));
  }, 600);
}

function showSession(meta, events) {
  S.sid = meta ? meta.id : null;
  store.set('sid', S.sid);
  S.meta = meta;
  S.events = events || [];
  if (meta && !meta.local) upsertMeta(meta, true);
  clearLive();
  renderAll();
  cacheAssistant();
}

// Asistent bez počítače: poslední známá historie + to, co se stalo offline.
function showAssistantLocal() {
  const seen = new Set();
  const events = [...store.get('asst', []), ...store.get('off', [])].filter(e => {
    const key = e.cid || `n${e.n}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  S.sid = S.assistantId;
  store.set('sid', S.sid);
  S.meta = { id: S.assistantId, kind: 'assistant', title: 'Asistent', local: true, running: false, pending: 0 };
  S.events = events;
  clearLive();
  renderAll();
}

// Co se stalo bez počítače, se po připojení dopíše do historie Asistenta na počítači.
function flushOffline() {
  const off = store.get('off', []);
  if (!off.length || S.flushRid || !hasSkills()) return;
  S.flushRid = rid();
  if (!wsSend({ t: 'log', sid: S.assistantId, events: off, rid: S.flushRid }, true)) S.flushRid = null;
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
  let text;
  if (isAssistant()) {
    text = S.conn === 'online' ? `asistent@${host} ~ rychlé úkoly` : S.conn === 'connecting' ? 'hledám počítač…' : 'asistent@telefon ~ bez počítače';
  } else {
    const folder = folderName(S.meta.cwd);
    text = S.conn === 'online' ? `claude@${host} ~ ${folder}` : S.conn === 'connecting' ? 'připojuji se k počítači…' : `odpojeno ~ ${folder}`;
  }
  $('tHead').textContent = text;
  $('conn').className = `conn ${S.conn}`;
  $('pcDot').className = `dot ${S.conn}`;
  $('pcLabel').textContent = S.conn === 'online' ? 'Počítač' : S.conn === 'connecting' ? 'Hledám…' : 'Bez počítače';
  const waiting = S.sessions.filter(s => s.id !== S.sid && s.pending > 0).length;
  $('menuBadge').hidden = !waiting;
  $('menuBadge').textContent = waiting;
}

function setUnseen(n) {
  S.inbox.unseen = n;
  $('inboxBadge').hidden = !n;
  $('inboxBadge').textContent = n > 99 ? '99+' : n;
}

function refresh() {
  updateHead();
  updateAuto();
  updatePill();
  updateTail();
  setBlobMode();
  updateWakeLock();
}

function renderIntro() {
  let head;
  let list;
  if (!isAssistant()) {
    head = ['# ahoj, tady Claude – pracuju přímo na tvém počítači', '# řekni nebo napiš, co mám udělat. třeba:'];
    list = SUGGESTIONS;
  } else if (S.conn === 'offline') {
    head = ['# počítač je teď offline – ovládám jen telefon', '# zprávy, hovory, kalendář, připomínky, navigace. třeba:'];
    list = SUGG_PHONE;
  } else {
    head = ['# ahoj, tady asistent – běžné věci vyřídím hned a skoro zadarmo', '# programování předám Claudovi na počítači. zkus třeba:'];
    list = SUGG_ASSISTANT;
  }
  for (const h of head) lines.append(line('dim', h));
  for (const s of list) {
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
  renderOutbox();
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
  $('outboxBox')?.remove();
  renderOutbox();
  if (ev.k === 'perm' && ev.status === 'pending') {
    buzz([80, 60, 80]);
    blob.pulse(0.6);
    if (wantSpeech()) say(ev.kind === 'question' ? 'Na něco se ptám.' : 'Potřebuju tvoje povolení.');
  }
  if (ev.k === 'quick') {
    blob.pulse(0.4);
    buzz(ev.ok === false ? [100, 50, 100] : [40]);
    if (wantSpeech() && ev.text) speak(ev.text);
  }
  if (ev.k === 'result') onTurnDone(ev);
  cacheAssistant();
  refresh();
  if (near || ev.k === 'user' || ev.k === 'perm' || ev.k === 'quick') scrollBottom();
}

function renderEvent(ev) {
  if (ev.k === 'tool_result') { attachResult(ev); return; }
  const node = buildNode(ev);
  if (!node) return;
  S.nodes.set(ev.n, node);
  lines.appendChild(node);
}

const fmtDur = ms => (ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);
const fmtCost = c => (c < 0.005 ? 'méně než 1 ¢' : c < 1 ? `≈ ${Math.round(c * 100)} ¢` : `≈ $${c.toFixed(2)}`);
const shortPath = p => (typeof p === 'string' ? p.replace(/^.*[\\/](?=[^\\/]+[\\/][^\\/]+$)/, '…/') : '');

function alertHead(item) {
  if (item.source === 'mail') return `E-mail · ${item.from}`;
  if (item.source === 'notif') return `${item.app} · ${item.from}`;
  if (item.source === 'reminder') return item.title || 'Připomínka';
  if (item.source === 'calendar') return item.title || 'Kalendář';
  if (item.source === 'claude') return 'Claude';
  return item.from || item.title || 'Upozornění';
}
const alertBody = item => (item.source === 'reminder' || item.source === 'calendar' ? item.text : [item.title, item.text].filter(Boolean).join(' — ')) || '';

function buildNode(ev) {
  switch (ev.k) {
    case 'user': {
      const d = line(`cmd${ev.quick ? ' quick' : ''}${ev.off ? ' off' : ''}`);
      d.append(el('span', 'ps', ev.quick ? '⚡ ' : '~ $ '), document.createTextNode(ev.text));
      if (ev.voice) d.append(el('span', 'dim', '  🎤'));
      return d;
    }
    case 'text': {
      const d = el('div', 'ln out md');
      d.innerHTML = renderMarkdown(ev.text);
      return d;
    }
    case 'quick': return line(ev.ok === false ? 'quick-bad' : 'quick-ok', `${ev.ok === false ? '✗' : '✓'} ${ev.text}`);
    case 'alert': {
      const it = ev.item || {};
      const d = line('alert');
      d.append(el('b', '', `${it.action === 'call' ? '☎' : '★'} ${alertHead(it)}`), el('span', 'dim', `  ${short(alertBody(it), 90)}`));
      d.onclick = () => ring(it, { silent: true });
      return d;
    }
    case 'tool': return buildTool(ev);
    case 'perm': return buildPerm(ev);
    case 'result':
      if (ev.interrupted) return line('dim', '■ přerušeno');
      if (ev.ok) return line('dim', `✓ hotovo${ev.ms ? ` · ${fmtDur(ev.ms)}` : ''}${ev.cost ? ` · ${fmtCost(ev.cost)}` : ''}`);
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
    default:
      if (name.startsWith('mcp__ttc__')) return short([inp.to, inp.title, inp.text, inp.query, inp.target, inp.folder, inp.task].filter(Boolean).join(' · '), 70);
      return name.startsWith('mcp__') ? name.split('__').slice(1).join(' · ') : '';
  }
}

const toolLabel = name => TOOL_LABEL[name] || (name.startsWith('mcp__ttc__') ? SKILL_LABEL[name.slice(10)] || name.slice(10) : name);

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
  d.append(`→ ${toolLabel(ev.name)}  ${toolSummary(ev.name, ev.input) || ''}`, el('span', 'st'));
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
    if (e.k === 'perm' && e.status === 'pending') return online() ? e : null;
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
  const running = !!S.meta?.running && online();
  if (pendingPerm() || (running && S.liveText)) { tail.hidden = true; return; }
  tail.hidden = false;
  if (running) {
    tail.className = 'ln tail dim';
    const lastUser = [...S.events].reverse().find(e => e.k === 'user' && !e.quick);
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

// ======================================================== povely: rychlé × Claude

const skillWaiters = new Map();

// Rychlý povel vyřízený počítačem (bez Clauda). Server ho zapíše do konverzace a vrátí výsledek.
function pcSkill(id, args, text, voice) {
  return new Promise(resolve => {
    const r = rid();
    const timer = setTimeout(() => { skillWaiters.delete(r); resolve(null); }, 20000);
    skillWaiters.set(r, res => { clearTimeout(timer); resolve(res); });
    const sid = S.meta && !S.meta.local ? S.sid : S.assistantId;
    if (!wsSend({ t: 'skill', sid, id, args, text, voice, rid: r })) { clearTimeout(timer); skillWaiters.delete(r); resolve(null); }
  });
}

// Zápis do konverzace z telefonu (povel vyřízený tady). S počítačem ho uloží server, bez něj místní historie.
function emitQuick(events) {
  const evs = events.map(e => ({ ...e, cid: rid(), ts: Date.now() }));
  if (hasSkills() && S.sid && S.meta && !S.meta.local && wsSend({ t: 'log', sid: S.sid, events: evs }, true)) return;
  if (!S.meta || !S.meta.local) showAssistantLocal();
  const off = store.get('off', []);
  for (const e of evs) {
    e.off = true;
    e.n = `o-${e.cid}`;
    if (e.k === 'user') e.quick = true;
    off.push(e);
    onEvent(e);
  }
  store.set('off', off.slice(-200));
}

function queueSkill(id, args) {
  const q = store.get('pendingSkills', []);
  q.push({ id, args, ts: Date.now() });
  store.set('pendingSkills', q.slice(-50));
}

function saveCfg(patch) {
  S.cfg = deepMerge(S.cfg, patch);
  store.set('cfg', S.cfg);
  if (online() && wsSend({ t: 'settings-set', patch }, true)) return true;
  store.set('cfgPending', deepMerge(store.get('cfgPending', {}), patch));
  return false;
}

function setAuto(on) {
  S.auto = !!on;
  store.set('auto', S.auto);
  updateAuto();
  if (!(online() && wsSend({ t: 'mode', mode: S.auto ? 'bypassPermissions' : 'default' }, true))) {
    store.set('autoPending', S.auto);
    toast(S.auto ? 'Automaticky zapnuto. Na počítači začne platit, až se připojí.' : 'Automaticky vypnuto.');
  }
}

function updateAuto() {
  for (const b of $('autoSeg').querySelectorAll('button')) b.classList.toggle('on', (b.dataset.v === 'on') === S.auto);
  $('autoSeg').classList.toggle('auto-on', S.auto);
}
for (const b of $('autoSeg').querySelectorAll('button')) b.onclick = () => { unlockAudio(); setAuto(b.dataset.v === 'on'); };

// Povel pro Clauda. Bez počítače se odloží a po připojení nabídne k odeslání.
function toClaude(text, voice) {
  if (!online()) {
    const out = store.get('outbox', []);
    out.push({ text, voice, sid: S.meta && !S.meta.local ? S.sid : S.assistantId, ts: Date.now() });
    store.set('outbox', out.slice(-20));
    emitQuick([{ k: 'user', text, voice }, { k: 'info', text: 'Počítač je offline. Tohle umí jen Claude na počítači – nechám si to a po připojení ti nabídnu odeslání.' }]);
    if (wantSpeech()) say('Počítač je offline. Nechám si to na potom.');
    return;
  }
  if (!S.sid || !S.meta || S.meta.local) {
    // zatím není otevřená žádná konverzace na počítači → otevřít Asistenta (u staršího serveru první / novou)
    S.queued = { text, voice };
    const target = S.sessions.some(s => s.id === S.assistantId) ? { t: 'open', sid: S.assistantId }
      : S.sessions[0] ? { t: 'open', sid: S.sessions[0].id } : { t: 'new', cwd: S.recent[0] || S.defaults.cwd };
    if (!wsSend(target)) S.queued = null;
    return;
  }
  wsSend({ t: 'send', sid: S.sid, text, voice });
}

function toSession(sid, text, voice) {
  if (sid === S.sid && S.meta && !S.meta.local) { wsSend({ t: 'send', sid, text, voice }); return; }
  S.queued = { text, voice };
  const target = S.sessions.some(s => s.id === sid) ? sid : S.assistantId;
  if (!wsSend({ t: 'open', sid: target })) S.queued = null;
}

// Odložené povely z doby bez počítače – odeslat, nebo zahodit.
function renderOutbox() {
  $('outboxBox')?.remove();
  const items = store.get('outbox', []);
  if (!items.length || !online()) return;
  const box = el('div');
  box.id = 'outboxBox';
  box.append(line('ask', `? ${items.length === 1 ? 'čeká 1 povel' : `čeká povelů: ${items.length}`} z doby bez počítače – odeslat Claudovi?`));
  items.forEach(it => {
    const row = el('div', 'opts');
    const go = el('button', 'opt', `odeslat: ${short(it.text, 44)}`);
    const no = el('button', 'opt', 'zahodit');
    const drop = () => { store.set('outbox', store.get('outbox', []).filter(x => x.ts !== it.ts)); renderOutbox(); };
    go.onclick = () => { drop(); toSession(it.sid, it.text, it.voice); };
    no.onclick = drop;
    row.append(go, no);
    box.append(row);
  });
  lines.append(box);
}

function dispatch(text, voice) {
  if (!pendingPerm()) {
    const intent = parseIntent(text, {
      people: S.cfg.people, messenger: S.cfg.skills.messenger,
      strict: online() && !isAssistant(),
    });
    if (intent) {
      if (intent.id === 'claude') { toClaude(intent.args.text, voice); return; }
      // „napiš mu, ať…“ potřebuje přeformulovat → levný model Asistenta (když je počítač po ruce)
      if (intent.args.rephrase && hasSkills()) { toSession(S.assistantId, text, voice); return; }
      runIntent(intent, text, voice).catch(e => toast(e.message || String(e), true));
      return;
    }
  }
  toClaude(text, voice);
}

async function runIntent(intent, text, voice) {
  const { id, args } = intent;
  const reply = (msg, ok = true) => emitQuick([{ k: 'user', text, voice }, { k: 'quick', id, ok, text: msg }]);
  const needPc = () => reply('Počítač je teď offline – tohle umí jen on.', false);
  if (intent.need) { reply(intent.need, false); return; }
  switch (id) {
    case 'help': panels.openHelp(); return;
    case 'time': reply(`Je ${hhmm(new Date())}.`); return;
    case 'date': reply(`Dnes je ${new Date().toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.`); return;
    case 'auto':
      setAuto(args.on);
      reply(args.on ? 'Automatický režim je zapnutý – Claude dělá všechno bez ptaní.' : 'Automatický režim je vypnutý – Claude se před akcemi ptá.');
      return;
    case 'snooze':
      if (hasSkills()) { await pcSkill('snooze', args, text, voice); return; }
      saveCfg({ snoozeUntil: args.minutes > 0 ? Date.now() + args.minutes * 60000 : 0 });
      reply(args.minutes > 0 ? `Dobře, do ${hhmm(new Date(Date.now() + args.minutes * 60000))} tě nebudu rušit.` : 'Dobře, zase ti dám vědět o všem důležitém.');
      return;
    case 'inbox':
      if (hasSkills()) { await pcSkill('inbox', {}, text, voice); return; }
      reply('Počítač je offline, takže zprávy teď nehlídám. Starší upozornění najdeš v Přehledu.', false);
      return;
    case 'vscode': case 'pc_open':
      if (hasSkills()) await pcSkill(id, args, text, voice); else needPc();
      return;
    case 'calendar_list': {
      if (hasSkills()) { await pcSkill('calendar_list', args, text, voice); return; }
      const a = Number(new Date(args.from));
      const b = Number(new Date(args.to));
      const evs = S.agenda.filter(e => e.start < b && (e.end ?? (e.allDay ? e.start + 86400000 : e.start)) >= a).sort((x, y) => x.start - y.start);
      reply(`${describeEvents(evs, a, b, args.label)} (Podle posledního spojení s počítačem.)`);
      return;
    }
    case 'calendar_add': {
      const event = { title: args.title || 'Událost', start: args.start, end: args.end, allDay: !!args.allDay };
      if (hasSkills()) {
        const res = await pcSkill('calendar_add', event, text, voice);
        if (res?.ok) offerAction({ kind: 'calendar', event: res.data?.event || event }, { optional: true });
        return;
      }
      queueSkill('calendar_add', event);
      S.agenda.push({ id: rid(), title: event.title, start: Number(new Date(event.start)), end: event.end ? Number(new Date(event.end)) : null, allDay: event.allDay, source: 'own' });
      store.set('agenda', S.agenda);
      reply(`Zapsáno: ${event.title}, ${fmtWhen(new Date(event.start), event.allDay)}.${online() ? '' : ' Do počítače to doplním, až se připojí.'}`);
      offerAction({ kind: 'calendar', event }, { optional: true });
      return;
    }
    case 'remind': {
      if (hasSkills()) { await pcSkill('remind', { at: args.at, text: args.text }, text, voice); return; }
      queueSkill('remind', { at: args.at, text: args.text });
      addLocalReminder({ id: rid(), at: args.atMs, text: args.text });
      reply(`Připomenu ti ${fmtWhen(new Date(args.atMs))}: ${args.text}. Bez počítače to zazní jen při otevřené aplikaci.`);
      return;
    }
    default: phoneIntent(intent, text, voice);
  }
}

// Povely, které dokončí telefon: zpráva, hovor, navigace, hledání.
function phoneIntent({ id, args }, text, voice) {
  const cc = S.cfg.skills.countryCode;
  const p = args.person;
  let action;
  if (id === 'whatsapp' || id === 'sms') action = { kind: id, to: args.to, number: p ? phoneDigits(p.phone, cc) : '', text: args.text };
  else if (id === 'mail') action = { kind: 'mail', to: args.to, email: p?.email && !p.email.startsWith('@') ? p.email : '', text: args.text };
  else if (id === 'call') action = { kind: 'call', to: args.to, number: phoneDigits(args.number || p?.phone || '', cc) };
  else action = { kind: id, query: args.destination || args.query };
  const reply = (msg, ok = true) => emitQuick([{ k: 'user', text, voice }, { k: 'quick', id, ok, text: msg }]);
  const built = buildAction(action, { calendarMode: S.cfg.skills.calendarPhone });
  if (!built) { reply(`${args.to || 'Kontakt'} nemá uložené telefonní číslo. Doplň ho v Nastavení → Lidé.`, false); return; }
  const res = offerAction(action, { silent: true });
  const note = id === 'whatsapp' && !action.number ? ` ${args.to} nemám v kontaktech – příjemce vybereš ve WhatsAppu.` : '';
  reply(res === 'opened' ? `Otevírám – ${built.log}.` : `Připraveno – ${built.log}. Klepni na ${built.go}.${note}`);
}

// ---------------- akce čekající na klepnutí

function openNow(b) {
  try {
    if (b.blank) {
      const w = window.open(b.href, '_blank');
      if (!w) return false;
      try { w.opener = null; } catch {}
      return true;
    }
    location.href = b.href;
    return true;
  } catch { return false; }
}

function offerAction(action, { fromServer = false, optional = false, silent = false, quiet = false } = {}) {
  if (!action || (action.id && S.actions.some(x => x.action.id === action.id))) return false;
  const built = buildAction(action, { calendarMode: S.cfg.skills.calendarPhone });
  if (!built) { if (fromServer && action.id) wsSend({ t: 'phone-done', id: action.id }, true); return false; }
  const entry = { action, built, fromServer, optional: optional || !!action.optional };
  // Automaticky: když to prohlížeč dovolí (čerstvé klepnutí), otevřít rovnou
  if (S.auto && built.href && !entry.optional && navigator.userActivation?.isActive && openNow(built)) {
    finishAction(entry, 'opened', true);
    return 'opened';
  }
  S.actions.push(entry);
  updatePill();
  if (!quiet && !silent) { buzz([60, 40, 60]); blob.pulse(0.5); }
  return 'queued';
}

function dropAction(id) {
  const n = S.actions.length;
  S.actions = S.actions.filter(x => x.action.id !== id);
  if (S.actions.length !== n) updatePill();
}

function finishAction(entry, result, notQueued) {
  if (!notQueued) S.actions = S.actions.filter(x => x !== entry);
  if (entry.action.id && entry.fromServer) wsSend({ t: 'phone-done', id: entry.action.id, result }, true);
  if (result === 'dismissed' && !entry.optional) emitQuick([{ k: 'info', text: `zrušeno: ${entry.built.log}` }]);
  if (result === 'opened' && entry.fromServer && !entry.optional) emitQuick([{ k: 'info', text: `otevřeno: ${entry.built.log}` }]);
  updatePill();
}

$('actionGo').addEventListener('click', e => {
  const entry = S.actions[0];
  if (!entry) { e.preventDefault(); return; }
  unlockAudio();
  if (entry.built.run) {
    e.preventDefault();
    entry.built.run().then(ok => { if (ok !== false) finishAction(entry, 'opened'); }).catch(() => toast('Nepodařilo se předat událost kalendáři.', true));
    return;
  }
  // necháme prohlížeč odkaz otevřít sám (skutečné klepnutí = spolehlivé předání aplikaci) a akci uzavřeme
  setTimeout(() => finishAction(entry, 'opened'), 300);
});
$('actionNo').onclick = () => { const entry = S.actions[0]; if (entry) finishAction(entry, 'dismissed'); };

// ---------------- připomínky bez počítače (jen při otevřené aplikaci)

const localTimers = new Map();
function addLocalReminder(r) {
  const list = store.get('localRem', []);
  list.push(r);
  store.set('localRem', list.slice(-50));
  armLocalReminder(r);
}
function armLocalReminder(r) {
  const fire = () => {
    localTimers.delete(r.id);
    store.set('localRem', store.get('localRem', []).filter(x => x.id !== r.id));
    store.set('pendingSkills', store.get('pendingSkills', []).filter(k => !(k.id === 'remind' && k.args.text === r.text)));
    onAlert({ id: `local-${r.id}`, source: 'reminder', app: 'Připomínka', from: 'Připomínka', title: r.text, text: '', action: 'call', level: 'important', say: `Připomínka: ${r.text}`, ts: Date.now() });
  };
  const wait = r.at - Date.now();
  if (wait <= 0) { fire(); return; }
  localTimers.set(r.id, setTimeout(fire, Math.min(wait, 2 ** 31 - 1)));
}
function clearLocalReminders() {
  for (const t of localTimers.values()) clearTimeout(t);
  localTimers.clear();
  store.del('localRem');
}

// ======================================================== upozornění a „hovor“

function onAlert(item) {
  if (!item || !item.id || S.shownAlerts.has(item.id)) return;
  S.shownAlerts.add(item.id);
  S.inbox.items.unshift(item);
  if (S.inbox.items.length > 200) S.inbox.items.length = 200;
  panels.onInbox();
  if (item.action === 'call') ring(item);
  else if (item.action === 'notify') {
    toast(`${alertHead(item)}: ${short(alertBody(item), 80)}`);
    buzz([60, 40, 60]);
    blob.pulse(0.6);
  }
}

// Upozornění doručené přes push. `clicked` = uživatel klepnul na oznámení (aplikace byla zavřená nebo na pozadí).
function onPushPayload(p, clicked) {
  if (!p || typeof p !== 'object') return;
  if (p.type === 'perm' && p.sid) {
    if (!clicked) return;
    S.sid = p.sid;
    store.set('sid', p.sid);
    if (online()) wsSend({ t: 'open', sid: p.sid }, true);
    return;
  }
  if (p.type !== 'alert') return;
  const item = { id: p.id, action: p.kind, level: 'important', source: 'push', app: '', from: p.title, title: '', text: p.body, say: p.say, ts: p.ts || Date.now() };
  if (!S.shownAlerts.has(p.id)) { onAlert(item); return; }
  // už jsme ho ukázali přes živé spojení; po klepnutí na oznámení ho jen znovu otevři (bez zvonění)
  if (clicked && !ringing) ring(S.inbox.items.find(i => i.id === p.id) || item, { silent: true });
}

let tone = null;
let audioCtx = null;
function startTone() {
  stopTone();
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    gain.connect(audioCtx.destination);
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.connect(gain);
    const t0 = audioCtx.currentTime + 0.05;
    for (let i = 0; i < 12; i++) {          // dvojité „crrr-crrr“, pauza
      const at = t0 + i * 1.3;
      for (const [off, f] of [[0, 880], [0.28, 1046]]) {
        osc.frequency.setValueAtTime(f, at + off);
        gain.gain.setValueAtTime(0, at + off);
        gain.gain.linearRampToValueAtTime(0.16, at + off + 0.03);
        gain.gain.setValueAtTime(0.16, at + off + 0.2);
        gain.gain.linearRampToValueAtTime(0, at + off + 0.25);
      }
    }
    osc.start(t0);
    osc.stop(t0 + 16);
    tone = { osc, gain };
  } catch { tone = null; }
}
function stopTone() {
  if (!tone) return;
  try { tone.gain.gain.cancelScheduledValues(0); tone.gain.gain.value = 0; tone.osc.stop(); } catch {}
  try { tone.gain.disconnect(); } catch {}
  tone = null;
}

let ringing = null;
function ring(item, { silent = false } = {}) {
  stopRing(true);
  $('callKind').textContent = item.source === 'reminder' ? 'Připomínka' : item.source === 'calendar' ? 'Kalendář' : silent ? 'Upozornění' : 'Claude volá';
  $('callTitle').textContent = alertHead(item);
  $('callText').textContent = alertBody(item);
  $('callListen').textContent = 'Poslechnout';
  ringing = { item, timers: [] };
  if (!$('call').open) $('call').showModal();
  if (silent) return;
  $('call').classList.add('ringing');
  startTone();
  if (settings.vibrate && navigator.vibrate) { try { navigator.vibrate([500, 250, 500, 800, 500, 250, 500]); } catch {} }
  blob.pulse(1);
  // po dvou zazvoněních přečíst nahlas (když je zapnutý zvuk), jinak jen zvonit
  ringing.timers.push(setTimeout(() => {
    if (!wantSpeech()) return;
    stopTone();
    $('call').classList.remove('ringing');
    speakItem(item);
  }, 2700));
  ringing.timers.push(setTimeout(() => { stopTone(); $('call').classList.remove('ringing'); }, 20000));
}

function speakItem(item) {
  const text = item.say || [alertHead(item), alertBody(item)].filter(Boolean).join('. ');
  $('callListen').textContent = 'Přečíst znovu';
  say(speakable(text) || text);
}

function stopRing(keepSpeech) {
  if (ringing) {
    ringing.timers.forEach(clearTimeout);
    if (ringing.item.id && !String(ringing.item.id).startsWith('local-')) wsSend({ t: 'inbox-seen', ids: [ringing.item.id] }, true);
  }
  ringing = null;
  stopTone();
  if (navigator.vibrate) { try { navigator.vibrate(0); } catch {} }
  if (!keepSpeech) stopSpeaking();
  $('call').classList.remove('ringing');
  if ($('call').open) $('call').close();
}
$('callClose').onclick = () => stopRing(false);
$('call').addEventListener('close', () => { if (ringing) stopRing(false); });   // zavření klepnutím vedle nebo klávesou Esc
$('callListen').onclick = () => {
  if (!ringing) return;
  unlockAudio();
  ringing.timers.forEach(clearTimeout);
  stopTone();
  $('call').classList.remove('ringing');
  speakItem(ringing.item);
};

// ======================================================== skleněný pruh

function updatePill() {
  const p = pendingPerm();
  const choice = !!p && p.kind !== 'question';
  const act = !choice && S.actions[0];
  $('pillChoice').hidden = !choice;
  $('pillAction').hidden = !act;
  $('pillInput').hidden = choice || !!act;
  if (choice) {
    $('choiceLabel').textContent = p.kind === 'plan' ? 'Schválit plán?' : `${PERM_TITLE[p.tool] || p.tool}?`;
    $('alwaysBtn').hidden = p.kind === 'plan' || !p.canAlways;
    $('yesBtn').firstChild.textContent = p.kind === 'plan' ? 'Schválit ' : 'Povolit ';
    return;
  }
  if (act) {
    const go = $('actionGo');
    $('actionLabel').textContent = act.built.label;
    $('actionLabel').title = act.built.detail || '';
    go.firstChild.textContent = `${act.built.go} `;
    if (act.built.href) {
      go.href = act.built.href;
      if (act.built.blank) go.target = '_blank'; else go.removeAttribute('target');
    } else {
      go.removeAttribute('href');
      go.removeAttribute('target');
      go.setAttribute('role', 'button');
      go.tabIndex = 0;
    }
    $('actionNo').textContent = act.optional ? 'Ne' : 'Zrušit';
    return;
  }
  const has = !!inputEl.value.trim();
  const running = !!S.meta?.running && online();
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
  S.voiceDraft = false;
  inputEl.value = '';
  autoGrow();
  updatePill();
  updateTail();
  dispatch(text, voice);
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
  else if (S.meta?.running && online()) { if (S.sid) wsSend({ t: 'interrupt', sid: S.sid }); }
  else startListening();
};
const choose = d => { const p = pendingPerm(); if (p) decide(p, d); };
$('yesBtn').onclick = () => choose('allow');
$('noBtn').onclick = () => choose('deny');
$('alwaysBtn').onclick = () => choose('always');
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.target === inputEl || document.querySelector('dialog[open]')) return;
  if (!$('pillChoice').hidden) { e.preventDefault(); choose('allow'); }
  else if (!$('pillAction').hidden && e.target !== $('actionGo')) { e.preventDefault(); $('actionGo').click(); }
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
  if (!('speechSynthesis' in window) || !text) return;
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
  blob.setMode(S.listening ? 'listening' : S.speaking ? 'speaking' : S.meta?.running && online() ? 'working' : 'idle');
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

let wakeLock = null;
async function updateWakeLock() {
  const want = settings.wakeLock && !!S.meta?.running && online() && !document.hidden;
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

$('toast').onclick = () => { $('toast').hidden = true; };

const isNearBottom = () => body.scrollHeight - body.scrollTop - body.clientHeight < 80;
function scrollBottom(instant) {
  requestAnimationFrame(() => body.scrollTo({ top: body.scrollHeight, behavior: instant ? 'auto' : 'smooth' }));
}

$('pcChip').onclick = () => {
  link.checkNow();
  const i = S.linkInfo || {};
  if (S.conn === 'online') toast('Počítač je připojený. Spojení hlídám každých 10 sekund.');
  else if (S.conn === 'connecting') toast('Hledám počítač…');
  else toast(`Počítač je offline${i.lastOk ? ` (naposledy ${timeAgo(i.lastOk)})` : ''}. Ovládám jen telefon a každých 10 s zkouším spojení.`);
};

// ======================================================== dialogy: konverzace, složky

for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', e => { if (e.target === d) d.close(); });
  d.querySelectorAll('[data-close]').forEach(b => { b.onclick = () => d.close(); });
}

$('menuBtn').onclick = () => { renderSessions(); $('drawer').showModal(); };

function renderSessions() {
  const box = $('sessList');
  box.textContent = '';
  const list = S.sessions.length ? S.sessions : [{ id: S.assistantId, kind: 'assistant', title: 'Asistent', updatedAt: Date.now() }];
  for (const s of list) {
    const assistantRow = s.kind === 'assistant';
    const row = el('div', `sess${s.id === S.sid ? ' active' : ''}`);
    const main = el('button', 'sess-main');
    main.append(
      el('div', 'sess-title', assistantRow ? '⚡ Asistent' : s.title),
      el('div', 'sess-sub', assistantRow ? 'rychlé úkoly, telefon, upozornění' : `${folderName(s.cwd)} · ${timeAgo(s.updatedAt)}`),
    );
    main.onclick = () => {
      $('drawer').close();
      if (!online()) { if (assistantRow) showAssistantLocal(); else toast('Počítač je offline – tahle konverzace bude dostupná po připojení.', true); return; }
      if (s.id !== S.sid || S.meta?.local) wsSend({ t: 'open', sid: s.id });
    };
    row.appendChild(main);
    if (s.pending) row.appendChild(el('span', 'sess-flag wait', 'čeká'));
    else if (s.running) row.appendChild(el('span', 'sess-flag run', '●'));
    if (online()) {
      const del = el('button', 'sess-del', '✕');
      del.setAttribute('aria-label', assistantRow ? 'Vyčistit historii' : 'Smazat konverzaci');
      del.onclick = () => {
        if (del.classList.contains('confirm')) { wsSend({ t: 'delete', sid: s.id }); if (assistantRow) { store.del('asst'); store.del('off'); } return; }
        del.classList.add('confirm');
        del.textContent = assistantRow ? 'Vyčistit?' : 'Smazat?';
        setTimeout(() => { del.classList.remove('confirm'); del.textContent = '✕'; }, 3000);
      };
      row.appendChild(del);
    }
    box.appendChild(row);
  }
  if (!online()) box.appendChild(el('div', 'sess-empty', 'Počítač je offline. Konverzace nad projekty se ukážou po připojení.'));
}

const projectCwd = () => (S.meta && S.meta.kind !== 'assistant' && S.meta.cwd) || S.recent[0] || S.defaults.cwd;

function newQuick() {
  if ($('drawer').open) $('drawer').close();
  if (!wsSend({ t: 'new', cwd: projectCwd() })) return;
  if (!isMobile) inputEl.focus();
}
$('newBtn').onclick = newQuick;
$('newQuickBtn').onclick = newQuick;

$('newFolderBtn').onclick = () => {
  if (!online()) { toast('Počítač teď není připojený.', true); return; }
  $('drawer').close();
  const chips = $('recent');
  chips.textContent = '';
  for (const p of S.recent) {
    const b = el('button', '', folderName(p));
    b.title = p;
    b.onclick = () => browse(p);
    chips.appendChild(b);
  }
  browse(projectCwd());
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

// ======================================================== upozornění do telefonu (push)

let swReg = null;
const b64u = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));
const sameKey = (buf, key) => {
  if (!buf) return false;
  const a = new Uint8Array(buf);
  const b = b64u(key);
  return a.length === b.length && a.every((v, i) => v === b[i]);
};

async function registerSW() {
  if (!('serviceWorker' in navigator) || location.hostname.endsWith('.trycloudflare.com')) return;
  try {
    swReg = await navigator.serviceWorker.register('sw.js');
    navigator.serviceWorker.addEventListener('message', e => { if (e.data?.type === 'push') onPushPayload(e.data.payload, !!e.data.clicked); });
  } catch (e) { console.warn('Service worker nejde zaregistrovat:', e); }
}

const pushSupported = () => !!swReg && 'PushManager' in window && 'Notification' in window;

async function pushState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const sub = await swReg.pushManager.getSubscription().catch(() => null);
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

async function enablePush() {
  if (!pushSupported()) throw new Error(/iPhone|iPad/.test(navigator.userAgent) ? 'Na iPhonu si nejdřív přidej aplikaci na plochu (Sdílet → Přidat na plochu) a otevři ji odtud.' : 'Tenhle prohlížeč upozornění neumí.');
  if (!S.vapid || !online()) throw new Error('Upozornění jdou zapnout, jen když je počítač připojený.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Upozornění jsou v prohlížeči zakázaná. Povol je pro tuhle stránku.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options?.applicationServerKey, S.vapid)) { await sub.unsubscribe().catch(() => {}); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(S.vapid) });
  wsSend({ t: 'push-sub', sub: sub.toJSON() });
}

async function disablePush() {
  const sub = await swReg?.pushManager.getSubscription().catch(() => null);
  if (!sub) return;
  wsSend({ t: 'push-unsub', endpoint: sub.endpoint }, true);
  await sub.unsubscribe().catch(() => {});
}

// Po každém připojení připomeň počítači, kam posílat upozornění (klíče se mohly změnit).
async function resubscribePush() {
  try {
    if (!pushSupported() || Notification.permission !== 'granted' || !S.vapid) return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    if (!sameKey(sub.options?.applicationServerKey, S.vapid)) {
      await sub.unsubscribe().catch(() => {});
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(S.vapid) });
    }
    wsSend({ t: 'push-sub', sub: sub.toJSON() }, true);
  } catch {}
}

// ======================================================== start

const panels = initPanels({
  send: wsSend, saveCfg, say, sendText, pushState, enablePush, disablePush, ring,
  showLogin, alertHead, alertBody,
  logout() {
    link.stop();
    store.del('token');
    store.del('sid');
    S.token = null;
    try { history.replaceState(null, '', location.pathname); } catch {}
    showLogin('Odpojeno. Pro nové připojení otevři odkaz z počítače.');
  },
});

$('tokenBtn').onclick = () => {
  const raw = $('tokenInput').value.trim();
  if (!raw) return;
  const m = raw.match(/[#?&]t=([0-9a-f]+)/i);
  S.token = m ? m[1] : raw;
  store.set('token', S.token);
  $('login').hidden = true;
  $('app').hidden = false;
  link.start();
};

if (window.visualViewport) {
  const fit = () => document.documentElement.style.setProperty('--app-h', `${window.visualViewport.height}px`);
  window.visualViewport.addEventListener('resize', fit);
  fit();
}

document.addEventListener('visibilitychange', () => {
  updateWakeLock();
  if (online()) wsSend({ t: 'vis', visible: !document.hidden }, true);
});

// Upozornění, na které uživatel klepnul, když byla aplikace zavřená (#n=…)
function readPushHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const n = h.get('n');
  if (!n) return;
  h.delete('n');
  const rest = h.toString();
  try { history.replaceState(null, '', location.pathname + location.search + (rest ? `#${rest}` : '')); } catch {}
  try { onPushPayload(JSON.parse(n), true); } catch {}
}

$('actIcon').innerHTML = ICON.mic;
S.token = readToken();
for (const r of store.get('localRem', [])) armLocalReminder(r);
if (S.sid === S.assistantId || !S.sid) showAssistantLocal(); else renderAll();
registerSW();
if (S.token) { link.start(); readPushHash(); } else showLogin();
