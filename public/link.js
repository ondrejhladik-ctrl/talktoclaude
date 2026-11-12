// Spojení s počítačem. Aplikace je statická a běží i bez něj; tenhle modul na pozadí každých
// 10 sekund ověřuje, jestli je počítač dostupný, a sám se připojí, odpojí nebo najde jeho novou adresu.
//
//  • stránka otevřená přímo z počítače (localhost, adresa tunelu) → připojí se tam, odkud přišla,
//  • stránka z GitHub Pages → adresu počítače si přečte z větve „tunnel“ (je zašifrovaná tokenem).
import { store } from './core.js';

export const CHECK_MS = 10000;
const DEAD_MS = 25000;          // tak dlouho bez jediné zprávy = spojení je mrtvé
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export function createLink({ getToken, onState, onMessage, onAuthFail }) {
  const hosted = location.hostname.endsWith('.github.io');
  const owner = hosted ? location.hostname.split('.')[0] : '';
  const repo = hosted ? (location.pathname.split('/').filter(Boolean)[0] || '') : '';

  let ws = null;
  let state = 'connecting';     // connecting | online | offline
  let base = null;              // adresa počítače, ke které jsme (byli) připojeni
  let everOnline = false;
  let fails = 0;
  let probing = false;
  let stopped = false;
  let lastRx = 0;
  let openedAt = 0;
  let lastCheck = 0;
  let lastOk = store.get('pcSeen', 0);
  let lastSeenSaved = 0;
  let lastApi = 0;
  let lastRaw = 0;
  let retry = null;
  let timer = null;

  const info = () => ({ state, base, hosted, fails, lastCheck, lastOk });
  const setState = s => { state = s; onState(info()); };

  async function alive(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch(`${url}/health`, { cache: 'no-store', signal: ctrl.signal });
      if (!r.ok) return false;
      const j = await r.json();
      return !!j && j.ok === true;
    } catch { return false; } finally { clearTimeout(t); }
  }

  // Zašifrovaná adresa počítače z GitHubu. GitHub omezuje počet dotazů, proto se ptáme střídmě:
  // přes API (čerstvé) nejvýš jednou za 2 minuty, jinak přes raw (může být pár minut staré).
  async function readTunnel(force) {
    const now = Date.now();
    let text = null;
    if (now - lastApi > (force ? 20000 : 120000)) {
      lastApi = now;
      try {
        const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/tunnel.json?ref=tunnel&_=${now}`,
          { headers: { Accept: 'application/vnd.github.raw' }, cache: 'no-store' });
        if (r.ok) text = await r.text();
      } catch {}
    }
    if (text == null && now - lastRaw > (force ? 8000 : 30000)) {
      lastRaw = now;
      try {
        const r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/tunnel/tunnel.json?_=${now}`, { cache: 'no-store' });
        if (r.ok) text = await r.text();
      } catch {}
    }
    if (text == null) return null;
    const j = JSON.parse(text);
    const keyBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(getToken()));
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(j.iv) }, key, b64(j.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  async function probe(force) {
    if (probing || stopped || !getToken()) return;
    if (ws && ws.readyState <= 1) return;
    probing = true;
    lastCheck = Date.now();
    try {
      const candidates = [];
      if (!hosted) candidates.push(location.origin);
      const saved = store.get('pc', null);
      if (typeof saved === 'string' && saved && !candidates.includes(saved)) candidates.push(saved);
      for (const url of candidates) {
        if (await alive(url)) { open(url); return; }
      }
      if (hosted && owner && repo && crypto.subtle) {
        let t = null;
        try { t = await readTunnel(force); } catch (e) {
          if (e && e.name === 'OperationError') { onAuthFail('mismatch'); return; }   // kód k tomuto počítači nepatří
        }
        if (t && typeof t.url === 'string' && /^https:\/\/[a-z0-9.-]+$/i.test(t.url) && !candidates.includes(t.url)) {
          store.set('pc', t.url);
          if (await alive(t.url)) { open(t.url); return; }
        }
      }
      fails++;
      setState(everOnline && fails < 2 ? 'connecting' : 'offline');
    } finally { probing = false; }
  }

  function open(url) {
    if (ws && ws.readyState <= 1) return;
    let sock;
    try {
      sock = new WebSocket(`${url.replace(/^http/, 'ws')}/ws?t=${encodeURIComponent(getToken())}`);
    } catch { fails++; setState('offline'); return; }
    ws = sock;
    base = url;
    openedAt = Date.now();
    if (state !== 'online') setState('connecting');
    sock.onopen = () => { lastRx = Date.now(); };
    sock.onmessage = e => {
      if (ws !== sock) return;
      lastRx = Date.now();
      lastOk = lastRx;
      if (lastRx - lastSeenSaved > 60000) { lastSeenSaved = lastRx; store.set('pcSeen', lastRx); }
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'pong') return;
      if (m.t === 'init') { fails = 0; everOnline = true; setState('online'); }
      onMessage(m);
    };
    sock.onclose = e => {
      if (ws !== sock) return;
      ws = null;
      if (e.code === 4401) { onAuthFail('bad'); return; }
      lost(e.code === 4403);
    };
  }

  // Spojení spadlo: chvíli „připojuji“, hned zkusit znovu, a když to nevyjde, přejít do režimu bez počítače.
  function lost(denied) {
    const was = state === 'online';
    if (denied) fails = Math.max(fails, 2);
    setState(was && !denied ? 'connecting' : 'offline');
    clearTimeout(retry);
    retry = setTimeout(() => probe(true), was ? 800 : 4000);
  }

  function drop() {
    const s = ws;
    ws = null;
    if (s) { s.onclose = s.onmessage = s.onopen = null; try { s.close(); } catch {} }
  }

  // „Kontrolní skript“ – běží každých 10 s, dokud je aplikace otevřená.
  function tick() {
    if (stopped || !getToken()) return;
    const now = Date.now();
    if (ws && ws.readyState === 1) {
      lastCheck = now;
      if (now - lastRx > DEAD_MS) { drop(); lost(false); return; }
      try { ws.send('{"t":"ping"}'); } catch {}
      onState(info());
      return;
    }
    if (ws && ws.readyState === 0) {
      if (now - openedAt > 12000) { drop(); lost(false); }
      return;
    }
    probe(false);
  }

  function start() {
    stopped = false;
    clearInterval(timer);
    timer = setInterval(tick, CHECK_MS);
    probe(true);
  }

  function stop() {
    stopped = true;
    clearInterval(timer);
    clearTimeout(retry);
    drop();
  }

  // Okamžitá kontrola (návrat do aplikace, obnovení internetu, klepnutí na stav počítače).
  function checkNow() {
    if (stopped || !getToken()) return;
    if (ws && ws.readyState === 1) {
      if (Date.now() - lastRx > DEAD_MS) { drop(); lost(false); return; }
      try { ws.send('{"t":"ping"}'); } catch {}
      return;
    }
    probe(true);
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkNow(); });
  window.addEventListener('online', checkNow);
  window.addEventListener('pageshow', e => { if (e.persisted) checkNow(); });

  return {
    start, stop, checkNow, info,
    isOpen: () => !!ws && ws.readyState === 1 && state === 'online',
    send(msg) {
      if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(msg)); return true; } catch { return false; } }
      return false;
    },
  };
}
