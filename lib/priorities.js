// Osobní priority: co je důležité, o čem dát vědět a kdy rovnou „zavolat“.
// Všechno tady běží na počítači podle pravidel – bez Clauda, tedy zadarmo.
import { norm, personNames } from '../public/intents.js';

export function defaultSettings() {
  return {
    people: [],                     // { id, name, phone, email, aliases, vip }
    priorities: {
      about: '',                    // volný popis toho, co je pro uživatele důležité (pro chytré třídění)
      keywords: ['urgentní', 'naléhavé', 'faktura', 'smlouva', 'termín', 'objednávka', 'reklamace'],
      mute: ['newsletter', 'noreply', 'no-reply', 'odhlásit odběr', 'unsubscribe', 'sleva', 'akce končí'],
      notify: 'important',          // o čem poslat oznámení: all | important | vip | none
      call: 'vip',                  // kdy „zavolat“: vip | important | never
      quiet: { on: false, from: '22:00', to: '07:00', vip: true },
      smart: false,                 // nerozhodnuté zprávy nechat posoudit Clauda (Haiku)
    },
    watch: {
      enabled: true,
      notifications: true,          // oznámení Windows (WhatsApp, Outlook, Teams, Propojení s telefonem…)
      ignoreApps: ['Nastavení', 'Settings', 'Výstřižky', 'Snipping Tool', 'Microsoft Store', 'Zabezpečení Windows', 'Windows Security', 'Intel', 'NVIDIA', 'Windows Update', 'OneDrive'],
      mail: { on: false, preset: 'icloud', host: '', port: 993, user: '', pass: '' },
      calendar: { urls: [], lead: 15 },
    },
    call: {
      on: false,                    // zapnuto/vypnuto
      twilioSid: '',                // Account SID z Twilio (do telefonu se nevrací)
      twilioToken: '',              // Auth Token z Twilio (do telefonu se nevrací)
      from: '',                     // číslo OD (Twilio číslo v formátu +1234567890)
      to: '',                       // číslo KAM (uživatelovo číslo v formátu +420123456789)
    },
    skills: {
      messenger: 'whatsapp',        // výchozí kanál pro „napiš Petrovi, že…“
      countryCode: '420',
      calendarPhone: 'auto',        // po přidání události nabídnout kalendář v telefonu: auto | google | ics | off
    },
    ai: {
      fallback: true,               // když Claudovi dojdou kredity / narazí na limit, odpovídá Mistral AI
      mistralKey: '',               // API klíč z console.mistral.ai (do telefonu se nevrací)
      mistralModel: 'mistral-small-latest',
    },
    snoozeUntil: 0,
  };
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// Sloučí uložené nastavení s výchozím (hloubkově, jen známé klíče; pole se berou celá).
export function mergeSettings(base, patch) {
  if (!isObj(patch)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in base)) continue;
    const b = base[k];
    if (isObj(b)) out[k] = mergeSettings(b, v);
    else if (Array.isArray(b)) { if (Array.isArray(v)) out[k] = v; }
    else if (typeof v === typeof b) out[k] = v;
  }
  return out;
}

const str = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);
const list = (v, maxItems = 60, maxLen = 80) => (Array.isArray(v) ? v : String(v ?? '').split(/[,\n;]/))
  .map(x => str(x, maxLen)).filter(Boolean).slice(0, maxItems);

