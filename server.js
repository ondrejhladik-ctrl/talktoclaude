// TalkToClaude – server běžící na PC. Spouští Claude Code (Claude Agent SDK)
// a zpřístupňuje ho webové aplikaci v mobilu přes WebSocket.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import qrcode from 'qrcode-terminal';
import selfsigned from 'selfsigned';
import { query } from '@anthropic-ai/claude-agent-sdk';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const MODES = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'];
const MODE_LABELS = {
  default: 'Ptát se',
  acceptEdits: 'Upravovat soubory',
  auto: 'Auto',
  plan: 'Jen plán',
  bypassPermissions: 'Vše povolit',
};
const IDLE_MS = 20 * 60 * 1000; // po 20 min nečinnosti se proces Claude ukončí (konverzace zůstane)
const MAX_EVENTS = 3000;
const DRIVES = '::drives';

const PHONE_PROMPT = `Uživatel s tebou komunikuje přes mobilní aplikaci TalkToClaude, často hlasem.
Přepis diktování může obsahovat chyby – zřejmý význam si domysli, u nejasností se zeptej.
Odpovědi čte na malé obrazovce nebo je poslouchá předčítané nahlas: piš stručně a v jazyce uživatele,
bez dlouhých výpisů kódu a širokých tabulek. Na konci práce shrň jednou-dvěma větami, co jsi udělal.
Máš plnou důvěru uživatele a plný přístup k počítači. Jednej samostatně: úkoly dotahuj do konce,
instaluj, spouštěj a upravuj, co je potřeba, a neptej se na zbytečná potvrzení. Ptej se jen tehdy,
když opravdu nevíš, co uživatel chce.`;

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
const config = loadConfig();

// ---------------------------------------------------------------- konfigurace

function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  const defaults = {
    port: 3443,            // HTTPS pro mobil (mikrofon v prohlížeči vyžaduje HTTPS)
    https: true,
    host: '0.0.0.0',
    localPort: 3080,       // HTTP jen pro tento počítač (http://localhost:3080)
    token: crypto.randomBytes(16).toString('hex'),
    defaultCwd: path.dirname(ROOT),
    model: '',
    mode: 'bypassPermissions', // Claude smí všechno bez ptaní; 'default' = ptát se před akcemi
  };
  const merged = { ...defaults, ...saved };
  if (Object.keys(defaults).some(k => !(k in saved))) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
  }
  if (process.env.PORT) merged.port = Number(process.env.PORT);
  if (process.env.HTTPS) merged.https = !/^(0|false|no)$/i.test(process.env.HTTPS);
  return merged;
}

function tokenOk(t) {
  if (typeof t !== 'string' || t.length !== config.token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(config.token));
}

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal || a.address.startsWith('169.254.')) continue;
      out.push({ name, address: a.address });
    }
  }
  const virt = n => (/vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|Loopback/i.test(n) ? 1 : 0);
  const rank = ip => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('100.') ? 2 : 3);
  return out.sort((x, y) => virt(x.name) - virt(y.name) || rank(x.address) - rank(y.address));
}

function phoneUrl() {
  const lan = lanAddresses()[0];
  const proto = config.https ? 'https' : 'http';
  return lan ? `${proto}://${lan.address}:${config.port}/#t=${config.token}` : null;
}

async function getCert() {
  const certFile = path.join(DATA_DIR, 'cert.pem');
  const keyFile = path.join(DATA_DIR, 'key.pem');
  try { return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }; } catch {}
  const ips = ['127.0.0.1', ...lanAddresses().map(a => a.address)];
  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate);
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 3);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'TalkToClaude' }], {
    keySize: 2048, algorithm: 'sha256', notBeforeDate, notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [
        { type: 2, value: 'localhost' },
        { type: 2, value: os.hostname() },
        ...ips.map(ip => ({ type: 7, ip })),
      ] },
    ],
  });
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(keyFile, pems.private);
  return { cert: pems.cert, key: pems.private };
}

