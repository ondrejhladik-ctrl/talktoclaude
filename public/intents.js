// Rychlé povely: rozpoznání běžných českých vět bez Clauda (zadarmo a hned).
// Čistý modul bez DOM – používá ho aplikace v telefonu i server (a testy v Node).

// ---------------------------------------------------------------- text

// Malá písmena bez diakritiky, znak za znak (délka i pozice zůstávají stejné jako v originále).
export function fold(text) {
  const src = String(text ?? '').normalize('NFC');
  let out = '';
  for (const ch of src) {
    if (ch.length > 1) { out += ch; continue; }
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    const low = (base.length === 1 ? base : ch).toLowerCase();
    out += low.length === 1 ? low : ch;
  }
  return out;
}

export const norm = s => fold(s).replace(/\s+/g, ' ').trim();
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
const clean = s => String(s ?? '').replace(/\s+/g, ' ').replace(/^[\s,;:.–-]+|[\s,;:–-]+$/g, '').trim();
const stripEnd = s => String(s ?? '').trim().replace(/[\s.!?…]+$/g, '');

// Vyřízne z textu úseky, které regex najde v jeho „složené“ podobě (pozice jsou stejné).
function cutFolded(orig, re) {
  const f = fold(orig);
  let out = '';
  let pos = 0;
  let m;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  while ((m = g.exec(f))) {
    out += `${orig.slice(pos, m.index)} `;
    pos = m.index + m[0].length;
    if (!m[0].length) g.lastIndex++;
  }
  return out + orig.slice(pos);
}

// ---------------------------------------------------------------- lidé

const TITLES = new Set(['pan', 'panu', 'pana', 'pani', 'slecna', 'slecne', 'moji', 'moje', 'mojemu', 'memu', 'me', 'svemu', 'svoji', 'sve', 'nasemu', 'nasi', 'ing', 'mgr', 'dr', 'mudr']);

// Shoda vysloveného (skloňovaného) slova se slovem ve jménu: „petrovi“ ~ „petr“, „mamince“ ~ „maminka“.
function tokenScore(spoken, name) {
  if (!spoken || !name) return 0;
  if (spoken === name) return 3;
  let i = 0;
  const n = Math.min(spoken.length, name.length);
  while (i < n && spoken[i] === name[i]) i++;
  const need = Math.max(3, name.length <= 4 ? name.length - 1 : name.length - 2);
  if (i >= need && spoken.length <= name.length + 4) return 2;
  return 0;
}

function phraseScore(spokenTokens, phrase) {
  const nameTokens = norm(phrase).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(Boolean);
  if (!nameTokens.length) return 0;
  let total = 0;
  const used = new Set();
  for (const st of spokenTokens) {
    let best = 0;
    let bestI = -1;
    nameTokens.forEach((nt, i) => {
      if (used.has(i)) return;
      const sc = tokenScore(st, nt);
      if (sc > best) { best = sc; bestI = i; }
    });
    if (!best) return 0;
    used.add(bestI);
    total += best;
  }
  // úplná shoda všech slov jména je lepší než shoda jen křestního
  return total + (used.size === nameTokens.length ? 1 : 0);
}

export const personNames = p => [p.name, ...String(p.aliases || '').split(',')].map(s => String(s || '').trim()).filter(Boolean);

// Najde člověka podle vysloveného jména. Vrací { person, score } nebo null.
export function findPerson(people, spoken) {
  const tokens = norm(spoken).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(t => t && !TITLES.has(t));
  if (!tokens.length || tokens.length > 4 || !Array.isArray(people)) return null;
  let best = null;
  for (const person of people) {
    let score = 0;
    for (const nm of personNames(person)) score = Math.max(score, phraseScore(tokens, nm));
    if (score && (!best || score > best.score)) best = { person, score };
  }
  return best;
}

export function phoneDigits(phone, countryCode = '420') {
  let d = String(phone || '').replace(/[^\d+]/g, '');
  if (!d) return '';
  if (d.startsWith('+')) return d.slice(1).replace(/\D/g, '');
  d = d.replace(/\D/g, '');
  if (d.startsWith('00')) return d.slice(2);
  if (d.length === 9) return String(countryCode || '').replace(/\D/g, '') + d;
  return d;
}

// ---------------------------------------------------------------- datum a čas