// Vyčistí vstup z aplikace (typy, délky), než se uloží.
export function sanitizeSettings(s) {
  const d = defaultSettings();
  const m = mergeSettings(d, s);
  m.people = (Array.isArray(s?.people) ? s.people : []).slice(0, 300).map(p => ({
    id: str(p.id, 40) || Math.random().toString(36).slice(2, 10),
    name: str(p.name, 80),
    phone: str(p.phone, 40).replace(/[^\d+ ()/-]/g, ''),
    email: str(p.email, 120).toLowerCase(),
    aliases: str(p.aliases, 200),
    vip: !!p.vip,
  })).filter(p => p.name);
  const p = m.priorities;
  p.about = str(p.about, 1500);
  p.keywords = list(p.keywords);
  p.mute = list(p.mute);
  if (!['all', 'important', 'vip', 'none'].includes(p.notify)) p.notify = d.priorities.notify;
  if (!['vip', 'important', 'never'].includes(p.call)) p.call = d.priorities.call;
  const hm = v => (/^([01]?\d|2[0-3]):[0-5]\d$/.test(v) ? v : null);
  p.quiet = { on: !!p.quiet.on, from: hm(p.quiet.from) || d.priorities.quiet.from, to: hm(p.quiet.to) || d.priorities.quiet.to, vip: p.quiet.vip !== false };
  p.smart = !!p.smart;
  const w = m.watch;
  w.enabled = !!w.enabled;
  w.notifications = !!w.notifications;
  w.ignoreApps = list(w.ignoreApps);
  w.mail = {
    on: !!w.mail.on, preset: str(w.mail.preset, 20) || 'custom', host: str(w.mail.host, 120),
    port: Number.isInteger(w.mail.port) && w.mail.port > 0 && w.mail.port < 65536 ? w.mail.port : 993,
    user: str(w.mail.user, 160), pass: String(w.mail.pass ?? '').slice(0, 200),
  };
  w.calendar = {
    urls: list(w.calendar.urls, 10, 600).map(u => u.replace(/^webcal:/i, 'https:')).filter(u => /^https?:\/\//i.test(u)),
    lead: [0, 5, 10, 15, 30, 60, 120].includes(w.calendar.lead) ? w.calendar.lead : 15,
  };
  const c = m.call || {};
  m.call = {
    on: !!c.on,
    twilioSid: str(c.twilioSid, 60).replace(/\s+/g, ''),
    twilioToken: str(c.twilioToken, 100).replace(/\s+/g, ''),
    from: str(c.from, 30).replace(/[^\d+]/g, ''),
    to: str(c.to, 30).replace(/[^\d+]/g, ''),
  };
  const k = m.skills;
  if (!['whatsapp', 'sms'].includes(k.messenger)) k.messenger = 'whatsapp';
  k.countryCode = str(k.countryCode, 4).replace(/\D/g, '') || '420';
  if (!['auto', 'google', 'ics', 'off'].includes(k.calendarPhone)) k.calendarPhone = 'auto';
  m.ai = {
    fallback: m.ai.fallback !== false,
    mistralKey: String(m.ai.mistralKey ?? '').replace(/\s+/g, '').slice(0, 200),
    mistralModel: ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest'].includes(m.ai.mistralModel) ? m.ai.mistralModel : 'mistral-small-latest',
  };
  m.snoozeUntil = Number.isFinite(m.snoozeUntil) ? m.snoozeUntil : 0;
  return m;
}

// Nastavení bez tajných údajů (to, co smí do telefonu).
export function publicSettings(s) {
  const out = structuredClone(s);
  out.watch.mail.hasPass = !!s.watch.mail.pass;
  out.watch.mail.pass = '';
  out.ai.hasKey = !!s.ai.mistralKey;
  out.ai.mistralKey = '';
  // Twilio tokeny do telefonu nepatří
  out.call = s.call ? {
    on: s.call.on,
    hasSid: !!s.call.twilioSid,
    hasToken: !!s.call.twilioToken,
    from: s.call.from,
    to: s.call.to,
  } : { on: false, hasSid: false, hasToken: false, from: '', to: '' };
  return out;
}

const digitsOf = s => String(s || '').replace(/\D/g, '');

// Je odesílatel někdo z lidí? Porovnává se jméno, přezdívky, e-mail (i celá doména „@firma.cz“) a telefon.
export function matchPerson(people, from, addr = '') {
  const hay = norm(`${from} ${addr}`);
  if (!hay) return null;
  const tokens = new Set(hay.replace(/[^a-z0-9@._+-]/g, ' ').split(' ').filter(Boolean));
  const hayDigits = digitsOf(`${from} ${addr}`);
  for (const p of people || []) {
    const email = norm(p.email);
    if (email && (email.startsWith('@') ? hay.includes(email) : hay.includes(email))) return p;
    const pd = digitsOf(p.phone).slice(-9);
    if (pd.length === 9 && hayDigits.includes(pd)) return p;
    for (const nm of personNames(p)) {
      const parts = norm(nm).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(Boolean);
      if (parts.length && parts.every(t => tokens.has(t))) return p;
    }
  }
  return null;
}

export function inQuiet(quiet, now = new Date()) {
  if (!quiet?.on) return false;
  const mins = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
  const cur = now.getHours() * 60 + now.getMinutes();
  const a = mins(quiet.from);
  const b = mins(quiet.to);
  if (a === b) return false;
  return a < b ? cur >= a && cur < b : cur >= a || cur < b;
}

/**
 * Rozhodne o jedné příchozí věci (e-mail, zpráva, oznámení…).
 * item: { source, app, from, fromAddr, title, text, bulk }
 * Vrací { level: 'vip'|'important'|'normal'|'muted', action: 'call'|'notify'|'log'|'drop', why }.
 */
export function classify(item, settings, now = new Date()) {
  const p = settings.priorities;
  const all = norm(`${item.from || ''} ${item.fromAddr || ''} ${item.title || ''} ${item.text || ''}`);

  // Věci, které si uživatel sám naplánoval nebo o které řekl Claudovi, projdou vždy.
  if (item.source === 'reminder') return { level: 'important', action: 'call', why: 'tvoje připomínka' };
  if (item.source === 'calendar') return { level: 'important', action: 'notify', why: 'událost v kalendáři' };
  if (item.source === 'claude' || item.source === 'test') {
    return { level: item.urgent ? 'vip' : 'important', action: item.urgent ? 'call' : 'notify', why: item.source === 'test' ? 'zkouška' : 'vzkaz od Clauda' };
  }

  const muted = p.mute.map(norm).filter(Boolean).find(w => all.includes(w));
  const person = matchPerson(settings.people.filter(x => x.vip), item.from, item.fromAddr);
  if (muted && !person) return { level: 'muted', action: 'drop', why: `ztlumeno („${muted}“)` };

  let level = 'normal';
  let why = 'běžné';
  if (person) {
    level = 'vip';
    why = `důležitý člověk: ${person.name}`;
  } else if (!item.bulk) {
    const kw = p.keywords.map(norm).filter(Boolean).find(w => all.includes(w));
    if (kw) { level = 'important'; why = `důležité slovo: ${kw}`; }
  }
  return { level, ...decide(level, settings, now), why };
}

// Z úrovně důležitosti udělá akci podle nastavení, klidu a „nerušit“.
export function decide(level, settings, now = new Date()) {
  const p = settings.priorities;
  const rank = { vip: 2, important: 1, normal: 0 }[level] ?? 0;
  let action = 'log';
  if ((p.notify === 'all') || (p.notify === 'important' && rank >= 1) || (p.notify === 'vip' && rank >= 2)) action = 'notify';
  if ((p.call === 'vip' && rank >= 2) || (p.call === 'important' && rank >= 1)) action = 'call';
  const quiet = inQuiet(p.quiet, now) || settings.snoozeUntil > now.getTime();
  if (quiet && action !== 'log' && !(level === 'vip' && p.quiet.vip)) return { action: 'log', held: true };
  return { action };
}
