// Sdílené drobnosti aplikace: přístup k prvkům stránky, úložiště v telefonu, stav a toast.

export const $ = id => document.getElementById(id);
export const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export const store = {
  get(k, d) { try { const v = localStorage.getItem(`ttc.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`ttc.${k}`, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(`ttc.${k}`); } catch {} },
  raw(k) { try { return localStorage.getItem(`ttc.${k}`); } catch { return null; } },
};

// Nastavení tohoto zařízení (hlas, vibrace…) – zůstává jen v telefonu.
export const settings = Object.assign(
  { lang: 'cs-CZ', speak: 'always', rate: 1.05, autoSend: true, vibrate: true, wakeLock: true },
  store.get('settings', {}),
);
if (settings.speak === 'voice') settings.speak = 'always';
export const saveSettings = () => store.set('settings', settings);

const ua = navigator.userAgent;
export const isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
export const isAndroid = /Android/i.test(ua);
export const isMobile = isIOS || isAndroid;

// Výchozí podoba nastavení ze serveru (lidé, priority, hlídání) – aby aplikace fungovala i před prvním připojením.
export const DEFAULT_CFG = {
  people: [],
  priorities: { about: '', keywords: [], mute: [], notify: 'important', call: 'vip', quiet: { on: false, from: '22:00', to: '07:00', vip: true }, smart: false },
  watch: { enabled: true, notifications: true, ignoreApps: [], mail: { on: false, preset: 'icloud', host: '', port: 993, user: '', pass: '', hasPass: false }, calendar: { urls: [], lead: 15 } },
  skills: { messenger: 'whatsapp', countryCode: '420', calendarPhone: 'auto' },
  ai: { fallback: true, mistralKey: '', mistralModel: 'mistral-small-latest', hasKey: false },
  snoozeUntil: 0,
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
export function deepMerge(base, patch) {
  if (!isObj(patch)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(base?.[k]) ? deepMerge(base[k], v) : v;
  return out;
}

// Stav aplikace
export const S = {
  token: null, conn: 'connecting', link: null,
  sessions: [], recent: [], defaults: {}, shareLink: null, auto: !!store.get('auto', false),
  sid: store.get('sid', null), meta: null, events: [], nodes: new Map(), toolNodes: new Map(),
  liveText: '', liveRaf: 0, listening: false, speaking: false,
  voiceDraft: false, queued: null, browsePath: null,
  cfg: deepMerge(DEFAULT_CFG, store.get('cfg', {})), caps: {}, vapid: null, quickModel: 'claude-haiku-5-5',
  inbox: { items: [], unseen: 0 }, agenda: store.get('agenda', []),
  actions: [],            // akce čekající na klepnutí (otevřít WhatsApp…)
  status: null,           // stav hlídání ze serveru
};

let toastTimer = 0;
export function toast(text, isError) {
  const t = $('toast');
  t.textContent = text;
  t.className = `toast${isError ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 3200);
}

export function buzz(pattern) {
  if (settings.vibrate && navigator.vibrate) { try { navigator.vibrate(pattern); } catch {} }
}

export function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'teď';
  if (s < 3600) return `před ${Math.floor(s / 60)} min`;
  if (s < 86400) return `před ${Math.floor(s / 3600)} h`;
  if (s < 172800) return 'včera';
  return new Date(ts).toLocaleDateString('cs-CZ');
}

export const rid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
