// Záloha za Clauda: když mu dojdou kredity nebo narazí na limit, odpovídá Mistral AI.
// Používá stejné dovednosti (zprávy, kalendář, připomínky, VS Code…) jako Claude, jen přes
// Mistral Chat Completions API s voláním funkcí. K souborům a příkazům počítače přístup nemá.
import { z } from 'zod';

const API = 'https://api.mistral.ai/v1/chat/completions';
export const MISTRAL_MODELS = ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest'];
const MAX_ROUNDS = 6;

// Poznat, že Claude odmítl kvůli limitu / kreditům (a ne kvůli běžné chybě).
const LIMIT_RE = /(hit your .{0,30}limit|reached your .{0,30}limit|usage limit|rate[ _-]?limit|credit balance|out of (extra )?usage|usage credits|insufficient (credit|balance|quota)|billing|quota exceeded|overloaded)/i;
export const isLimitError = text => LIMIT_RE.test(String(text || ''));

// „…resets 8pm“ / „resets 1:50am“ → kdy to zkusit s Claudem znovu. Bez údaje za hodinu.
export function limitResetAt(text, now = Date.now()) {
  const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(String(text || ''));
  if (m) {
    let h = Number(m[1]) % 24;
    const min = Number(m[2] || 0);
    if (m[3]) h = (h % 12) + (/pm/i.test(m[3]) ? 12 : 0);
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    if (d.getTime() - now <= 7 * 86400000) return d.getTime();
  }
  return now + 3600000;
}

// Dovednost (název, popis, zod tvar) → nástroj ve formátu Mistralu.
function toolSpec(def) {
  const parameters = z.toJSONSchema(z.object(def.shape));
  delete parameters.$schema;
  return { type: 'function', function: { name: def.name, description: def.description, parameters } };
}

async function chat({ key, model, messages, tools, signal }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 90000);
  signal?.addEventListener('abort', () => ac.abort(), { once: true });
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, messages, temperature: 0.3,
        ...(tools?.length ? { tools, tool_choice: 'auto', parallel_tool_calls: true } : {}),
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 401) throw new Error('Klíč k Mistral AI nefunguje – zkontroluj ho v Nastavení.');
      if (res.status === 429) throw new Error('Mistral AI je teď přetížený nebo jsi vyčerpal jeho limit.');
      throw new Error(`Mistral AI vrátil chybu ${res.status}: ${body.slice(0, 200)}`);
    }
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(signal?.aborted ? 'Přerušeno.' : 'Mistral AI neodpověděl včas.');
    throw e;
  } finally { clearTimeout(timer); }
}

const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => p.text || '').join('') : '');

/**
 * Jedno kolo konverzace s Mistralem, včetně volání dovedností.
 * history: [{ role: 'user'|'assistant', content }], tools: [{ name, description, shape, handler }]
 * onTool(name, args, id) / onToolResult(id, text, isError) – pro zápis do konverzace v aplikaci.
 */
export async function runTurn({ key, model, system, history, text, tools = [], onTool, onToolResult, signal }) {
  const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: text }];
  const specs = tools.map(toolSpec);
  const byName = new Map(tools.map(t => [t.name, t]));
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const data = await chat({ key, model, messages, tools: specs, signal });
    const msg = data.choices?.[0]?.message || {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!calls.length) return textOf(msg.content).trim();
    messages.push({ role: 'assistant', content: textOf(msg.content), tool_calls: calls });
    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try { args = typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : (call.function?.arguments || {}); } catch {}
      const def = byName.get(name);
      onTool?.(name, args, call.id);
      let out;
      let isError = false;
      if (!def) { out = `Nástroj ${name} neexistuje.`; isError = true; } else {
        try {
          const r = await def.handler(def.shape ? z.object(def.shape).parse(args) : args);
          out = (r?.content || []).map(c => c.text || '').join('\n') || 'Hotovo.';
          isError = !!r?.isError;
        } catch (e) { out = `Chybné zadání: ${e.message || e}`; isError = true; }
      }
      onToolResult?.(call.id, out, isError);
      messages.push({ role: 'tool', tool_call_id: call.id, name, content: out });
    }
  }
  return 'Tohle se mi nepodařilo dokončit.';
}

// Jednoduchá otázka bez nástrojů (třídění upozornění).
export async function ask({ key, model, system, text }) {
  const data = await chat({ key, model, messages: [{ role: 'system', content: system }, { role: 'user', content: text }] });
  return textOf(data.choices?.[0]?.message?.content).trim();
}

// Ověření klíče (jedno levné volání).
export async function testKey(key, model = MISTRAL_MODELS[0]) {
  try {
    const answer = await ask({ key, model, system: 'Odpověz jedním slovem.', text: 'Řekni OK.' });
    return { ok: true, text: `Mistral AI funguje (${model}): ${answer.slice(0, 40)}` };
  } catch (e) { return { ok: false, text: e.message || String(e) }; }
}
