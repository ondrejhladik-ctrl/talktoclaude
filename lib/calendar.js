// Kalendář: vlastní události a připomínky (data/calendar.json) + čtení cizích kalendářů přes
// odkaz iCal (Google, iCloud, Outlook). Hlídá blížící se události a připomínky – bez Clauda.
import path from 'node:path';
import crypto from 'node:crypto';
import ical from 'node-ical';
import { readJson, debounced, errText } from './store.js';
import { norm, hhmm, fmtWhen } from '../public/intents.js';

const DAY = 86400000;
const FEED_EVERY = 10 * 60 * 1000;
const FEED_MAX_BYTES = 8 * 1024 * 1024;
const val = v => (v && typeof v === 'object' && 'val' in v ? String(v.val ?? '') : v == null ? '' : String(v));
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// Celodenní událost: půlnoc místního dne (ať ji knihovna vrátí jako UTC nebo místní půlnoc).
function localMidnight(d) {
  const utcMid = d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
  return utcMid ? new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime()
    : new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function parseIcs(text, from, to, max = 3000) {
  const data = ical.sync.parseICS(text);
  const out = [];
  for (const ev of Object.values(data)) {
    if (!ev || ev.type !== 'VEVENT' || ev.status === 'CANCELLED' || !ev.start) continue;
    let instances;
    try {
      instances = ical.expandRecurringEvent(ev, { from: new Date(from), to: new Date(to), expandOngoing: true });
    } catch { continue; }
    for (const i of instances) {
      const allDay = !!i.isFullDay;
      const start = allDay ? localMidnight(i.start) : i.start.getTime();
      let end = i.end ? (allDay ? localMidnight(i.end) : i.end.getTime()) : null;
      if (end != null && end < start) end = null;
      out.push({
        id: `${ev.uid || crypto.randomUUID()}@${start}`,
        title: clip(val(i.summary), 200) || '(bez názvu)',
        start, end, allDay,
        location: clip(val(i.event?.location ?? ev.location), 200),
        source: 'feed',
      });
      if (out.length >= max) return out;
    }
  }
  return out;
}

export class Calendar {
  constructor({ dataDir, getSettings, onAlert, onChange }) {
    this.file = path.join(dataDir, 'calendar.json');
    const saved = readJson(this.file, {});
    this.events = Array.isArray(saved.events) ? saved.events : [];
    this.reminders = Array.isArray(saved.reminders) ? saved.reminders : [];
    this.reminded = saved.reminded && typeof saved.reminded === 'object' ? saved.reminded : {};
    this.feeds = new Map();       // url → { events, at, error }
    this.getSettings = getSettings;
    this.onAlert = onAlert || (() => {});
    this.onChange = onChange || (() => {});
    this.save = debounced(this.file, () => ({ events: this.events, reminders: this.reminders, reminded: this.reminded }));
    this.timers = [];
  }

  start() {
    this.timers.push(setInterval(() => this.tick(), 20000));
    this.timers.push(setInterval(() => this.refreshFeeds().catch(() => {}), FEED_EVERY));
    this.refreshFeeds().catch(() => {});
    setTimeout(() => this.tick(), 3000);
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.save.flush();
  }

  // ---------- vlastní události

  add(input) {
    const start = Number(new Date(input.start));
    if (!Number.isFinite(start)) throw new Error('Události chybí platný začátek.');
    let end = input.end ? Number(new Date(input.end)) : null;
    if (!Number.isFinite(end) || end <= start) end = null;
    const allDay = !!input.allDay;
    const ev = {
      id: crypto.randomUUID(),
      title: clip(input.title, 200) || 'Událost',
      start: allDay ? new Date(new Date(start).getFullYear(), new Date(start).getMonth(), new Date(start).getDate()).getTime() : start,
      end: allDay ? null : (end ?? start + 3600000),
      allDay,
      location: clip(input.location, 200),
      notes: clip(input.notes, 1000),
      source: 'own',
      createdAt: Date.now(),
    };
    this.events.push(ev);
    this.prune();
    this.save();
    this.onChange();
    return ev;
  }

  remove(id) {
    const i = this.events.findIndex(e => e.id === id);
    if (i < 0) return false;
    this.events.splice(i, 1);
    this.save();
    this.onChange();
    return true;
  }

  prune() {
    const old = Date.now() - 60 * DAY;
    this.events = this.events.filter(e => (e.end ?? e.start) > old).slice(-2000);
    for (const [k, ts] of Object.entries(this.reminded)) if (ts < Date.now() - 3 * DAY) delete this.reminded[k];
  }

  // Události, které zasahují do [from, to). Vlastní i z odkazů, bez duplicit, seřazené.
  list(from, to) {
    const a = Number(from);
    const b = Number(to);
    const seen = new Set();
    const out = [];
    const all = [...this.events, ...[...this.feeds.values()].flatMap(f => f.events || [])];
    for (const e of all) {
      const end = e.end ?? (e.allDay ? e.start + DAY : e.start);
      if (!(e.start < b && end >= a)) continue;
      const key = `${norm(e.title)}|${Math.round(e.start / 60000)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
    return out.sort((x, y) => x.start - y.start);
  }

  agenda(days = 14) {
    const now = Date.now();
    return this.list(now - 3600000, now + days * DAY).slice(0, 200)
      .map(({ id, title, start, end, allDay, location, source }) => ({ id, title, start, end, allDay, location, source }));
  }

  // ---------- připomínky

  addReminder({ at, text }) {
    const ts = Number(new Date(at));
    if (!Number.isFinite(ts)) throw new Error('Připomínce chybí platný čas.');
    const r = { id: crypto.randomUUID(), at: ts, text: clip(text, 300) || 'Připomínka', createdAt: Date.now() };
    this.reminders.push(r);
    this.reminders = this.reminders.slice(-200);
    this.save();
    return r;
  }

  removeReminder(id) {
    const n = this.reminders.length;
    this.reminders = this.reminders.filter(r => r.id !== id);
    if (this.reminders.length !== n) this.save();
    return this.reminders.length !== n;
  }

  // ---------- cizí kalendáře (iCal odkazy)

  async refreshFeeds() {
    const urls = this.getSettings().watch.calendar.urls || [];
    for (const url of [...this.feeds.keys()]) if (!urls.includes(url)) this.feeds.delete(url);
    const now = Date.now();
    let changed = false;
    await Promise.all(urls.map(async url => {
      const prev = this.feeds.get(url);
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(25000), headers: { Accept: 'text/calendar, text/plain, */*' }, redirect: 'follow' });
        if (!r.ok) throw new Error(`server odpověděl ${r.status}`);
        const text = await r.text();
        if (text.length > FEED_MAX_BYTES) throw new Error('kalendář je příliš velký');
        if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('odkaz nevede na kalendář ve formátu iCal');
        const events = parseIcs(text, now - DAY, now + 60 * DAY);
        this.feeds.set(url, { events, at: now, error: null });
        changed = true;
      } catch (e) {
        this.feeds.set(url, { events: prev?.events || [], at: prev?.at || 0, error: errText(e) });
      }
    }));
    if (changed) this.onChange();
    return this.feedStatus();
  }

  feedStatus() {
    return [...this.feeds.entries()].map(([url, f]) => ({ url, count: f.events.length, at: f.at, error: f.error }));
  }

  // ---------- hlídání času

  tick(now = Date.now()) {
    const settings = this.getSettings();
    let dirty = false;

    for (const r of [...this.reminders]) {
      if (r.at > now) continue;
      this.reminders = this.reminders.filter(x => x.id !== r.id);
      dirty = true;
      const late = now - r.at > 3 * 60000;
      this.onAlert({
        source: 'reminder', app: 'Připomínka', from: 'Připomínka', title: r.text,
        text: late ? `Mělo zaznít ${fmtWhen(r.at, false, new Date(now))} – počítač byl v tu dobu vypnutý.` : '',
      });
    }

    const lead = settings.watch.enabled ? settings.watch.calendar.lead : 0;
    if (lead > 0) {
      for (const ev of this.list(now, now + lead * 60000 + 30000)) {
        if (ev.allDay || ev.start <= now || ev.start - now > lead * 60000) continue;
        if (this.reminded[ev.id]) continue;
        this.reminded[ev.id] = now;
        dirty = true;
        const mins = Math.max(1, Math.round((ev.start - now) / 60000));
        this.onAlert({
          source: 'calendar', app: 'Kalendář', from: 'Kalendář', title: `Za ${mins} min: ${ev.title}`,
          text: `Začátek v ${hhmm(new Date(ev.start))}${ev.location ? ` · ${ev.location}` : ''}`,
        });
      }
    }
    if (dirty) { this.prune(); this.save(); }
  }
}