const NUM = {
  nula: 0, jedna: 1, jeden: 1, jednu: 1, dva: 2, dve: 2, dvou: 2, tri: 3, ctyri: 4, pet: 5, sest: 6, sedm: 7, osm: 8,
  devet: 9, deset: 10, jedenact: 11, dvanact: 12, trinact: 13, ctrnact: 14, patnact: 15, sestnact: 16, sedmnact: 17,
  osmnact: 18, devatenact: 19, dvacet: 20, tricet: 30, ctyricet: 40, padesat: 50, sedesat: 60,
};
const ORD = { jedne: 1, druhe: 2, treti: 3, ctvrte: 4, pate: 5, seste: 6, sedme: 7, osme: 8, devate: 9, desate: 10, jedenacte: 11, dvanacte: 12 };
const MONTHS = ['ledna', 'unora', 'brezna', 'dubna', 'kvetna', 'cervna', 'cervence', 'srpna', 'zari', 'rijna', 'listopadu', 'prosince'];
const WEEKDAYS = { nedeli: 0, nedele: 0, pondeli: 1, pondelek: 1, utery: 2, uterek: 2, stredu: 3, streda: 3, ctvrtek: 4, patek: 5, sobotu: 6, sobota: 6 };
const NUMW = Object.keys(NUM).join('|');
const ORDW = Object.keys(ORD).join('|');
const HOURW = 'jednu|dve|tri|ctyri|pet|sest|sedm|osm|devet|deset|jedenact|dvanact';
const AMOUNT = `\\d+|${NUMW}|pul|ctvrt|tri ?ctvrte`;

const num = s => (s == null ? NaN : /^\d+$/.test(s) ? Number(s) : s in NUM ? NUM[s] : s in ORD ? ORD[s] : NaN);

function amountOf(a) {
  if (a == null || a === '') return 1;
  if (a === 'pul') return 0.5;
  if (a === 'ctvrt') return 0.25;
  if (/^tri ?ctvrte$/.test(a)) return 0.75;
  return num(a);
}

function durationMs(amount, unit) {
  const a = amountOf(amount);
  if (!Number.isFinite(a)) return NaN;
  if (/^min/.test(unit)) return a * 60000;
  if (/^h/.test(unit)) return a * 3600000;
  if (/^(sek|vterin)/.test(unit)) return a * 1000;
  return NaN;
}

const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());

