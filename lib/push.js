// Web Push: upozornění do telefonu, i když je aplikace zavřená. Obsah je šifrovaný klíči
// daného telefonu – služby Googlu/Applu, přes které zpráva putuje, ho nepřečtou.
import path from 'node:path';
import * as webpush from 'web-push';
import { readJson, writeJson, errText } from './store.js';

const SUBJECT = 'mailto:talktoclaude@users.noreply.github.com';
const MAX_SUBS = 12;

export class Push {
  constructor({ dataDir }) {
    this.file = path.join(dataDir, 'push.json');
    const saved = readJson(this.file, {});
    this.vapid = saved.vapid && saved.vapid.publicKey && saved.vapid.privateKey ? saved.vapid : webpush.generateVAPIDKeys();
    this.subs = Array.isArray(saved.subs) ? saved.subs : [];
    if (!saved.vapid) this.save();
  }

  save() { writeJson(this.file, { vapid: this.vapid, subs: this.subs }); }

  get publicKey() { return this.vapid.publicKey; }
  get count() { return this.subs.length; }

  add(sub, ua = '') {
    const endpoint = String(sub?.endpoint || '');
    let url;
    try { url = new URL(endpoint); } catch { throw new Error('Neplatná adresa pro upozornění.'); }
    if (url.protocol !== 'https:' || !url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) {
      throw new Error('Neplatná adresa pro upozornění.');
    }
    const p256dh = String(sub?.keys?.p256dh || '');
    const auth = String(sub?.keys?.auth || '');
    if (!p256dh || !auth || p256dh.length > 200 || auth.length > 100 || endpoint.length > 1000) throw new Error('Neplatné klíče pro upozornění.');
    this.subs = this.subs.filter(s => s.endpoint !== endpoint);
    this.subs.push({ endpoint, keys: { p256dh, auth }, ua: String(ua).slice(0, 200), addedAt: Date.now() });
    this.subs = this.subs.slice(-MAX_SUBS);
    this.save();
  }

  remove(endpoint) {
    const n = this.subs.length;
    this.subs = this.subs.filter(s => s.endpoint !== endpoint);
    if (this.subs.length !== n) this.save();
  }

  // Pošle upozornění na všechna přihlášená zařízení. Vrací { sent, failed }.
  async send(payload, { urgent = false } = {}) {
    if (!this.subs.length) return { sent: 0, failed: 0 };
    const body = JSON.stringify(payload);
    let sent = 0;
    let failed = 0;
    const dead = [];
    await Promise.all(this.subs.map(async sub => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, {
          vapidDetails: { subject: SUBJECT, publicKey: this.vapid.publicKey, privateKey: this.vapid.privateKey },
          TTL: urgent ? 1800 : 12 * 3600,
          urgency: urgent ? 'high' : 'normal',
          timeout: 15000,
        });
        sent++;
      } catch (e) {
        failed++;
        if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(sub.endpoint);
        else if (process.env.DEBUG) console.error(`  Push selhal: ${e?.statusCode || ''} ${errText(e)}`);
      }
    }));
    if (dead.length) {
      this.subs = this.subs.filter(s => !dead.includes(s.endpoint));
      this.save();
    }
    return { sent, failed };
  }
}
