// Dovednosti: běžné úkoly, které jdou vyřídit hned a bez přemýšlení.
//  • rychlé povely z aplikace je volají přímo (bez Clauda, zadarmo),
//  • Claude je dostává jako nástroje mcp__ttc__*, takže mu stačí jedno volání místo zkoumání počítače.
import path from 'node:path';
import crypto from 'node:crypto';
import { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { findPerson, phoneDigits, fmtWhen, hhmm, describeEvents } from '../public/intents.js';
import * as pc from './pc.js';
import { errText } from './store.js';

const DAY = 86400000;
const startOfDay = ts => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function describeInbox(items) {
  const important = items.filter(i => i.level === 'vip' || i.level === 'important');
  if (!items.length) return 'Nic nového.';
  if (!important.length) return `Nic důležitého. Jen ${items.length} běžných oznámení – najdeš je v Přehledu.`;
  const parts = important.slice(0, 5).map(i => {
    const head = i.source === 'mail' ? `e-mail od ${i.from}` : i.source === 'calendar' || i.source === 'reminder' ? i.from : `${i.app}, ${i.from}`;
    const body = [i.title, i.text].filter(Boolean).join('. ').slice(0, 160);
    return `${head}: ${body}`;
  });
  const more = important.length > 5 ? ` A dalších ${important.length - 5}.` : '';
  return `${important.length === 1 ? 'Jedna důležitá novinka' : `Důležitých novinek: ${important.length}`}. ${parts.join('. ')}.${more}`;
}

/**
 * ctx: { settings(), config, calendar, inbox, alert(item), phoneAction(action), setSnooze(min),
 *        projectRoots(), startCodingTask(task, folder), }
 */
export function createSkills(ctx) {
  const people = () => ctx.settings().people;
  const cc = () => ctx.settings().skills.countryCode;

  // Najde příjemce: člověk z kontaktů, nebo přímo číslo / e-mail.
  function recipient(to) {
    const raw = String(to || '').trim();
    const hit = findPerson(people(), raw);
    if (hit) return { name: hit.person.name, number: phoneDigits(hit.person.phone, cc()), email: hit.person.email || '' };
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return { name: raw, number: '', email: raw };
    if (/^[\d\s+()/-]{9,}$/.test(raw)) return { name: raw, number: phoneDigits(raw, cc()), email: '' };
    return { name: raw, number: '', email: '', unknown: true };
  }

  const run = {
    async vscode({ project }, env = {}) {
      let folder;
      if (project) {
        folder = await pc.findProject(project, ctx.projectRoots());
        if (!folder) return { ok: false, text: `Složku „${project}“ jsem na počítači nenašel.` };
      } else {
        folder = env.session && env.session.kind !== 'assistant' ? env.session.cwd : ctx.projectRoots()[0];
      }
      await pc.openVsCode(folder, ctx.config.vscodePath);
      return { ok: true, text: `Otevírám VS Code${folder ? ` ve složce ${path.basename(folder)}` : ''}.` };
    },

    async pc_open({ target }) {
      return { ok: true, text: await pc.openOnPc(target, ctx.config.apps) };
    },

    async whatsapp_pc({ to, text }) {
      const r = recipient(to);
      await pc.whatsappDraft(r.number, text);
      return { ok: true, text: `WhatsApp na počítači je otevřený se zprávou pro ${r.name}. Odeslat ji musíš ty.` };
    },

    async calendar_add(args) {
      const ev = ctx.calendar.add({ title: args.title, start: args.start, end: args.end, allDay: args.allDay ?? args.all_day, location: args.location, notes: args.notes });
      return { ok: true, text: `Zapsáno do kalendáře: ${ev.title}, ${fmtWhen(ev.start, ev.allDay)}.`, data: { event: ev } };
    },

    async calendar_list({ from, to, label }) {
      const a = from ? Number(new Date(from)) : startOfDay(Date.now());
      const b = to ? Number(new Date(to)) : a + DAY;
      if (!Number.isFinite(a) || !Number.isFinite(b)) return { ok: false, text: 'Nerozumím datu.' };
      const events = ctx.calendar.list(a, b - 1);
      return { ok: true, text: describeEvents(events, a, b, label), data: { events } };
    },

    async remind({ at, text }) {
      const r = ctx.calendar.addReminder({ at, text });
      return { ok: true, text: `Připomenu ti ${fmtWhen(r.at)}: ${r.text}.`, data: { reminder: r } };
    },

    async inbox({ limit = 30, hours = 24 } = {}) {
      const items = ctx.inbox.recent(limit, Date.now() - hours * 3600000, true);
      const text = describeInbox(items);
      ctx.inbox.markSeen(items.map(i => i.id));
      return { ok: true, text, data: { count: items.length } };
    },

    async snooze({ minutes }) {
      const until = ctx.setSnooze(Number(minutes) || 0);
      if (!until) return { ok: true, text: 'Dobře, zase ti dám vědět o všem důležitém.' };
      return { ok: true, text: `Do ${hhmm(new Date(until))} tě nebudu rušit${ctx.settings().priorities.quiet.vip ? ' – jen kdyby se ozval někdo z důležitých lidí' : ''}.` };
    },
  };

  async function runSkill(id, args, env) {
    const fn = Object.hasOwn(run, id) ? run[id] : null;
    if (!fn) return { ok: false, text: `Dovednost „${id}“ neznám.` };
    try { return await fn(args || {}, env); } catch (e) { return { ok: false, text: errText(e) }; }
  }

  // ---------------------------------------------------------------- nástroje pro Clauda

  const ok = text => ({ content: [{ type: 'text', text }] });
  const fail = text => ({ content: [{ type: 'text', text }], isError: true });
  const viaSkill = async (id, args, env) => { const r = await runSkill(id, args, env); return r.ok ? ok(r.text) : fail(r.text); };

  async function toPhone(action) {
    const res = await ctx.phoneAction({ id: crypto.randomUUID(), ts: Date.now(), ...action });
    if (res.clients) return 'Připraveno v telefonu – uživatel to dokončí jedním klepnutím (aplikace mu to nabízí).';
    if (res.pushed) return 'Aplikace v telefonu teď není otevřená. Poslal jsem upozornění – po klepnutí na něj to uživatel dokončí.';
    return 'Telefon teď není připojený. Akce na něj počká a nabídne se, jakmile uživatel aplikaci otevře.';
  }

  // Seznam dovedností jako nástrojů (pro Clauda přes MCP, pro Mistral jako funkce).
  const tool = (name, description, shape, handler, extra) => ({ name, description, shape, handler, extra });

  function toolDefs(session, { fallback = false } = {}) {
    const env = { session };
    const tools = [
      tool('send_message',
        'Připraví zprávu přes WhatsApp, SMS nebo e-mail. Příjemce zadej jménem tak, jak ho uživatel řekl (číslo dohledá aplikace v kontaktech), případně číslem nebo e-mailem. Odeslání potvrzuje uživatel klepnutím v telefonu.',
        {
          channel: z.enum(['whatsapp', 'sms', 'email']).describe('Kanál; když uživatel neřekne, použij whatsapp'),
          to: z.string().describe('Jméno příjemce, telefonní číslo nebo e-mail'),
          text: z.string().describe('Text zprávy psaný za uživatele v první osobě'),
          subject: z.string().optional().describe('Předmět (jen e-mail)'),
        },
        async a => {
          const r = recipient(a.to);
          if (a.channel === 'sms' && !r.number) return fail(`U „${r.name}“ nemám telefonní číslo. Uživatel ho může přidat v Nastavení → Lidé.`);
          const kind = a.channel === 'email' ? 'mail' : a.channel;
          const note = r.unknown && kind === 'whatsapp' ? ` „${r.name}“ není v kontaktech aplikace, příjemce si uživatel vybere ve WhatsAppu.` : '';
          return ok((await toPhone({ kind, to: r.name, number: r.number, email: r.email, text: a.text, subject: a.subject || '' })) + note);
        }),

      tool('call_contact', 'Připraví telefonní hovor s člověkem z kontaktů (uživatel ho spustí klepnutím).',
        { to: z.string().describe('Jméno nebo telefonní číslo') },
        async a => {
          const r = recipient(a.to);
          if (!r.number) return fail(`U „${r.name}“ nemám telefonní číslo. Uživatel ho může přidat v Nastavení → Lidé.`);
          return ok(await toPhone({ kind: 'call', to: r.name, number: r.number }));
        }),

      tool('open_on_phone', 'Otevře v telefonu navigaci, vyhledávání, YouTube nebo webovou adresu (uživatel potvrdí klepnutím).',
        { kind: z.enum(['navigate', 'search', 'youtube', 'url']), query: z.string().describe('Cíl cesty, hledaný výraz nebo adresa https://…') },
        async a => {
          if (a.kind === 'url' && !/^https?:\/\//i.test(a.query)) return fail('Adresa musí začínat https://');
          return ok(await toPhone({ kind: a.kind, query: a.query }));
        }),

      tool('calendar_add', 'Zapíše událost do kalendáře uživatele. Časy zadávej v místním čase jako YYYY-MM-DDTHH:mm.',
        {
          title: z.string(), start: z.string().describe('Začátek, YYYY-MM-DDTHH:mm (u celodenní stačí YYYY-MM-DD)'),
          end: z.string().optional().describe('Konec; když chybí, počítá se hodina'),
          all_day: z.boolean().optional(), location: z.string().optional(), notes: z.string().optional(),
        },
        async a => {
          const r = await runSkill('calendar_add', a, env);
          if (!r.ok) return fail(r.text);
          await ctx.phoneAction({ id: crypto.randomUUID(), ts: Date.now(), kind: 'calendar', event: r.data.event, optional: true });
          return ok(r.text);
        }),

      tool('calendar_list', 'Vypíše události z kalendáře uživatele v daném období.',
        { from: z.string().describe('Od, YYYY-MM-DD nebo YYYY-MM-DDTHH:mm'), to: z.string().optional().describe('Do (bez tohoto dne); výchozí je jeden den') },
        async a => viaSkill('calendar_list', a, env), { annotations: { readOnlyHint: true } }),

      tool('remind', 'Nastaví připomínku: v daný čas aplikace uživateli „zavolá“ a text mu přečte.',
        { at: z.string().describe('Kdy, YYYY-MM-DDTHH:mm v místním čase'), text: z.string().describe('Co připomenout') },
        async a => viaSkill('remind', a, env)),

      tool('alert_user', 'Pošle uživateli upozornění do telefonu (i když má aplikaci zavřenou). S urgent=true mu aplikace „zavolá“ a text přečte nahlas. Hodí se třeba po doběhnutí dlouhého úkolu.',
        { text: z.string().describe('Krátký text upozornění'), urgent: z.boolean().optional() },
        async a => {
          await ctx.alert({ source: 'claude', app: 'Claude', from: 'Claude', title: '', text: String(a.text).slice(0, 600), urgent: !!a.urgent });
          return ok('Upozornění odesláno.');
        }),

      // Záměrně tu NENÍ nástroj, který by Claudovi předal texty e-mailů a zpráv: je to cizí, nedůvěryhodný
      // obsah a v automatickém režimu by se jím dal Claude zmanipulovat (prompt injection). Novinky proto
      // čte aplikace sama pravidly („co je nového“), bez modelu.

      tool('open_vscode', 'Otevře na počítači VS Code, volitelně ve složce projektu (stačí název složky).',
        { folder: z.string().optional().describe('Název nebo cesta složky projektu') },
        async a => viaSkill('vscode', { project: a.folder || '' }, env)),

      tool('open_on_pc', 'Otevře na počítači web, složku nebo běžnou aplikaci (chrome, spotify, outlook, whatsapp, kalkulačka…).',
        { target: z.string().describe('Adresa https://…, cesta ke složce nebo název aplikace') },
        async a => viaSkill('pc_open', a, env)),

      tool('do_not_disturb', 'Ztiší upozornění na daný počet minut (0 = zase upozorňovat).',
        { minutes: z.number() }, async a => viaSkill('snooze', a, env)),
    ];

    // Programovací úkol potřebuje Clauda – v záložním režimu (Mistral) by jen narazil na stejný limit.
    if (session.kind === 'assistant' && !fallback) {
      tools.push(tool('start_coding_task',
        'Předá úkol Claudu Code na počítači (programování, práce se soubory, delší práce). Založí novou konverzaci ve složce projektu a úkol v ní spustí.',
        { task: z.string().describe('Zadání vlastními slovy uživatele'), folder: z.string().optional().describe('Název složky projektu, pokud ho uživatel zmínil') },
        async a => {
          try {
            const r = await ctx.startCodingTask(a.task, a.folder || '');
            return ok(`Úkol běží v nové konverzaci „${r.title}“ (složka ${r.folder}). Uživatel ji najde v Konverzacích.`);
          } catch (e) { return fail(errText(e)); }
        }));
    }

    return tools;
  }

  function mcpServer(session) {
    const tools = toolDefs(session).map(d => sdkTool(d.name, d.description, d.shape, d.handler, d.extra));
    return createSdkMcpServer({ name: 'ttc', version: '1.0.0', tools, alwaysLoad: session.kind === 'assistant' });
  }

  return { run: runSkill, mcpServer, toolDefs, recipient };
}
