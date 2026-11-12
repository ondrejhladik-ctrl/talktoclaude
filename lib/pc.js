// Akce na počítači: otevřít VS Code, složku, web, aplikaci nebo koncept zprávy ve WhatsAppu.
// Nic se nespouští přes shell – argumenty jdou procesu přímo, takže do nich nejde nic „propašovat“.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { norm } from '../public/intents.js';

const isWin = process.platform === 'win32';

function detached(cmd, args, env) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, env });
    } catch (e) { reject(e); return; }
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

// Otevře adresu (https://…, whatsapp://…, spotify: …) výchozí aplikací systému.
function openUri(uri) {
  if (isWin) return detached('rundll32.exe', ['url.dll,FileProtocolHandler', uri]);
  return detached(process.platform === 'darwin' ? 'open' : 'xdg-open', [uri]);
}

// ---------------------------------------------------------------- VS Code

export function findVsCode(custom) {
  const candidates = [];
  if (custom) candidates.push(custom);
  if (isWin) {
    const local = process.env.LOCALAPPDATA || '';
    candidates.push(
      path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'),
      'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe',
    );
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (/[\\/]bin[\\/]?$/i.test(dir) && fs.existsSync(path.join(dir, 'code.cmd'))) candidates.push(path.join(dir, '..', 'Code.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code');
  } else {
    candidates.push('/usr/bin/code', '/usr/local/bin/code', '/snap/bin/code');
  }
  return candidates.map(c => path.resolve(c)).find(c => fs.existsSync(c)) || null;
}

export async function openVsCode(folder, custom) {
  const exe = findVsCode(custom);
  if (!exe) throw new Error('VS Code jsem na počítači nenašel. Cestu ke Code.exe můžeš zadat v data/config.json jako "vscodePath".');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;          // jinak by se Code.exe choval jako Node a nic neotevřel
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  await detached(exe, folder ? [folder] : [], env);
}

// Najde složku projektu podle vysloveného názvu mezi známými složkami a jejich sousedy.
export async function findProject(name, roots) {
  const want = norm(name).replace(/[^a-z0-9]/g, '');
  if (!want) return null;
  const seen = new Map();          // cesta → název
  const add = p => { if (p && !seen.has(p)) seen.set(p, path.basename(p)); };
  for (const r of roots) add(r);
  for (const r of roots) {
    for (const parent of [r, path.dirname(r)]) {
      let ents;
      try { ents = await fsp.readdir(parent, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$') && e.name !== 'node_modules') add(path.join(parent, e.name));
      }
    }
  }
  let best = null;
  for (const [p, base] of seen) {
    const b = norm(base).replace(/[^a-z0-9]/g, '');
    if (!b) continue;
    // přesná shoda > začátek názvu > část názvu; u částečné shody musí sedět aspoň 3 znaky a většina názvu
    let score = 0;
    if (b === want) score = 100;
    else if (want.length >= 3 && b.startsWith(want)) score = 70 - (b.length - want.length);
    else if (want.length >= 3 && b.includes(want)) score = 50 - (b.length - want.length);
    else if (b.length >= 4 && want.includes(b) && b.length >= want.length * 0.6) score = 40;
    if (score > 0 && (!best || score > best.score)) best = { path: p, score };
  }
  return best ? best.path : null;
}

// ---------------------------------------------------------------- aplikace, weby, složky

// Co jde říct: „otevři … na počítači“. Hodnota je adresa/protokol nebo spustitelný soubor.
export const DEFAULT_APPS = {
  'chrome': 'chrome.exe', 'google chrome': 'chrome.exe', 'edge': 'msedge.exe', 'prohlizec': 'https://www.google.com',
  'pruzkumnik': 'explorer.exe', 'soubory': 'explorer.exe', 'kalkulacka': 'calc.exe', 'kalkulacku': 'calc.exe',
  'poznamkovy blok': 'notepad.exe', 'nastaveni': 'ms-settings:', 'terminal': 'wt.exe',
  'spotify': 'spotify:', 'whatsapp': 'whatsapp:', 'outlook': 'outlookmail:', 'postu': 'outlookmail:', 'mail': 'outlookmail:',
  'kalendar': 'outlookcal:', 'teams': 'msteams:', 'youtube': 'https://www.youtube.com', 'gmail': 'https://mail.google.com',
  'google': 'https://www.google.com', 'github': 'https://github.com', 'mapy': 'https://mapy.cz', 'chatgpt': 'https://chatgpt.com',
  'claude': 'https://claude.ai', 'netflix': 'https://www.netflix.com', 'facebook': 'https://www.facebook.com',
};

export async function openOnPc(target, apps = {}) {
  const raw = String(target || '').trim();
  if (!raw) throw new Error('Neřekl jsi, co mám otevřít.');
  if (/^https?:\/\/\S+$/i.test(raw)) { await openUri(raw); return `Otevřeno v prohlížeči: ${raw}`; }
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(raw) && !/\.(exe|bat|cmd|ps1|msi|lnk|vbs|js)$/i.test(raw)) {
    await openUri(`https://${raw}`);
    return `Otevřeno v prohlížeči: ${raw}`;
  }
  const key = norm(raw);
  const table = { ...DEFAULT_APPS };
  for (const [k, v] of Object.entries(apps || {})) table[norm(k)] = String(v);
  const hit = table[key] || table[key.replace(/^(aplikaci|program|stranku|web|slozku) /, '')];
  if (hit) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(hit) && !/^[a-z]:[\\/]/i.test(hit)) await openUri(hit);
    else if (isWin) await detached('cmd.exe', ['/d', '/c', 'start', '', hit]);     // `hit` je z pevného seznamu, ne od uživatele
    else await detached(hit, []);
    return `Otevřeno: ${raw}`;
  }
  const st = await fsp.stat(raw).catch(() => null);
  if (st?.isDirectory()) {
    if (isWin) await detached('explorer.exe', [path.resolve(raw)]); else await openUri(path.resolve(raw));
    return `Otevřena složka ${path.basename(path.resolve(raw))}.`;
  }
  throw new Error(`„${raw}“ neznám. Umím weby, složky a tyhle aplikace: ${Object.keys(DEFAULT_APPS).slice(0, 12).join(', ')}… Další jdou přidat v data/config.json ("apps").`);
}

// ---------------------------------------------------------------- WhatsApp na počítači

// Otevře WhatsApp pro Windows s předepsanou zprávou. Záměrně NEODESÍLÁ – odeslání potvrdí člověk.
export async function whatsappDraft(digits, text) {
  const q = new URLSearchParams();
  if (digits) q.set('phone', String(digits).replace(/\D/g, ''));
  q.set('text', String(text || '').slice(0, 1500));
  await openUri(`whatsapp://send?${q.toString().replace(/\+/g, '%20')}`);
}