// ---------------------------------------------------------------- pomocné funkce

const errText = e => (e && e.message) || String(e);

function clip(v, max = 4000, depth = 0) {
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}\n… (${v.length - max} znaků navíc)` : v;
  if (depth > 6 || v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 200).map(x => clip(x, max, depth + 1));
  const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = clip(x, max, depth + 1);
  return o;
}

function resultText(c) {
  if (typeof c === 'string') return clip(c, 6000);
  if (Array.isArray(c)) {
    return clip(c.map(b => (b.type === 'text' ? b.text : b.type === 'image' ? '[obrázek]' : `[${b.type}]`)).join('\n'), 6000);
  }
  return '';
}

class InputQueue {
  constructor() { this.items = []; this.waiters = []; this.closed = false; }
  push(item) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false }); else this.items.push(item);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise(r => this.waiters.push(r));
      },
      return: () => { this.close(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}

// ---------------------------------------------------------------- konverzace

const sessions = new Map();

class Session {
  constructor(data) {
    this.id = data.id;
    this.title = data.title || 'Nová konverzace';
    this.titled = !!data.titled;
    this.cwd = data.cwd;
    this.mode = MODES.includes(data.mode) ? data.mode : 'default';
    this.sdkSessionId = data.sdkSessionId || null;
    this.createdAt = data.createdAt || Date.now();
    this.updatedAt = data.updatedAt || this.createdAt;
    this.events = data.events || [];
    this.seq = this.events.length ? this.events[this.events.length - 1].n : 0;
    for (const ev of this.events) if (ev.k === 'perm' && ev.status === 'pending') ev.status = 'cancelled';
    // běhový stav
    this.q = null;
    this.input = null;
    this.running = false;
    this.pendingTurns = 0;
    this.pending = new Map();
    this.alwaysAllow = new Set();
    this.idleTimer = null;
    this.saveTimer = null;
    this.interrupted = false;
    this.stderr = [];
  }

  get file() { return path.join(SESSIONS_DIR, `${this.id}.json`); }

  meta() {
    return {
      id: this.id, title: this.title, cwd: this.cwd, mode: this.mode, running: this.running,
      pending: this.pending.size, createdAt: this.createdAt, updatedAt: this.updatedAt,
    };
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    const data = {
      id: this.id, title: this.title, titled: this.titled, cwd: this.cwd, mode: this.mode,
      sdkSessionId: this.sdkSessionId, createdAt: this.createdAt, updatedAt: this.updatedAt, events: this.events,
    };
    try { fs.writeFileSync(this.file, JSON.stringify(data)); } catch (e) { console.error('Uložení selhalo:', errText(e)); }
  }

  addEvent(ev) {
    ev.n = ++this.seq;
    ev.ts = Date.now();
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.updatedAt = ev.ts;
    toSession(this.id, { t: 'ev', sid: this.id, ev });
    this.save();
    return ev;
  }

  updateEvent(ev) {
    toSession(this.id, { t: 'ev', sid: this.id, ev });
    this.save();
  }

  broadcastMeta() { toAll({ t: 'meta', session: this.meta() }); }

  setRunning(r) {
    if (this.running === r) return;
    this.running = r;
    this.broadcastMeta();
  }

  start() {
    const input = new InputQueue();
    const options = {
      cwd: this.cwd,
      permissionMode: config.mode,
      allowDangerouslySkipPermissions: true, // aby šel režim „Vše povolit“ zapnout z mobilu
      canUseTool: (tool, inp, opts) => this.requestPermission(tool, inp, opts),
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: PHONE_PROMPT },
      stderr: d => {
        this.stderr.push(d);
        if (this.stderr.length > 30) this.stderr.shift();
        if (process.env.DEBUG) process.stderr.write(`[claude ${this.id.slice(0, 6)}] ${d}`);
      },
    };
    if (this.sdkSessionId) options.resume = this.sdkSessionId;
    if (config.model) options.model = config.model;
    const q = query({ prompt: input, options });
    this.q = q;
    this.input = input;
    this.pump(q);
  }

  async pump(q) {
    try {
      for await (const m of q) this.onMessage(m);
    } catch (e) {
      if (this.q === q) {
        this.addEvent({ k: 'error', text: errText(e) });
        console.error(`[${this.title}] Claude skončil s chybou: ${errText(e)}`);
        if (this.stderr.length) console.error(this.stderr.join(''));
      }
    } finally {
      if (this.q === q) {
        this.q = null;
        this.input = null;
        this.cancelAllPending('Relace skončila.');
        this.pendingTurns = 0;
        this.setRunning(false);
      }
    }
  }

  onMessage(m) {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          const first = !this.sdkSessionId;
          this.sdkSessionId = m.session_id;
          if (first) this.addEvent({ k: 'info', text: `Claude Code ${m.claude_code_version || ''} · ${m.model || ''}`.trim() });
          this.save();
        } else if (m.subtype === 'compact_boundary') {
          this.addEvent({ k: 'info', text: 'Konverzace byla zkomprimována.' });
        }
        break;
      case 'stream_event': {
        if (m.parent_tool_use_id) break;
        const ev = m.event;
        if (ev?.type === 'content_block_start' && ev.content_block?.type === 'text') {
          toSession(this.id, { t: 'delta', sid: this.id, reset: true });
        } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          toSession(this.id, { t: 'delta', sid: this.id, text: ev.delta.text });
        }
        break;
      }
      case 'assistant':
        if (m.parent_tool_use_id) break;
        for (const b of m.message?.content || []) {
          if (b.type === 'text' && b.text.trim()) this.addEvent({ k: 'text', text: b.text });
          else if (b.type === 'tool_use') this.addEvent({ k: 'tool', id: b.id, name: b.name, input: clip(b.input) });
        }
        break;
      case 'user': {
        if (m.parent_tool_use_id) break;
        const c = m.message?.content;
        if (Array.isArray(c)) {
          for (const b of c) {
            if (b.type === 'tool_result') {
              this.addEvent({ k: 'tool_result', id: b.tool_use_id, text: resultText(b.content), isError: !!b.is_error });
            }
          }
        }
        break;
      }
      case 'result': {
        this.pendingTurns = Math.max(0, this.pendingTurns - 1);
        const ok = m.subtype === 'success' && !m.is_error;
        const ev = { k: 'result', ok, subtype: m.subtype, ms: m.duration_ms, turns: m.num_turns };
        if (this.interrupted) {
          ev.interrupted = true;
          this.interrupted = false;
        } else if (!ok) {
          ev.text = (m.subtype === 'success' ? m.result : Array.isArray(m.errors) ? m.errors.join('\n') : '') || m.subtype;
        }
        this.addEvent(ev);
        if (!this.pendingTurns) {
          this.setRunning(false);
          this.armIdle();
        }
        break;
      }
    }
  }

  sendUser(text, voice) {
    clearTimeout(this.idleTimer);
    if (this.pending.size) {
      // Napsal/řekl něco, zatímco Claude čeká na povolení → bereme to jako „ne, udělej tohle“.
      this.addEvent({ k: 'user', text, voice });
      const message = `Uživatel tento krok neschválil a napsal: "${text}"`;
      for (const id of [...this.pending.keys()]) this.finishPermission(id, 'denied', { behavior: 'deny', message });
      return;
    }
    this.addEvent({ k: 'user', text, voice });
    if (!this.titled) {
      this.title = text.replace(/\s+/g, ' ').slice(0, 60);
      this.titled = true;
    }
    this.pendingTurns++;
    this.running = true;
    this.broadcastMeta();
    if (!this.q) this.start();
    this.input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
  }

  requestPermission(toolName, input, opts = {}) {
    if (!opts.suppressAlwaysAllowRule && this.alwaysAllow.has(toolName)) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    return new Promise(resolve => {
      const kind = toolName === 'AskUserQuestion' ? 'question' : toolName === 'ExitPlanMode' ? 'plan' : 'tool';
      const ev = this.addEvent({
        k: 'perm', kind, tool: toolName, input: clip(input, 20000),
        title: opts.title || null, description: opts.description || opts.decisionReason || null,
        path: opts.blockedPath || null, canAlways: !opts.suppressAlwaysAllowRule, status: 'pending',
      });
      this.pending.set(ev.n, { ev, input, toolName, suggestions: opts.suggestions || [], resolve });
      this.broadcastMeta();
      opts.signal?.addEventListener('abort', () => {
        this.finishPermission(ev.n, 'cancelled', { behavior: 'deny', message: 'Zrušeno.' });
      }, { once: true });
    });
  }

  resolvePermission(id, msg) {
    const p = this.pending.get(Number(id));
    if (!p) return;
    const d = msg.decision;
    if (p.ev.kind === 'question') {
      if (d === 'deny') return this.finishPermission(id, 'denied', { behavior: 'deny', message: 'Uživatel na otázku neodpověděl.' });
      const answers = {};
      for (const [k, v] of Object.entries(msg.answers || {})) answers[String(k)] = String(v);
      p.ev.answers = answers;
      return this.finishPermission(id, 'answered', { behavior: 'allow', updatedInput: { ...p.input, answers } });
    }
    if (p.ev.kind === 'plan') {
      if (d === 'deny') {
        return this.finishPermission(id, 'denied', { behavior: 'deny', message: msg.message || 'Uživatel plán neschválil. Zeptej se, co upravit.' });
      }
      const mode = config.mode === 'plan' ? 'default' : config.mode;
      return this.finishPermission(id, 'allowed', {
        behavior: 'allow', updatedInput: p.input,
        updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }],
      });
    }
    if (d === 'always') {
      const res = { behavior: 'allow', updatedInput: p.input };
      if (p.suggestions.length) res.updatedPermissions = p.suggestions; else this.alwaysAllow.add(p.toolName);
      return this.finishPermission(id, 'always', res);
    }
    if (d === 'allow') return this.finishPermission(id, 'allowed', { behavior: 'allow', updatedInput: p.input });
    return this.finishPermission(id, 'denied', { behavior: 'deny', message: msg.message || 'Uživatel tuto akci zamítl.' });
  }

  finishPermission(id, status, result) {
    const p = this.pending.get(Number(id));
    if (!p) return;
    this.pending.delete(Number(id));
    p.ev.status = status;
    this.updateEvent(p.ev);
    this.broadcastMeta();
    p.resolve(result);
  }

  cancelAllPending(message) {
    for (const id of [...this.pending.keys()]) this.finishPermission(id, 'cancelled', { behavior: 'deny', message });
  }

  async interrupt() {
    if (!this.q || !this.running) return;
    this.interrupted = true;
    this.cancelAllPending('Uživatel práci přerušil.');
    try { await this.q.interrupt(); } catch (e) { this.addEvent({ k: 'error', text: `Přerušení selhalo: ${errText(e)}` }); }
    setTimeout(() => {
      if (this.interrupted && this.running) {
        this.interrupted = false;
        this.pendingTurns = 0;
        this.setRunning(false);
        this.addEvent({ k: 'result', ok: false, interrupted: true });
      }
    }, 5000);
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.running && this.q) this.closeQuery(); }, IDLE_MS);
  }

  closeQuery() {
    const input = this.input;
    this.q = null;
    this.input = null;
    input?.close();
  }
}

for (const f of fs.readdirSync(SESSIONS_DIR)) {
  if (!f.endsWith('.json')) continue;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
    sessions.set(data.id, new Session(data));
  } catch (e) { console.warn(`Nelze načíst ${f}: ${errText(e)}`); }
}

// Režim platí pro všechny konverzace najednou (jeden přepínač v Nastavení).
async function setGlobalMode(mode) {
  if (!MODES.includes(mode)) throw new Error('Neznámý režim.');
  config.mode = mode;
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...saved, mode }, null, 2));
  } catch (e) { console.error('Uložení nastavení selhalo:', errText(e)); }
  for (const s of sessions.values()) {
    if (s.q) await s.q.setPermissionMode(mode).catch(e => console.error('Změna režimu selhala:', errText(e)));
  }
  toAll({ t: 'mode', mode });
}

const listMeta = () => [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(s => s.meta());

function recentDirs() {
  const seen = new Set();
  for (const s of [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)) seen.add(s.cwd);
  seen.add(config.defaultCwd);
  return [...seen].slice(0, 8);
}

async function validateDir(p) {
  const abs = path.resolve(String(p || config.defaultCwd));
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error(`Složka neexistuje: ${abs}`);
  return abs;
}

const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'System Volume Information']);

async function listDir(p) {
  if (p === DRIVES) {
    const dirs = [];
    for (let c = 65; c <= 90; c++) {
      const d = `${String.fromCharCode(c)}:\\`;
      if (fs.existsSync(d)) dirs.push({ name: d, path: d });
    }
    return { path: DRIVES, parent: null, dirs };
  }
  const abs = path.resolve(String(p || config.defaultCwd));
  const up = path.dirname(abs);
  const parent = up !== abs ? up : process.platform === 'win32' ? DRIVES : null;
  try {
    const ents = await fsp.readdir(abs, { withFileTypes: true });
    const dirs = ents
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$') && !SKIP_DIRS.has(e.name))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b, 'cs', { sensitivity: 'base' }))
      .map(name => ({ name, path: path.join(abs, name) }));
    return { path: abs, parent, dirs };
  } catch (e) {
    return { path: abs, parent, dirs: [], error: ['EPERM', 'EACCES'].includes(e.code) ? 'K této složce nemám přístup.' : errText(e) };
  }
}

// ---------------------------------------------------------------- HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
  '.png': 'image/png', '.ico': 'image/x-icon',
};
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'microphone=(self)',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function qrSvg(text) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const pad = 4;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.modules[r][c]) d += `M${c + pad} ${r + pad}h1v1h-1z`;
  const size = n + pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

async function handleHttp(req, res) {
  let url;
  let p;
  try {
    url = new URL(req.url, 'http://x');
    p = decodeURIComponent(url.pathname);
  } catch { res.writeHead(400).end(); return; }

  if (p === '/qr.svg') {
    const link = phoneUrl();
    if (!tokenOk(url.searchParams.get('t')) || !link) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', ...SEC_HEADERS });
    res.end(qrSvg(link));
    return;
  }

  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403).end(); return; }
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SEC_HEADERS });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Nenalezeno');
  }
}

// ---------------------------------------------------------------- WebSocket

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function toAll(msg) {
  const s = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.authed && ws.readyState === 1) ws.send(s);
}
function toSession(sid, msg) {
  const s = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.authed && ws.sid === sid && ws.readyState === 1) ws.send(s);
}

function onUpgrade(req, socket, head) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { socket.destroy(); return; }
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    if (!tokenOk(url.searchParams.get('t'))) { ws.close(4401, 'unauthorized'); return; }
    onConnection(ws);
  });
}

function onConnection(ws) {
  ws.authed = true;
  ws.isAlive = true;
  ws.sid = null;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try { await handleMessage(ws, msg); } catch (e) { send(ws, { t: 'error', message: errText(e) }); }
  });
  send(ws, {
    t: 'init', sessions: listMeta(), recent: recentDirs(), hasQr: !!phoneUrl(), mode: config.mode,
    defaults: { cwd: config.defaultCwd, host: os.hostname() },
  });
}

function need(sid) {
  const s = sessions.get(sid);
  if (!s) throw new Error('Konverzace neexistuje.');
  return s;
}

async function handleMessage(ws, msg) {
  switch (msg.t) {
    case 'open': {
      const s = need(msg.sid);
      ws.sid = s.id;
      send(ws, { t: 'session', session: s.meta(), events: s.events });
      break;
    }
    case 'new': {
      const cwd = await validateDir(msg.cwd);
      const s = new Session({ id: crypto.randomUUID(), cwd });
      sessions.set(s.id, s);
      s.saveNow();
      ws.sid = s.id;
      send(ws, { t: 'session', session: s.meta(), events: s.events });
      toAll({ t: 'sessions', sessions: listMeta(), recent: recentDirs() });
      break;
    }
    case 'send': {
      const text = String(msg.text || '').trim();
      if (text) need(msg.sid).sendUser(text, !!msg.voice);
      break;
    }
    case 'interrupt': await need(msg.sid).interrupt(); break;
    case 'perm': need(msg.sid).resolvePermission(msg.id, msg); break;
    case 'mode': await setGlobalMode(msg.mode); break;
    case 'delete': {
      const s = sessions.get(msg.sid);
      if (!s) break;
      if (s.running) await s.interrupt().catch(() => {});
      s.cancelAllPending('Konverzace byla smazána.');
      s.closeQuery();
      clearTimeout(s.saveTimer);
      sessions.delete(s.id);
      fs.rmSync(s.file, { force: true });
      for (const c of wss.clients) if (c.sid === s.id) { c.sid = null; send(c, { t: 'deleted', sid: s.id }); }
      toAll({ t: 'sessions', sessions: listMeta(), recent: recentDirs() });
      break;
    }
    case 'ls': send(ws, { t: 'ls', ...(await listDir(msg.path)) }); break;
    case 'ping': send(ws, { t: 'pong' }); break;
  }
}

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

// ---------------------------------------------------------------- start

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
}

async function main() {
  const servers = [];
  try {
    const tls = config.https ? await getCert() : null;
    const main = tls ? https.createServer(tls, handleHttp) : http.createServer(handleHttp);
    main.on('upgrade', onUpgrade);
    await listen(main, config.port, config.host);
    servers.push(main);
    if (config.https && config.localPort) {
      const local = http.createServer(handleHttp);
      local.on('upgrade', onUpgrade);
      await listen(local, config.localPort, '127.0.0.1');
      servers.push(local);
    }
  } catch (e) {
    if (e.code === 'EADDRINUSE') console.error(`\n  Port je obsazený – neběží už TalkToClaude v jiném okně? (port lze změnit v data/config.json)\n`);
    else console.error(e);
    process.exit(1);
  }

  const proto = config.https ? 'https' : 'http';
  const t = `#t=${config.token}`;
  console.log('\n  TalkToClaude běží ✔\n');
  if (config.https && config.localPort) console.log(`  Na tomto PC:  http://localhost:${config.localPort}/${t}`);
  else console.log(`  Na tomto PC:  ${proto}://localhost:${config.port}/${t}`);
  for (const a of lanAddresses()) console.log(`  Z mobilu:     ${proto}://${a.address}:${config.port}/${t}   (${a.name})`);
  const link = phoneUrl();
  if (link) {
    console.log('\n  Naskenuj QR kód telefonem (telefon musí být na stejné Wi-Fi):\n');
    qrcode.generate(link, { small: true }, q => console.log(q.replace(/^/gm, '  ')));
  }
  if (config.https) console.log('\n  Mobil při prvním otevření varuje před certifikátem (je vlastní, ne veřejný) → Rozšířené → Pokračovat.');
  console.log('  Pokud se mobil nepřipojí, povol Node.js ve Windows Firewallu pro soukromé sítě.');
  console.log('  Ukončení: Ctrl+C\n');
}

function shutdown() {
  for (const s of sessions.values()) { s.saveNow(); s.closeQuery(); }
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