// Najde v textu datum a čas. Vrací { start, end, allDay, hasDate, hasTime, rest } nebo null.
// `rest` je původní text bez časových výrazů (z něj se bere název události / text připomínky).
export function parseWhen(text, now = new Date()) {
  const orig = String(text ?? '').normalize('NFC');
  const f = fold(orig);
  const spans = [];
  const take = (re, fn) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(f))) {
      const a = m.index;
      const b = m.index + m[0].length;
      if (!m[0].length) { re.lastIndex++; continue; }
      if (spans.some(([x, y]) => a < y && b > x)) continue;
      if (fn(m) === false) continue;
      spans.push([a, b]);
    }
  };

  let day = null;          // půlnoc zvoleného dne
  let weekdayToday = false;
  let time = null;         // { h, m }
  let endTime = null;
  let durMs = null;
  let allDay = false;
  let rel = null;          // „za 10 minut“
  let part = null;         // rano | dopoledne | odpoledne | vecer | noc
  let ampmFixed = false;   // hodina je jednoznačná (15:30, poledne…)
  const today = startOfDay(now);

  // --- „za 10 minut“, „za hodinu“, „za půl hodiny“, „za hodinu a půl“
  take(new RegExp(`\\bza (?:(${AMOUNT}) )?(minutu|minuty|minut|min|hodinku|hodinu|hodiny|hodin|hod|h|sekund\\w*|vterin\\w*)(?: a (pul|ctvrt))?\\b`, 'g'), m => {
    let ms = durationMs(m[1], m[2]);
    if (!Number.isFinite(ms)) return false;
    if (m[3]) ms += (m[3] === 'pul' ? 0.5 : 0.25) * (/^h/.test(m[2]) ? 3600000 : 60000);
    rel = new Date(now.getTime() + ms);
    return true;
  });

  // --- dny
  take(/\b(dneska|dnes)\b/g, () => { day = today; });
  take(/\bpozitri\b/g, () => { day = addDays(today, 2); });
  take(/\bzitra\b/g, () => { day = addDays(today, 1); });
  take(new RegExp(`\\bza (\\d+|${NUMW}) (den|dny|dni|dnu)\\b`, 'g'), m => { day = addDays(today, num(m[1])); });
  take(/\bza tyden\b/g, () => { day = addDays(today, 7); });
  take(new RegExp(`\\bza (\\d+|${NUMW}) (tydny|tydnu)\\b`, 'g'), m => { day = addDays(today, 7 * num(m[1])); });
  take(/\bza mesic\b/g, () => { day = new Date(today.getFullYear(), today.getMonth() + 1, today.getDate()); });

  // --- 5. prosince [2026] / 5.12.[2026]
  take(new RegExp(`\\b(\\d{1,2})\\.? (${MONTHS.join('|')})(?: (\\d{4}))?\\b`, 'g'), m => {
    const mo = MONTHS.indexOf(m[2]);
    const dd = Number(m[1]);
    if (dd < 1 || dd > 31) return false;
    let y = m[3] ? Number(m[3]) : today.getFullYear();
    let d = new Date(y, mo, dd);
    if (!m[3] && d < today) d = new Date(++y, mo, dd);
    day = d;
    return true;
  });
  take(/(?<![\d:.])(?<!\b(?:v|ve|od|do|na) )(\d{1,2})\. ?(\d{1,2})\.(?: ?(\d{4}))?(?!\d)/g, m => {
    const dd = Number(m[1]);
    const mo = Number(m[2]) - 1;
    if (dd < 1 || dd > 31 || mo < 0 || mo > 11) return false;
    let y = m[3] ? Number(m[3]) : today.getFullYear();
    let d = new Date(y, mo, dd);
    if (!m[3] && d < today) d = new Date(++y, mo, dd);
    day = d;
    return true;
  });

  // --- dny v týdnu („v pátek“, „příští středu“)
  take(new RegExp(`\\b(?:(pristi|tento|tuto|tuhle|tenhle) )?(?:v |ve )?(?:(pristi|tento|tuto|tuhle|tenhle) )?(${Object.keys(WEEKDAYS).join('|')})\\b`, 'g'), m => {
    if (day) return false;
    const wd = WEEKDAYS[m[3]];
    const mod = m[1] || m[2];
    let diff = (wd - today.getDay() + 7) % 7;
    if (mod === 'pristi') {
      const toNextMonday = ((8 - today.getDay()) % 7) || 7;
      diff = toNextMonday + ((wd + 6) % 7);
    }
    day = addDays(today, diff);
    weekdayToday = diff === 0;
    return true;
  });

  // --- části dne
  take(/\b(rano|dopoledne|odpoledne|vecer|v noci)\b/g, m => { part = m[1] === 'v noci' ? 'noc' : m[1]; });

  // --- trvání „na hodinu“, „na 30 minut“, „na půl hodiny“ (dřív než časy, ať „na 2 hodiny“ není 14:00)
  take(new RegExp(`\\bna (?:(${AMOUNT}) )?(minutu|minuty|minut|min|hodinku|hodinu|hodiny|hodin|hod|h)\\b`, 'g'), m => {
    if (m[2] === 'hodin' && num(m[1]) >= 7) return false;      // „na 10 hodin“ je čas, ne trvání
    const ms = durationMs(m[1], m[2]);
    if (!Number.isFinite(ms)) return false;
    durMs = ms;
    return true;
  });
  take(/\bcely den\b|\bcelodenn\w+/g, () => { allDay = true; });

  // --- „v půl čtvrté“, „ve čtvrt na pět“, „ve tři čtvrtě na pět“
  take(new RegExp(`\\b(?:v |ve |na |od )?pul (${ORDW}|\\d{1,2})\\b`, 'g'), m => {
    const h = num(m[1]);
    if (!(h >= 1 && h <= 12)) return false;
    time = { h: h - 1 || 12, m: 30 };
    return true;
  });
  take(new RegExp(`\\b(?:v |ve |na |od )?(tri ?ctvrte|ctvrt) na (${HOURW}|\\d{1,2})\\b`, 'g'), m => {
    const h = num(m[2]);
    if (!(h >= 1 && h <= 12)) return false;
    time = { h: h - 1 || 12, m: m[1] === 'ctvrt' ? 15 : 45 };
    return true;
  });
  take(/\b(?:v |na )?poledne\b/g, () => { time = { h: 12, m: 0 }; ampmFixed = true; });
  take(/\b(?:o |v )pulnoci\b/g, () => { time = { h: 0, m: 0 }; ampmFixed = true; });

  // --- „od 10 do 12“, „v 15:30“, „ve 3“, „v 9 hodin“
  const T = `(\\d{1,2})(?:[:.](\\d{2}))?(?: ?(?:hodin\\w*|hod\\b|h\\b))?`;
  take(new RegExp(`\\b(?:od|v|ve) ${T} (?:do|az do|-|–) ${T}(?![\\d.])`, 'g'), m => {
    if (time) return false;
    const h1 = Number(m[1]);
    const h2 = Number(m[3]);
    if (h1 > 24 || h2 > 24 || Number(m[2] || 0) > 59 || Number(m[4] || 0) > 59) return false;
    time = { h: h1 % 24, m: Number(m[2] || 0) };
    endTime = { h: h2 % 24, m: Number(m[4] || 0) };
    ampmFixed = h1 > 12 || h1 === 0;
    return true;
  });
  take(new RegExp(`\\b(?:v|ve|od|na) ${T}(?![\\d.]|:\\d)`, 'g'), m => {
    if (time) return false;
    const h = Number(m[1]);
    const mi = Number(m[2] || 0);
    if (h > 24 || mi > 59) return false;
    time = { h: h % 24, m: mi };
    ampmFixed = h > 12 || h === 0;
    return true;
  });
  take(new RegExp(`\\b(?:v|ve|od|na) (${HOURW})(?: hodin\\w*)?\\b`, 'g'), m => {
    if (time) return false;
    time = { h: num(m[1]), m: 0 };
    return true;
  });
  take(/(?<![\d.:])(\d{1,2}):(\d{2})(?![\d:])/g, m => {      // samotné „15:30“
    if (time) return false;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return false;
    time = { h, m: mi };
    ampmFixed = h > 12 || h === 0;
    return true;
  });
  if (time && !endTime) {
    take(new RegExp(`\\bdo ${T}(?![\\d.])`, 'g'), m => {       // „do 12“ jako konec
      if (endTime) return false;
      const h = Number(m[1]);
      if (h > 24 || Number(m[2] || 0) > 59) return false;
      endTime = { h: h % 24, m: Number(m[2] || 0) };
      return true;
    });
  }

  if (!spans.length) return null;

  // --- dopoledne / odpoledne
  const fixHour = t => {
    if (!t) return t;
    let { h } = t;
    if (part === 'odpoledne' || part === 'vecer') { if (h < 12) h += 12; }
    else if (part === 'noc') { if (h === 12) h = 0; else if (h >= 6 && h < 12) h += 12; }
    else if (!part && !ampmFixed && h >= 1 && h <= 6) h += 12;   // „ve 3“ = 15:00
    return { h: h % 24, m: t.m };
  };
  const partDefault = { rano: 8, dopoledne: 10, odpoledne: 15, vecer: 19, noc: 22 };
  if (!time && part && !rel) { time = { h: partDefault[part], m: 0 }; ampmFixed = true; part = null; }
  time = fixHour(time);
  if (endTime) {
    endTime = fixHour(endTime);
    const before = endTime.h < time.h || (endTime.h === time.h && endTime.m <= time.m);
    if (before && endTime.h < 12) endTime = { h: endTime.h + 12, m: endTime.m };
  }

  let start;
  let hasDate = !!day;
  const hasTime = !!time || !!rel;
  if (rel && !day && !time) {
    start = rel;
    hasDate = true;
  } else {
    const base = day || (rel ? startOfDay(rel) : today);
    if (time) {
      start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), time.h, time.m);
      // bez určeného dne (nebo „v pátek“ řečené v pátek) a čas už byl → další výskyt
      if (start <= now && (!day || weekdayToday)) start = addDays(start, day ? 7 : 1);
    } else {
      start = new Date(base);
      allDay = true;
    }
  }

  let end = null;
  if (!allDay) {
    if (endTime) {
      end = new Date(start.getFullYear(), start.getMonth(), start.getDate(), endTime.h, endTime.m);
      if (end <= start) end = addDays(end, 1);
    } else if (durMs) end = new Date(start.getTime() + durMs);
  }

  // --- zbytek textu bez časových výrazů
  spans.sort((a, b) => a[0] - b[0]);
  let rest = '';
  let pos = 0;
  for (const [a, b] of spans) {
    if (a > pos) rest += `${orig.slice(pos, a)} `;
    pos = Math.max(pos, b);
  }
  rest = clean((rest + orig.slice(pos)).replace(/\s+([,.])/g, '$1'));
  if (/^(?:na|v|ve|od|do|a|u|ze|s|se|at)$/i.test(fold(rest))) rest = '';

  return { start, end, allDay, hasDate, hasTime, rest };
}

