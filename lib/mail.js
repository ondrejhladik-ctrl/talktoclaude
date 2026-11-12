// Hlídání pošty přes IMAP (iCloud, Gmail, Seznam, vlastní server). Jen čte hlavičky a začátek
// nových zpráv ve schránce Doručené – nic neoznačuje ani nemaže. Běží bez Clauda.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { errText, sleep } from './store.js';

export const MAIL_PRESETS = {
  icloud: { label: 'iCloud', host: 'imap.mail.me.com', port: 993, hint: 'Heslo pro aplikace z account.apple.com (Přihlášení a zabezpečení).' },
  gmail: { label: 'Gmail', host: 'imap.gmail.com', port: 993, hint: 'Heslo aplikace z myaccount.google.com/apppasswords (vyžaduje dvoufázové ověření).' },
  seznam: { label: 'Seznam.cz', host: 'imap.seznam.cz', port: 993, hint: 'Běžné heslo; v nastavení Seznam Emailu musí být povolený IMAP.' },
  custom: { label: 'Vlastní server', host: '', port: 993, hint: 'Adresa IMAP serveru a port (obvykle 993).' },
};

export function mailOptions(cfg) {
  const preset = MAIL_PRESETS[cfg.preset] || MAIL_PRESETS.custom;
  const host = String((cfg.preset === 'custom' || !preset.host ? cfg.host : preset.host) || '').trim();
  const port = cfg.preset === 'custom' ? Number(cfg.port) || 993 : preset.port;
  let pass = String(cfg.pass || '');
  if (cfg.preset === 'gmail') pass = pass.replace(/\s+/g, '');
  return { host, port, user: String(cfg.user || '').trim(), pass };
}

function client(cfg, extra = {}) {
  const o = mailOptions(cfg);
  if (!o.host || !o.user || !o.pass) throw new Error('Chybí server, e-mail nebo heslo.');
  const c = new ImapFlow({
    host: o.host, port: o.port, secure: o.port === 993,
    auth: { user: o.user, pass: o.pass },
    logger: false, connectionTimeout: 20000, greetingTimeout: 15000,
    ...extra,
  });
  c.on('error', () => {});   // bez posluchače by chyba spojení shodila celý server
  return c;
}

export function mailErrorText(e) {
  if (e?.authenticationFailed) return 'Přihlášení selhalo. Zkontroluj e-mail a heslo (iCloud a Gmail chtějí zvláštní „heslo pro aplikace“).';
  const code = e?.code || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Poštovní server se nepodařilo najít. Zkontroluj adresu serveru a připojení k internetu.';
  if (code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || /timeout/i.test(errText(e))) return 'Poštovní server neodpovídá.';
  return errText(e);
}

export async function testMail(cfg) {
  let c;
  try {
    c = client(cfg, { verifyOnly: true });
    await c.connect();
    return { ok: true, message: 'Připojení k poště funguje.' };
  } catch (e) {
    return { ok: false, message: mailErrorText(e) };
  } finally {
    try { c?.close(); } catch {}
  }
}

const headerOf = (raw, name) => {
  const m = new RegExp(`^${name}:\\s*(.*(?:\\r?\\n[ \\t].*)*)`, 'im').exec(raw || '');
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
};

async function toItem(msg) {
  const env = msg.envelope || {};
  const from = (env.from && env.from[0]) || {};
  let text = '';
  let bulk = false;
  try {
    const parsed = await simpleParser(msg.source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true, maxHtmlLengthToParse: 200000 });
    text = String(parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    const raw = msg.source.toString('latin1', 0, 12000);
    bulk = !!headerOf(raw, 'List-Unsubscribe') || /bulk|junk|list/i.test(headerOf(raw, 'Precedence')) ||
      (!!headerOf(raw, 'Auto-Submitted') && !/^no$/i.test(headerOf(raw, 'Auto-Submitted')));
  } catch {}
  return {
    source: 'mail', app: 'E-mail',
    from: from.name || from.address || 'Neznámý odesílatel',
    fromAddr: from.address || '',
    title: String(env.subject || '(bez předmětu)').slice(0, 300),
    text, bulk, uid: msg.uid,
  };
}

export class MailWatcher {
  constructor({ getConfig, onMail }) {
    this.getConfig = getConfig;
    this.onMail = onMail;
    this.status = { state: 'off', message: '' };
    this.gen = 0;
    this.client = null;
  }

  // Zavolej po každé změně nastavení – spojení se podle něj spustí, restartuje nebo ukončí.
  restart() {
    const gen = ++this.gen;
    try { this.client?.close(); } catch {}
    this.client = null;
    const cfg = this.getConfig();
    if (!cfg || !cfg.on) { this.status = { state: 'off', message: '' }; return; }
    this.run(gen).catch(() => {});
  }

  stop() {
    this.gen++;
    try { this.client?.close(); } catch {}
    this.client = null;
    this.status = { state: 'off', message: '' };
  }

  async run(gen) {
    let wait = 5000;
    while (gen === this.gen) {
      const started = Date.now();
      try {
        await this.session(gen);
        if (Date.now() - started > 60000) wait = 5000;
      } catch (e) {
        if (gen !== this.gen) return;
        this.status = { state: 'error', message: mailErrorText(e) };
        if (e?.authenticationFailed) return;      // špatné heslo – nezkoušet dokola (hrozí zablokování účtu)
      }
      if (gen !== this.gen) return;
      await sleep(wait);
      wait = Math.min(wait * 2, 5 * 60000);
    }
  }

  async session(gen) {
    const c = client(this.getConfig());
    this.client = c;
    this.status = { state: 'connecting', message: '' };
    await c.connect();
    if (gen !== this.gen) { c.close(); return; }
    const box = await c.mailboxOpen('INBOX', { readOnly: true });
    let last = Math.max(0, (box.uidNext || 1) - 1);     // od teď dál – stará pošta se nehlásí
    this.status = { state: 'ok', message: 'Hlídám nové zprávy.', since: Date.now() };

    let busy = false;
    let again = false;
    const check = async () => {
      if (busy) { again = true; return; }
      busy = true;
      try {
        do {
          again = false;
          const fresh = [];
          for await (const msg of c.fetch(`${last + 1}:*`, { uid: true, envelope: true, source: { start: 0, maxLength: 48000 } }, { uid: true })) {
            if (msg.uid > last) fresh.push(msg);
          }
          fresh.sort((a, b) => a.uid - b.uid);
          for (const msg of fresh.slice(-20)) {
            last = Math.max(last, msg.uid);
            if (gen === this.gen) this.onMail(await toItem(msg));
          }
          if (fresh.length) last = Math.max(last, fresh[fresh.length - 1].uid);
        } while (again && gen === this.gen);
      } catch { /* spojení spadlo – ošetří se v 'close' */ } finally { busy = false; }
    };

    c.on('exists', () => { check(); });
    const poll = setInterval(() => { if (c.usable) check(); }, 3 * 60000);
    try {
      await new Promise(resolve => c.once('close', resolve));
    } finally {
      clearInterval(poll);
      if (this.client === c) this.client = null;
    }
    if (gen === this.gen) this.status = { state: 'connecting', message: 'Spojení se přerušilo, připojuji se znovu…' };
  }
}
