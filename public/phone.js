// Akce v telefonu: z povelu udělá odkaz, který po klepnutí otevře správnou aplikaci
// (WhatsApp s napsanou zprávou, vytáčení, SMS, mapy, kalendář…). Funguje i bez počítače.
// Webová aplikace nesmí nic odeslat sama – proto vždy jedno klepnutí a odeslání v cílové aplikaci.
import { isIOS } from './core.js';
import { fmtWhen } from './intents.js';

const enc = encodeURIComponent;
const pad = n => String(n).padStart(2, '0');
const short = (s, n = 70) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

const stampLocal = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
const stampDay = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const stampUtc = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;

function eventTimes(ev) {
  const start = new Date(ev.start);
  let end = ev.end ? new Date(ev.end) : null;
  if (ev.allDay) end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  else if (!end || end <= start) end = new Date(start.getTime() + 3600000);
  return { start, end };
}

function googleCalendarUrl(ev) {
  const { start, end } = eventTimes(ev);
  const dates = ev.allDay ? `${stampDay(start)}/${stampDay(end)}` : `${stampLocal(start)}/${stampLocal(end)}`;
  let url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${enc(ev.title || 'Událost')}&dates=${dates}`;
  if (ev.location) url += `&location=${enc(ev.location)}`;
  if (ev.notes) url += `&details=${enc(ev.notes)}`;
  try { url += `&ctz=${enc(Intl.DateTimeFormat().resolvedOptions().timeZone)}`; } catch {}
  return url;
}

const icsEsc = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

export function buildIcs(ev) {
  const { start, end } = eventTimes(ev);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TalkToClaude//CS', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${ev.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`}@talktoclaude`,
    `DTSTAMP:${stampUtc(new Date())}`,
    ev.allDay ? `DTSTART;VALUE=DATE:${stampDay(start)}` : `DTSTART:${stampUtc(start)}`,
    ev.allDay ? `DTEND;VALUE=DATE:${stampDay(end)}` : `DTEND:${stampUtc(end)}`,
    `SUMMARY:${icsEsc(ev.title || 'Událost')}`,
  ];
  if (ev.location) lines.push(`LOCATION:${icsEsc(ev.location)}`);
  if (ev.notes) lines.push(`DESCRIPTION:${icsEsc(ev.notes)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

async function shareIcs(ev) {
  const file = new File([buildIcs(ev)], 'udalost.ics', { type: 'text/calendar' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: ev.title || 'Událost' }); return true; } catch (e) {
      if (e && e.name === 'AbortError') return false;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'udalost.ics';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  return true;
}

/**
 * Z akce udělá to, co se ukáže ve skleněném pruhu.
 * Vrací { label, detail, go, href?, blank?, run? } – buď odkaz (href), nebo funkce (run) po klepnutí.
 */
export function buildAction(a, { calendarMode = 'auto' } = {}) {
  const num = String(a.number || '').replace(/\D/g, '');
  const plus = num ? `+${num}` : '';
  switch (a.kind) {
    case 'whatsapp':
      return {
        label: `WhatsApp → ${a.to || 'vyber příjemce'}`, detail: a.text, go: 'Otevřít',
        href: num ? `https://wa.me/${num}?text=${enc(a.text || '')}` : `https://wa.me/?text=${enc(a.text || '')}`, blank: true,
        log: `WhatsApp pro ${a.to || '…'}: „${short(a.text)}“`,
      };
    case 'sms':
      if (!num) return null;
      return { label: `SMS → ${a.to || plus}`, detail: a.text, go: 'Otevřít', href: `sms:${plus}${isIOS ? '&' : '?'}body=${enc(a.text || '')}`, log: `SMS pro ${a.to || plus}: „${short(a.text)}“` };
    case 'mail': {
      const q = [];
      if (a.subject) q.push(`subject=${enc(a.subject)}`);
      if (a.text) q.push(`body=${enc(a.text)}`);
      return { label: `E-mail → ${a.to || a.email || 'vyber příjemce'}`, detail: a.text, go: 'Otevřít', href: `mailto:${a.email || ''}${q.length ? `?${q.join('&')}` : ''}`, log: `E-mail pro ${a.to || a.email || '…'}: „${short(a.text)}“` };
    }
    case 'call':
      if (!num) return null;
      return { label: `Zavolat ${a.to || plus}`, go: 'Volat', href: `tel:${plus}`, log: `Hovor: ${a.to || plus}` };
    case 'navigate':
      return { label: `Navigace → ${short(a.query, 40)}`, go: 'Otevřít', href: `https://www.google.com/maps/dir/?api=1&destination=${enc(a.query || '')}`, blank: true, log: `Navigace: ${a.query}` };
    case 'search':
      return { label: `Hledat: ${short(a.query, 40)}`, go: 'Otevřít', href: `https://www.google.com/search?q=${enc(a.query || '')}`, blank: true, log: `Hledání: ${a.query}` };
    case 'youtube':
      return { label: `YouTube: ${short(a.query, 40)}`, go: 'Otevřít', href: `https://www.youtube.com/results?search_query=${enc(a.query || '')}`, blank: true, log: `YouTube: ${a.query}` };
    case 'url': {
      if (!/^https?:\/\//i.test(a.query || '')) return null;
      let host = a.query;
      try { host = new URL(a.query).host; } catch {}
      return { label: `Otevřít ${host}`, detail: a.query, go: 'Otevřít', href: a.query, blank: true, log: `Odkaz: ${a.query}` };
    }
    case 'calendar': {
      const ev = a.event || {};
      const mode = calendarMode === 'auto' ? (isIOS ? 'ics' : 'google') : calendarMode;
      if (mode === 'off') return null;
      const label = `Do kalendáře telefonu: ${short(ev.title, 28)}`;
      const log = `Kalendář telefonu: ${ev.title}, ${fmtWhen(new Date(ev.start), !!ev.allDay)}`;
      if (mode === 'google') return { label, go: 'Přidat', href: googleCalendarUrl(ev), blank: true, log };
      return { label, go: 'Přidat', run: () => shareIcs(ev), log };
    }
    default:
      return null;
  }
}