const pad = n => String(n).padStart(2, '0');
export const toLocalIso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const hhmm = d => `${d.getHours()}:${pad(d.getMinutes())}`;
const DAY_IN = ['v neděli', 'v pondělí', 'v úterý', 've středu', 've čtvrtek', 'v pátek', 'v sobotu'];

export function fmtDay(date, now = new Date()) {
  const d = startOfDay(new Date(date));
  const diff = Math.round((d - startOfDay(now)) / 86400000);
  if (diff === 0) return 'dnes';
  if (diff === 1) return 'zítra';
  if (diff === 2) return 'pozítří';
  if (diff === -1) return 'včera';
  if (diff > 2 && diff < 7) return DAY_IN[d.getDay()];
  return `${DAY_IN[d.getDay()]} ${d.getDate()}. ${d.getMonth() + 1}.${d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ''}`;
}

export function fmtWhen(date, allDay = false, now = new Date()) {
  const d = new Date(date);
  return allDay ? `${fmtDay(d, now)} (celý den)` : `${fmtDay(d, now)} v ${hhmm(d)}`;
}

// Věta o tom, co je v kalendáři (používá server i aplikace bez počítače).
export function describeEvents(events, from, to, label, now = new Date()) {
  const multi = Number(to) - Number(from) > 86400000 + 1000;
  const what = cap(label || fmtDay(new Date(Number(from)), now));
  if (!events.length) return `${what} nemáš v kalendáři nic.`;
  const parts = events.slice(0, 8).map(e => {
    const day = multi ? `${fmtDay(new Date(e.start), now)} ` : '';
    return e.allDay ? `${day}celý den ${e.title}` : `${day}v ${hhmm(new Date(e.start))} ${e.title}`;
  });
  const n = events.length;
  const noun = n === 1 ? 'jednu událost' : n < 5 ? `${n} události` : `${n} událostí`;
  return `${what} máš ${noun}: ${parts.join(', ')}${n > 8 ? ` a dalších ${n - 8}` : ''}.`;
}

// ---------------------------------------------------------------- povely

