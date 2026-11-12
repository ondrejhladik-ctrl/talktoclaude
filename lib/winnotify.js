// Sledování oznámení Windows: WhatsApp, Outlook, Teams, Propojení s telefonem (SMS a oznámení
// z mobilu) a cokoliv dalšího, co na počítači vyskočí. Bez přihlašovacích údajů a bez Clauda.
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'winnotify.ps1');

export class NotificationWatcher {
  constructor({ onNotification }) {
    this.onNotification = onNotification;
    this.child = null;
    this.wanted = false;
    this.retry = null;
    this.delay = 10000;
    this.status = { state: process.platform === 'win32' ? 'off' : 'unsupported', message: '' };
  }

  set(on) {
    if (process.platform !== 'win32') return;
    if (on === this.wanted) return;
    this.wanted = on;
    clearTimeout(this.retry);
    if (on) this.spawn(); else this.kill();
  }

  kill() {
    const c = this.child;
    this.child = null;
    try { c?.kill(); } catch {}
    this.status = { state: 'off', message: '' };
  }

  spawn() {
    if (this.child || !this.wanted) return;
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (e) {
      this.status = { state: 'error', message: e.message };
      return;
    }
    this.child = child;
    this.status = { state: 'connecting', message: '' };
    const started = Date.now();
    readline.createInterface({ input: child.stdout }).on('line', line => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.ready) { this.status = { state: 'ok', message: 'Sleduji oznámení Windows.' }; return; }
      if (m.error) {
        this.status = {
          state: 'error',
          message: m.error === 'denied' ? 'Windows nepovolil čtení oznámení (Nastavení → Soukromí a zabezpečení → Oznámení).' : `Sledování oznámení selhalo: ${m.message || m.error}`,
        };
        return;
      }
      if (!Array.isArray(m.texts) || !m.texts.length) return;
      try { this.onNotification({ id: String(m.id), app: String(m.app || ''), aumid: String(m.aumid || ''), time: Number(m.time) || Date.now(), texts: m.texts.map(String) }); } catch {}
    });
    child.on('error', e => { this.status = { state: 'error', message: e.message }; });
    child.on('exit', code => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.wanted) return;
      if (code === 2) return;                                   // přístup zamítnut – nezkoušet dokola
      if (Date.now() - started > 120000) this.delay = 10000;
      if (this.status.state !== 'error') this.status = { state: 'connecting', message: 'Sledování oznámení se restartuje…' };
      this.retry = setTimeout(() => this.spawn(), this.delay);
      this.delay = Math.min(this.delay * 2, 5 * 60000);
    });
  }
}

// Z oznámení udělá položku pro třídění: první řádek bývá odesílatel, zbytek text.
export function notificationToItem(n) {
  const [first, ...rest] = n.texts.map(t => String(t).replace(/\s+/g, ' ').trim()).filter(Boolean);
  return {
    source: 'notif', app: n.app || 'Windows',
    from: (first || '').slice(0, 200),
    title: '',
    text: rest.join(' — ').slice(0, 600),
    ts: n.time,
  };
}