const WA =`(?:whats ?app\\w*|whats ?up\\w*|what'?s ?up\\w*|[wv][oa]t?[sc] ?ap\\w*|[wv][oa]cap\\w*)`;
const SMS = `(?:sms\\w*|esemes\\w*|textovk\\w*)`;
const MAIL = `(?:(?:e-?mail|mejl|mail)(?:u|em|ik|ika|ikem|em)?)`;
const VSC = `(?:v\\.? ?s\\.? ?(?:code|kod|coud|cod|kot|kout)\\w*|vscode\\w*|visual studio(?: code)?|ve ?es ?(?:code|kod)\\w*|vieska|editor(?: kodu)?)`;
const SEND = `(?:napis|napsat|posli|poslat|odesli|odeslat)`;
const OPEN = `(?:otevri|otevrit|spust|spustit|zapni|pust|nastartuj)`;
const PLEASE = `(?:prosim(?: te| vas)?,? |hej,? |ahoj,? )?`;
const PC = `(?:pocitaci|pocitac|pc|kompu|notebooku)`;

const TITLE_NOM = {
  schuzku: 'Schůzka', poradu: 'Porada', veceri: 'Večeře', navstevu: 'Návštěva', prohlidku: 'Prohlídka',
  kontrolu: 'Kontrola', lekci: 'Lekce', zkousku: 'Zkouška', rezervaci: 'Rezervace', prezentaci: 'Prezentace',
  konzultaci: 'Konzultace', oslavu: 'Oslava', prednasku: 'Přednáška', hodinu: 'Hodina', cestu: 'Cesta', akci: 'Akce',
};

function eventTitle(rest) {
  let t = clean(rest);
  t = clean(cutFolded(t, /^(?:ze mam|ze je|ze bude|mam|bude|je|na|u|ze) /));
  t = clean(cutFolded(t, /^(?:udalost s nazvem|akci s nazvem|udalost|termin)(?: |$)/));
  if (!t) return '';
  const first = t.split(' ')[0];
  const nom = TITLE_NOM[norm(first)];
  if (nom) t = nom + t.slice(first.length);
  return cap(t);
}

function channelOf(word) {
  const w = norm(word);
  if (new RegExp(`^${SMS}$`).test(w)) return 'sms';
  if (new RegExp(`^${MAIL}$`).test(w)) return 'mail';
  return 'whatsapp';
}

// Kus původního textu odpovídající pojmenované skupině regexu nad „složeným“ textem.
function groupText(orig, m, name) {
  const idx = m.indices?.groups?.[name];
  return idx ? orig.slice(idx[0], idx[1]) : '';
}

const WD_WORDS = Object.keys(WEEKDAYS).join('|');
const LIST_NOISE = new RegExp([
  `\\b(?:v kalendari|v planu|na programu|za program|program|naplanovan\\w*|v diari|schuzk\\w*|udalost\\w*|termin\\w*)\\b`,
  `\\b(?:dneska|dnes|zitra|pozitri|pristi tyden|tento tyden|tenhle tyden|cely tyden|tyden|o vikendu|na vikend|vikend)\\b`,
  `\\b(?:pristi |tento |tuto )?(?:v |ve |na )?(?:pristi |tento |tuto )?(?:${WD_WORDS})\\b`,
  `\\b\\d{1,2}\\.? (?:${MONTHS.join('|')})\\b`,
  `\\b\\d{1,2}\\. ?\\d{1,2}\\.?`,
  `\\b(?:na|za|ted|jeste|vse|vsechno|me|mi|tam)\\b`,
  `[?,.]`,
].join('|'), 'g');

function listRange(tail, now) {
  const today = startOfDay(now);
  if (/\bpristi tyden\b/.test(tail)) {
    const toMon = ((8 - today.getDay()) % 7) || 7;
    const from = addDays(today, toMon);
    return { from, to: addDays(from, 7), label: 'příští týden' };
  }
  if (/\btyden\b/.test(tail)) {
    const toSun = (7 - today.getDay()) % 7;
    return { from: today, to: addDays(today, toSun + 1), label: 'tento týden' };
  }
  if (/\bvikend\w*\b/.test(tail)) {
    const toSat = (6 - today.getDay() + 7) % 7;
    const from = addDays(today, toSat);
    return { from, to: addDays(from, 2), label: 'o víkendu' };
  }
  const w = parseWhen(tail, now);
  if (w && w.hasDate) {
    const from = startOfDay(w.start);
    return { from, to: addDays(from, 1), label: fmtDay(from, now) };
  }
  if (/\b(kalendar|plan|program|schuzk|udalost|termin)/.test(tail)) return { from: today, to: addDays(today, 7), label: 'v příštích 7 dnech' };
  return null;
}

/**
 * Rozpozná rychlý povel. Vrací null (není to rychlý povel → pošli Claudovi), nebo
 * { id, args, need? } – `need` je vysvětlení, když povelu něco chybí.
 * ctx: { people, now, messenger: 'whatsapp'|'sms', strict } – `strict` = konverzace nad projektem,
 * kde se dvojznačné věty („vyhledej…“) nechávají Claudovi.
 */
export function parseIntent(text, ctx = {}) {
  const now = ctx.now || new Date();
  const people = ctx.people || [];
  const orig = stripEnd(String(text ?? '').normalize('NFC').replace(/\s+/g, ' '));
  if (!orig) return null;
  const f = fold(orig);
  let m;
  const re = src => new RegExp(src, 'd');

  // „Claude, …“ = vynutit Clauda
  if ((m = re(`^(?:claude?|clode|klode|klaude?|kloude)[,:]? +(?<rest>.+)$`).exec(f))) return { id: 'claude', args: { text: groupText(orig, m, 'rest') } };

  // ---------- nápověda, čas
  if (/^(co (vsechno )?umis|napoveda|pomoc|help|co (ti )?(muzu|mohu) (rict|rikat)|jake znas povely)\??$/.test(f)) return { id: 'help', args: {} };
  if (/^(kolik je( ted)? hodin|kolik je|jaky je cas)\??$/.test(f)) return { id: 'time', args: {} };
  if (/^(jake je( dnes| dneska)? datum|kolikateho je( dnes| dneska)?|co je( dnes| dneska) za den|jaky je( dnes| dneska) den)\??$/.test(f)) return { id: 'date', args: {} };

  // ---------- automatický režim, nerušit
  if ((m = /^(zapni|zapnout|aktivuj|povol|vypni|vypnout|zrus|deaktivuj|zakaz) (automatick\w+( rezim)?|automatiku|automat|auto rezim)$/.exec(f))) {
    return { id: 'auto', args: { on: /^(zapn|aktiv|povol)/.test(m[1]) } };
  }
  if (/^(zrus nerusit|uz (me )?muzes (zase )?rusit|muzes (me )?(zase )?rusit|konec ticha|zapni (zase )?upozorneni|zrus ticho|vypni nerusit)$/.test(f)) return { id: 'snooze', args: { minutes: 0 } };
  if ((m = re(`^${PLEASE}(?:nerus|nerusit|nevyrusuj|ztlum upozorneni|vypni upozorneni)(?: me| mne)?(?: (?:na |po dobu )?(?<dur>.+))?$`).exec(f))) {
    let minutes = 60;
    const dur = m.groups.dur;
    let ok = true;
    if (dur) {
      const dm = new RegExp(`^(?:(${AMOUNT}) )?(minut\\w*|min|hodin\\w*|hod|h)$`).exec(dur);
      if (dm) minutes = Math.round(durationMs(dm[1], dm[2]) / 60000);
      else {
        const w = parseWhen(dur.replace(/^do /, 'v '), now);
        if (w && w.hasTime) minutes = Math.max(1, Math.round((w.start - now) / 60000)); else ok = false;
      }
    }
    if (ok && Number.isFinite(minutes) && minutes > 0) return { id: 'snooze', args: { minutes } };
  }

  // ---------- co je nového
  if (/^(co je noveho|co mam noveho|mam neco noveho|neco noveho|co mi uteklo|kdo( mi)? (psal|volal|se ozval)|precti( mi)?( nove| posledni| dulezite)? (zpravy|upozorneni|novinky|oznameni|postu|maily|e-?maily))\??$/.test(f)) {
    return { id: 'inbox', args: {} };
  }

  // ---------- VS Code
  if ((m = re(`^${PLEASE}${OPEN}(?: mi)? (?:(?:projekt|slozku) )?(?<proj>.+?) (?:ve?|do) ${VSC}$`).exec(f))) {
    return { id: 'vscode', args: { project: clean(groupText(orig, m, 'proj')) } };
  }
  if ((m = re(`^${PLEASE}${OPEN}(?: mi)?(?: na ${PC})? ${VSC}(?: na ${PC})?(?: (?:ve slozce|v projektu|s projektem|pro projekt|na projektu|ve|v|s|se|pro|na) (?<proj>.+))?$`).exec(f))) {
    return { id: 'vscode', args: { project: clean(groupText(orig, m, 'proj')) } };
  }

  // ---------- otevřít něco na počítači
  if ((m = re(`^${PLEASE}${OPEN}(?: mi)? (?<what>.+?) na ${PC}$`).exec(f)) ||
      (m = re(`^${PLEASE}${OPEN}(?: mi)? na ${PC} (?<what>.+)$`).exec(f))) {
    return { id: 'pc_open', args: { target: clean(groupText(orig, m, 'what')) } };
  }

  // ---------- volání („zavolej mi za 10 minut“ je připomínka, tu řeší níž)
  if (!/^(?:prosim )?(?:zavolej|zavolat) mi\b/.test(f) &&
      (m = re(`^${PLEASE}(?:zavolej|zavolat|volej|vytoc|vytocit)(?: na(?: cislo)?)? (?<to>.+)$`).exec(f))) {
    const to = clean(groupText(orig, m, 'to'));
    const digits = to.replace(/[^\d+]/g, '');
    if (digits.replace(/\D/g, '').length >= 9 && /^[\d\s+()/-]+$/.test(to)) return { id: 'call', args: { number: digits, to } };
    const hit = findPerson(people, to);
    if (hit) return { id: 'call', args: { to: hit.person.name, person: hit.person } };
    if (!ctx.strict && to.split(' ').length <= 2) return { id: 'call', args: { to }, need: `„${to}“ nemám v kontaktech. Přidej ho v Nastavení → Lidé.` };
  }

  // ---------- zprávy
  const mkMsg = (toRaw, chRaw, conj, msgRaw) => {
    const to = clean(cutFolded(toRaw, /^(?:pro|na) /));
    if (!to || to.split(' ').length > 3) return null;
    const channel = chRaw ? channelOf(chRaw) : (ctx.messenger === 'sms' ? 'sms' : 'whatsapp');
    const hit = findPerson(people, to);
    const c = norm(conj || '');
    const msg = cap(clean(msgRaw));
    if (!msg) return null;
    return {
      id: channel,
      args: { to: hit ? hit.person.name : to, person: hit ? hit.person : null, text: msg, rephrase: ['at', 'aby', 'jestli', 'zda'].includes(c) },
      known: !!hit,
    };
  };
  const done = r => { const { known, ...rest } = r; return rest; };
  const CH = `(?<ch>${WA}|${SMS}|${MAIL})`;
  const CONJ = `(?<conj>ze|at|aby|jestli|zda|text|zpravu|zneni)`;
  const msgPatterns = [
    // napiš Petrovi na WhatsApp, že přijdu později
    `^${PLEASE}${SEND}(?: zprav\\w+)? (?<to>.+?) (?:na|pres|do|skrz|pomoci) ${CH}(?: zprav\\w+)?(?:[,:]? ${CONJ})?[,:]? (?<msg>.+)$`,
    // napiš na WhatsApp Petrovi, že přijdu později
    `^${PLEASE}${SEND}(?: zprav\\w+)? (?:na|pres|do|skrz) ${CH} (?<to>.+?)(?:[,:]? ${CONJ}|[,:]) ?(?<msg>.+)$`,
    // pošli Petrovi SMS, že…  /  napiš Petrovi mail, že…
    `^${PLEASE}${SEND} (?<to>.+?) ${CH}(?: zprav\\w+)?(?:[,:]? ${CONJ})?[,:]? (?<msg>.+)$`,
    // WhatsApp Petrovi: přijdu později
    `^${CH}(?: zprav\\w+)?(?: pro| na)? (?<to>[^\\s,:]+(?: [^\\s,:]+)?)(?:[,:]? ${CONJ}|[,:]) ?(?<msg>.+)$`,
  ];
  for (const p of msgPatterns) {
    if (!(m = re(p).exec(f))) continue;
    const r = mkMsg(groupText(orig, m, 'to'), m.groups.ch, m.groups.conj, groupText(orig, m, 'msg'));
    if (r && (r.known || !ctx.strict || r.id !== 'mail')) return done(r);
  }
  // napiš Petrovi, že přijdu později (bez kanálu – jen když Petra znám)
  if ((m = re(`^${PLEASE}${SEND}(?: zprav\\w+)? (?<to>.+?)[,:]? (?<conj>ze|at|aby) (?<msg>.+)$`).exec(f))) {
    const r = mkMsg(groupText(orig, m, 'to'), null, m.groups.conj, groupText(orig, m, 'msg'));
    if (r && r.known) return done(r);
  }

  // ---------- navigace, hledání, YouTube
  if ((m = re(`^${PLEASE}(?:naviguj|navigace|navigovat|naved|ukaz cestu|najdi cestu|jak se dostanu|jak se dostat)(?: me| mne| nas| mi)?(?: do| na| k| ke| az k)? (?<dest>.+)$`).exec(f))) {
    return { id: 'navigate', args: { destination: clean(groupText(orig, m, 'dest')) } };
  }
  if ((m = re(`^${PLEASE}(?:pust|prehraj|zapni|najdi|vyhledej|hledej)(?: mi)? (?<q>.+?) na (?:youtube|you tube|jutubu|youtubu|jutube)$`).exec(f)) ||
      (m = re(`^(?:youtube|na youtube) (?<q>.+)$`).exec(f))) {
    return { id: 'youtube', args: { query: clean(groupText(orig, m, 'q')) } };
  }
  if ((m = re(`^${PLEASE}(?:vygoogli|zagoogli|vygooglit|googli)(?: mi)? (?<q>.+)$`).exec(f)) ||
      (m = re(`^${PLEASE}(?:najdi|hledej|vyhledej|vyhledat)(?: mi)? na (?:googlu|internetu|webu|netu) (?<q>.+)$`).exec(f)) ||
      (m = re(`^${PLEASE}(?:najdi|hledej|vyhledej|vyhledat)(?: mi)? (?<q>.+?) na (?:googlu|internetu|webu|netu)$`).exec(f)) ||
      (!ctx.strict && (m = re(`^${PLEASE}(?:vyhledej|vyhledat)(?: mi)? (?<q>.+)$`).exec(f)))) {
    return { id: 'search', args: { query: clean(groupText(orig, m, 'q')) } };
  }

  // ---------- kalendář: přidat
  const ADD = `(?:pridej|pridat|zapis|zapsat|dej|hod|vloz|uloz|napis|zaznamenej|zadej|naplanuj|naplanovat|vytvor|vytvorit|zaloz|zarad)`;
  const mAdd = re(`^${PLEASE}${ADD}(?: mi| si)? (?<body>.+)$`).exec(f);
  const planned = new RegExp(`^${PLEASE}(?:naplanuj|naplanovat|vytvor|vytvorit|zaloz)(?: mi| si)? (?:schuzku|udalost|termin|poradu|hovor|call|meeting|jednani)\\b`).test(f);
  if (mAdd && (/\b(?:do|v) kalendar\w*/.test(f) || planned)) {
    const body = cutFolded(groupText(orig, mAdd, 'body'), /\b(?:do|v) kalendar\w*/);
    const w = parseWhen(body, now);
    if (!w) return { id: 'calendar_add', args: { title: eventTitle(body) }, need: 'Neřekl jsi, kdy to má být. Zkus třeba: „přidej do kalendáře zítra v 10 zubaře“.' };
    const end = w.end || (w.allDay ? null : new Date(w.start.getTime() + 3600000));
    return { id: 'calendar_add', args: { title: eventTitle(w.rest), start: toLocalIso(w.start), end: end ? toLocalIso(end) : null, allDay: w.allDay } };
  }

  // ---------- kalendář: co mám
  if ((m = /^(?:co (?:mam|me ceka|nas ceka|je)|jaky (?:mam|je)|jake (?:mam|jsou))\b(.*)$/.exec(f))) {
    const tail = m[1];
    const left = tail.replace(LIST_NOISE, ' ').replace(/\s+/g, '');
    const r = !left && listRange(tail, now);
    if (r) return { id: 'calendar_list', args: { from: toLocalIso(r.from), to: toLocalIso(r.to), label: r.label } };
  }

  // ---------- časovač, připomínky
  if ((m = re(`^${PLEASE}(?:nastav |spust |zapni )?(?:casovac|minutku|minutka|odpocet)(?: na)? (?<dur>.+)$`).exec(f))) {
    const w = parseWhen(`za ${m.groups.dur.replace(/^za /, '')}`, now);
    if (w && w.hasTime) return { id: 'remind', args: { at: toLocalIso(w.start), atMs: w.start.getTime(), text: 'Časovač doběhl' } };
  }
  const REM = `(?:pripomen|pripomenout|pripominka|upozorni|vzbud)`;
  let body = null;
  let strong = false;      // věta začíná povelem → když chybí čas, řekni si o něj
  if ((m = re(`^${PLEASE}(?<verb>${REM}|zavolej mi|ozvi se mi)(?: mi| me| mne)?[,:]? ?(?<rest>.*)$`).exec(f))) {
    body = groupText(orig, m, 'rest');
    strong = /^(pripom|vzbud)/.test(m.groups.verb);
  } else if ((m = re(`^(?<pre>.+?) (?:mi |me )?${REM}(?: mi| me)?[,:]? ?(?<rest>.*)$`).exec(f))) {
    body = `${groupText(orig, m, 'pre')} ${groupText(orig, m, 'rest')}`;
  }
  if (body != null) {
    const w = parseWhen(body, now);
    if (w) {
      let at = w.start;
      if (w.allDay) at = new Date(at.getFullYear(), at.getMonth(), at.getDate(), 9, 0);
      let t = clean(cutFolded(w.rest, /^(?:ze|at|abych|aby|na|o) /));
      t = clean(cutFolded(t, /^(?:ze|at|abych|aby) /));
      return { id: 'remind', args: { at: toLocalIso(at), atMs: at.getTime(), text: cap(t) || (/\bvzbud/.test(f) ? 'Budíček' : 'Připomínka') } };
    }
    if (strong) return { id: 'remind', args: { text: clean(body) }, need: 'Neřekl jsi, kdy ti to mám připomenout. Zkus: „připomeň mi za 20 minut vypnout troubu“.' };
  }

  return null;
}

// Příklady pro nápovědu v aplikaci
export const EXAMPLES = [
  { group: 'Zprávy a hovory', phone: true, items: ['napiš Petrovi na WhatsApp, že dorazím v pět', 'pošli mámě SMS, že volám večer', 'zavolej Petrovi'] },
  { group: 'Kalendář a připomínky', phone: true, items: ['přidej do kalendáře zítra v 10 zubaře', 'naplánuj schůzku s Janou v pátek ve 2 na hodinu', 'co mám zítra?', 'připomeň mi za 20 minut vypnout troubu'] },
  { group: 'Počítač', items: ['otevři VS Code', 'otevři projekt talktoclaude ve VS Code', 'otevři spotify na počítači'] },
  { group: 'Hlídání', items: ['co je nového?', 'neruš mě hodinu', 'zapni automatický režim'] },
  { group: 'Telefon', phone: true, items: ['naviguj na Hlavní nádraží Praha', 'vyhledej otevírací dobu IKEA', 'pusť lofi na YouTube'] },
];
