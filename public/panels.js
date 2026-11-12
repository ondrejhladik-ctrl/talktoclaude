// Panely: Nastavení, Priority a hlídání, Lidé, Přehled upozornění a nápověda „Co umím“.
import { $, el, store, settings, saveSettings, S, toast, timeAgo } from './core.js';
import { EXAMPLES, hhmm } from './intents.js';

const MAIL_HINTS = {
  icloud: 'iCloud: heslo pro aplikace vytvoříš na account.apple.com → Přihlášení a zabezpečení.',
  gmail: 'Gmail: heslo aplikace vytvoříš na myaccount.google.com/apppasswords (je k tomu potřeba dvoufázové ověření).',
  seznam: 'Seznam: stačí běžné heslo; v nastavení Seznam Emailu musí být povolený přístup přes IMAP.',
  custom: 'Zadej adresu IMAP serveru (port 993).',
};
const list = v => String(v || '').split(/[,\n;]/).map(x => x.trim()).filter(Boolean);
const stateText = st => (!st ? '' : st.state === 'ok' ? st.message || 'Běží' : st.state === 'connecting' ? 'Připojuji…' : st.state === 'error' ? st.message : '');

export function initPanels(api) {
  const online = () => S.conn === 'online';
  let editing = null;        // id právě upravovaného člověka
  let onlyImportant = false;

  // ------------------------------------------------------------ Nastavení

  async function refreshPush() {
    const st = await api.pushState();
    const text = { on: 'Zapnutá – dám vědět, i když je aplikace zavřená', off: 'Vypnutá', denied: 'Zakázaná v prohlížeči', unsupported: /iPhone|iPad/.test(navigator.userAgent) ? 'Na iPhonu nejdřív přidej aplikaci na plochu' : 'Tenhle prohlížeč je neumí' }[st];
    $('pushState').textContent = text + (st === 'on' && S.status?.push ? ` · zařízení: ${S.status.push}` : '');
    $('pushBtn').textContent = st === 'on' ? 'Vypnout' : 'Zapnout';
    $('pushBtn').disabled = st === 'unsupported' || st === 'denied';
    $('pushBtn').dataset.state = st;
  }

  $('settingsBtn').onclick = () => {
    if ($('drawer').open) $('drawer').close();
    $('setLang').value = settings.lang;
    $('setRate').value = settings.rate;
    $('rateVal').textContent = `${Number(settings.rate).toFixed(2)}×`;
    $('setAutoSend').checked = settings.autoSend;
    $('setVibrate').checked = settings.vibrate;
    $('setWake').checked = settings.wakeLock;
    $('setQuickModel').value = S.quickModel;
    $('setQuickModel').disabled = !online();
    $('setCalPhone').value = S.cfg.skills.calendarPhone;
    $('setMessenger').value = S.cfg.skills.messenger;
    fillMistral();
    $('qrBox').hidden = true;
    if (online()) { api.send({ t: 'qr' }, true); api.send({ t: 'status' }, true); }
    refreshPush();
    $('settingsDlg').showModal();
  };
  $('setLang').onchange = e => { settings.lang = e.target.value; saveSettings(); };
  $('setRate').oninput = e => { settings.rate = Number(e.target.value); $('rateVal').textContent = `${settings.rate.toFixed(2)}×`; saveSettings(); };
  $('setRate').onchange = () => api.say('Takhle rychle budu číst odpovědi.');
  $('setAutoSend').onchange = e => { settings.autoSend = e.target.checked; saveSettings(); };
  $('setVibrate').onchange = e => { settings.vibrate = e.target.checked; saveSettings(); };
  $('setWake').onchange = e => { settings.wakeLock = e.target.checked; saveSettings(); };
  $('setQuickModel').onchange = e => { if (!api.send({ t: 'quick-model', model: e.target.value })) e.target.value = S.quickModel; };
  $('setCalPhone').onchange = e => api.saveCfg({ skills: { calendarPhone: e.target.value } });
  $('setMessenger').onchange = e => api.saveCfg({ skills: { messenger: e.target.value } });

  // Záloha za Clauda – Mistral AI. Klíč se ukládá jen na počítači, do telefonu se nevrací.
  function fillMistral() {
    const ai = S.cfg.ai || {};
    $('setMistralOn').checked = ai.fallback !== false;
    $('setMistralModel').value = ai.mistralModel || 'mistral-small-latest';
    $('setMistralKey').value = '';
    $('setMistralNote').textContent = ai.hasKey ? 'uložený – nech prázdné' : '';
    $('mistralBox').hidden = !$('setMistralOn').checked;
  }
  $('setMistralOn').onchange = e => { $('mistralBox').hidden = !e.target.checked; api.saveCfg({ ai: { fallback: e.target.checked } }); };
  $('setMistralModel').onchange = e => api.saveCfg({ ai: { mistralModel: e.target.value } });
  $('mistralSave').onclick = () => {
    if (!online()) { toast('Klíč jde uložit, jen když je počítač připojený.', true); return; }
    const key = $('setMistralKey').value.trim();
    if (!key && !S.cfg.ai?.hasKey) { toast('Vlož API klíč.', true); return; }
    if (key) {
      api.send({ t: 'settings-set', patch: { ai: { mistralKey: key, fallback: true } } }, true);
      S.cfg.ai = { ...S.cfg.ai, hasKey: true, fallback: true };
    }
    $('setMistralKey').value = '';
    $('setMistralNote').textContent = 'uložený – nech prázdné';
    $('mistralHint').className = 'hint';
    $('mistralHint').textContent = 'Zkouším Mistral…';
    api.send({ t: 'mistral-test', key });
  };
  function onMistralTest(m) {
    $('mistralHint').className = `hint ${m.ok ? 'ok' : 'bad'}`;
    $('mistralHint').textContent = m.text;
  }
  $('pushBtn').onclick = async () => {
    try {
      if ($('pushBtn').dataset.state === 'on') { await api.disablePush(); toast('Upozornění v telefonu jsou vypnutá.'); }
      else { await api.enablePush(); toast('Hotovo – důležité věci ti teď přijdou i při zavřené aplikaci.'); }
    } catch (e) { toast(e.message || String(e), true); }
    refreshPush();
  };
  $('logoutBtn').onclick = () => { $('settingsDlg').close(); api.logout(); };
  $('prioBtn').onclick = () => { $('settingsDlg').close(); openPrio(); };
  $('peopleBtn').onclick = () => { $('settingsDlg').close(); openPeople(); };
  $('helpBtn').onclick = () => { $('settingsDlg').close(); openHelp(); };

  function onQr(m) {
    $('qrBox').hidden = !m.svg;
    if (!m.svg) return;
    $('qrImg').src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(m.svg)}`;
    $('linkOut').href = m.link;
    $('linkOut').textContent = String(m.link).replace(/#.*/, '');
  }

  // ------------------------------------------------------------ Priority a hlídání

  function fillPrio() {
    const c = S.cfg;
    $('pwEnabled').checked = c.watch.enabled;
    $('ppKeywords').value = c.priorities.keywords.join(', ');
    $('ppMute').value = c.priorities.mute.join(', ');
    $('ppAbout').value = c.priorities.about;
    $('ppSmart').checked = c.priorities.smart;
    $('ppNotify').value = c.priorities.notify;
    $('ppCall').value = c.priorities.call;
    $('pqOn').checked = c.priorities.quiet.on;
    $('pqFrom').value = c.priorities.quiet.from;
    $('pqTo').value = c.priorities.quiet.to;
    $('pqVip').checked = c.priorities.quiet.vip;
    $('pwNotif').checked = c.watch.notifications;
    $('pwIgnore').value = c.watch.ignoreApps.join(', ');
    $('pmOn').checked = c.watch.mail.on;
    $('pmPreset').value = c.watch.mail.preset in MAIL_HINTS ? c.watch.mail.preset : 'custom';
    $('pmHost').value = c.watch.mail.host;
    $('pmUser').value = c.watch.mail.user;
    $('pmPass').value = '';
    $('pmPassNote').textContent = c.watch.mail.hasPass ? 'uložené – nech prázdné' : '';
    $('pcUrls').value = c.watch.calendar.urls.join('\n');
    $('pcLead').value = String(c.watch.calendar.lead);
    // Twilio call nastavení
    const callCfg = c.call || {};
    $('pcCallOn').checked = !!callCfg.on;
    $('pcSid').value = callCfg.twilioSid || '';
    $('pcToken').value = '';
    $('pcTokenNote').textContent = callCfg.hasToken ? 'uložený – nech prázdné' : '';
    $('pcFrom').value = callCfg.from || '';
    $('pcTo').value = callCfg.to || '';
    syncCallBox();
    syncMailBox();
  }

  function syncMailBox() {
    $('mailBox').hidden = !$('pmOn').checked;
    $('pmHostRow').hidden = $('pmPreset').value !== 'custom';
    $('pmHint').className = 'hint';
    $('pmHint').textContent = MAIL_HINTS[$('pmPreset').value] || '';
  }
  function syncCallBox() {
    $('callBox').hidden = !$('pcCallOn').checked;
  }
  $('pmOn').onchange = syncMailBox;
  $('pmPreset').onchange = syncMailBox;
  $('pcCallOn').onchange = syncCallBox;

  const mailForm = () => {
    const m = { on: $('pmOn').checked, preset: $('pmPreset').value, host: $('pmHost').value.trim(), port: 993, user: $('pmUser').value.trim() };
    if ($('pmPass').value) m.pass = $('pmPass').value;
    return m;
  };
  
  const callForm = () => {
    const on = $('pcCallOn').checked;
    const c = { on };
    if (on) {
      c.twilioSid = $('pcSid').value.trim();
      c.twilioToken = $('pcToken').value || (S.cfg.call?.twilioToken || '');
      c.from = $('pcFrom').value.trim();
      c.to = $('pcTo').value.trim();
    }
    return c;
  };

  function openPrio() {
    fillPrio();
    onStatus();
    $('prioOffline').hidden = online();
    if (online()) api.send({ t: 'status' }, true);
    $('prioDlg').showModal();
  }

  $('prioSave').onclick = () => {
    const patch = {
      priorities: {
        about: $('ppAbout').value.trim(), keywords: list($('ppKeywords').value), mute: list($('ppMute').value),
        notify: $('ppNotify').value, call: $('ppCall').value, smart: $('ppSmart').checked,
        quiet: { on: $('pqOn').checked, from: $('pqFrom').value || '22:00', to: $('pqTo').value || '07:00', vip: $('pqVip').checked },
      },
      watch: {
        enabled: $('pwEnabled').checked, notifications: $('pwNotif').checked, ignoreApps: list($('pwIgnore').value),
        mail: mailForm(),
        calendar: { urls: list($('pcUrls').value), lead: Number($('pcLead').value) },
      },
      call: callForm(),
    };
    if (patch.watch.mail.on && !patch.watch.mail.user) { toast('U e-mailu chybí adresa.', true); return; }
    if (patch.watch.mail.on && !patch.watch.mail.pass && !S.cfg.watch.mail.hasPass) { toast('U e-mailu chybí heslo.', true); return; }
    const sent = api.saveCfg(patch);
    if (patch.watch.mail.pass) S.cfg.watch.mail.hasPass = true;
    if (patch.call.on && patch.call.twilioToken && !S.cfg.call?.twilioToken) S.cfg.call = { ...S.cfg.call, hasToken: true };
    $('pmPass').value = '';
    $('pcToken').value = '';
    toast(sent ? 'Uloženo.' : 'Uloženo v telefonu – do počítače se to přenese, až se připojí.');
    $('prioDlg').close();
  };
  $('pmTest').onclick = () => {
    if (!online()) { toast('Vyzkoušet to jde, jen když je počítač připojený.', true); return; }
    $('pmHint').className = 'hint';
    $('pmHint').textContent = 'Zkouším připojení…';
    api.send({ t: 'mail-test', mail: mailForm() });
  };
  $('prioTest').onclick = () => {
    if (!online()) { toast('Zkušební hovor jde jen s připojeným počítačem.', true); return; }
    api.send({ t: 'test-alert', call: true });
  };
  $('pcCallTest').onclick = () => {
    if (!online()) { toast('Zkušební hovor jde jen s připojeným počítačem.', true); return; }
    if (!S.cfg.call?.on) { toast('Nejdřív zapni Twilio v nastavení.', true); return; }
    if (!S.cfg.call?.twilioSid || !S.cfg.call?.from || !S.cfg.call?.to) { toast('Chybí Twilio SID, číslo OD nebo číslo KAM.', true); return; }
    $('pcCallHint').className = 'hint';
    $('pcCallHint').textContent = 'Zkouším Twilio…';
    api.send({ t: 'test-call' });
  };
  $('prioPeopleBtn').onclick = () => { $('prioDlg').close(); openPeople(); };

  function onMailTest(m) {
    $('pmHint').className = `hint ${m.ok ? 'ok' : 'bad'}`;
    $('pmHint').textContent = m.message;
  }
  
  function onCallTest(m) {
    $('pcCallHint').className = `hint ${m.ok ? 'ok' : 'bad'}`;
    $('pcCallHint').textContent = m.ok ? `Zkušební hovor spuštěn: ${m.callSid || ''}` : m.message || 'Chyba';
  }

  function onStatus() {
    const st = S.status;
    $('stNotif').textContent = stateText(st?.notif) || 'WhatsApp, Outlook, Teams, Propojení s telefonem…';
    $('stMail').textContent = !S.cfg.watch.mail.on ? 'Vypnuto' : stateText(st?.mail) || 'Zapnuto';
    const feeds = st?.feeds || [];
    if (feeds.length) {
      const bad = feeds.find(f => f.error);
      $('stFeeds').className = `hint ${bad ? 'bad' : 'ok'}`;
      $('stFeeds').textContent = bad ? `Kalendář se nepodařilo načíst: ${bad.error}` : `Načteno událostí: ${feeds.reduce((n, f) => n + f.count, 0)}`;
    } else {
      $('stFeeds').className = 'hint';
      $('stFeeds').textContent = 'Google: Nastavení kalendáře → „Tajná adresa ve formátu iCal“. iCloud: Sdílet kalendář → Veřejný kalendář.';
    }
    if ($('settingsDlg').open) refreshPush();
  }

  // ------------------------------------------------------------ Lidé

  function renderPeople() {
    const box = $('peopleList');
    box.textContent = '';
    for (const p of S.cfg.people) {
      const row = el('div', 'item');
      const star = el('button', `star${p.vip ? ' on' : ''}`, p.vip ? '★' : '☆');
      star.setAttribute('aria-label', p.vip ? 'Důležitý člověk' : 'Označit jako důležitého');
      star.onclick = () => savePeople(S.cfg.people.map(x => (x.id === p.id ? { ...x, vip: !x.vip } : x)));
      const main = el('button', 'body');
      main.style.cssText = 'border:0;background:none;text-align:left;padding:0';
      main.append(el('span', 'who', p.name), el('span', 'txt', [p.phone, p.email, p.aliases].filter(Boolean).join(' · ') || 'bez čísla'));
      main.onclick = () => editPerson(p);
      const del = el('button', 'del', '✕');
      del.setAttribute('aria-label', 'Smazat');
      del.onclick = () => {
        if (del.dataset.sure) { savePeople(S.cfg.people.filter(x => x.id !== p.id)); return; }
        del.dataset.sure = '1';
        del.textContent = 'Smazat?';
        del.style.width = 'auto';
        setTimeout(() => { delete del.dataset.sure; del.textContent = '✕'; del.style.width = ''; }, 3000);
      };
      row.append(star, main, del);
      box.append(row);
    }
  }

  function savePeople(people) {
    api.saveCfg({ people });
    renderPeople();
  }

  function editPerson(p) {
    editing = p ? p.id : null;
    $('personFormTitle').textContent = p ? 'Upravit člověka' : 'Přidat člověka';
    $('pnName').value = p?.name || '';
    $('pnPhone').value = p?.phone || '';
    $('pnEmail').value = p?.email || '';
    $('pnAliases').value = p?.aliases || '';
    $('pnVip').checked = !!p?.vip;
    $('pnSave').textContent = p ? 'Uložit' : 'Přidat';
    $('pnCancel').hidden = !p;
  }

  function openPeople() {
    renderPeople();
    editPerson(null);
    $('pnPick').hidden = !(navigator.contacts && navigator.contacts.select);
    $('peopleDlg').showModal();
  }

  $('pnSave').onclick = () => {
    const name = $('pnName').value.trim();
    if (!name) { toast('Chybí jméno.', true); return; }
    const person = {
      id: editing || Math.random().toString(36).slice(2, 10), name, phone: $('pnPhone').value.trim(),
      email: $('pnEmail').value.trim().toLowerCase(), aliases: $('pnAliases').value.trim(), vip: $('pnVip').checked,
    };
    savePeople(editing ? S.cfg.people.map(x => (x.id === editing ? person : x)) : [...S.cfg.people, person]);
    editPerson(null);
  };
  $('pnCancel').onclick = () => editPerson(null);
  $('pnPick').onclick = async () => {
    try {
      const [c] = await navigator.contacts.select(['name', 'tel', 'email'], { multiple: false });
      if (!c) return;
      $('pnName').value = (c.name && c.name[0]) || '';
      $('pnPhone').value = (c.tel && c.tel[0]) || '';
      $('pnEmail').value = (c.email && c.email[0]) || '';
    } catch { toast('Kontakty se nepodařilo otevřít.', true); }
  };

  // ------------------------------------------------------------ Přehled upozornění

  const MARK = { vip: '★', important: '●', normal: '·' };

  function renderInbox() {
    const box = $('inboxList');
    box.textContent = '';
    const snoozed = S.cfg.snoozeUntil > Date.now();
    $('inboxState').textContent = !S.cfg.watch.enabled ? 'Hlídání je vypnuté (Nastavení → Priority a hlídání).'
      : snoozed ? `Nerušit do ${hhmm(new Date(S.cfg.snoozeUntil))} – důležité věci se jen zapisují sem.`
        : online() ? 'Počítač hlídá zprávy, poštu a kalendář. Tady je, co zachytil.' : 'Počítač je offline, teď se nic nehlídá. Tohle je poslední známý stav.';
    $('snoozeOff').hidden = !snoozed;
    $('snooze60').hidden = snoozed;
    $('snooze240').hidden = snoozed;
    $('inboxOnlyBtn').classList.toggle('on', onlyImportant);
    const items = S.inbox.items.filter(i => !onlyImportant || i.level !== 'normal');
    if (!items.length) { box.append(el('div', 'empty', onlyImportant ? 'Nic důležitého.' : 'Zatím nic.')); return; }
    for (const it of items.slice(0, 150)) {
      const row = el('button', `item ${it.level || 'normal'}${it.seen || it.action === 'log' ? '' : ' unseen'}`);
      const bodyEl = el('span', 'body');
      const head = el('span', 'head');
      head.append(el('span', 'who', api.alertHead(it)), el('span', 'when', timeAgo(it.ts)));
      bodyEl.append(head, el('span', 'txt', api.alertBody(it)));
      if (it.why) bodyEl.append(el('span', 'why', it.why + (it.held ? ' · zadrženo (nerušit)' : '')));
      row.append(el('span', 'mark', MARK[it.level] || '·'), bodyEl);
      row.onclick = () => api.ring(it, { silent: true });
      box.append(row);
    }
  }

  $('inboxBtn').onclick = () => {
    renderInbox();
    if (online()) { api.send({ t: 'inbox' }, true); api.send({ t: 'inbox-seen', ids: 'all' }, true); }
    $('inboxDlg').showModal();
  };
  $('inboxOnlyBtn').onclick = () => { onlyImportant = !onlyImportant; renderInbox(); };
  $('inboxClearBtn').onclick = () => {
    if (!online()) { toast('Vymazat to jde, až bude počítač připojený.', true); return; }
    api.send({ t: 'inbox-clear' });
  };
  const snooze = minutes => {
    const until = minutes > 0 ? Date.now() + minutes * 60000 : 0;
    if (online()) { api.send({ t: 'snooze', minutes }); S.cfg.snoozeUntil = until; store.set('cfg', S.cfg); } else api.saveCfg({ snoozeUntil: until });
    toast(minutes > 0 ? `Do ${hhmm(new Date(until))} tě nebudu rušit.` : 'Zase ti dám vědět o všem důležitém.');
    renderInbox();
  };
  $('snooze60').onclick = () => snooze(60);
  $('snooze240').onclick = () => snooze(240);
  $('snoozeOff').onclick = () => snooze(0);

  // ------------------------------------------------------------ Co umím

  function openHelp() {
    const box = $('helpList');
    box.textContent = '';
    for (const g of EXAMPLES) {
      box.append(el('h3', '', g.group + (g.phone ? ' ☎' : '')));
      for (const t of g.items) {
        const b = el('button', '', `→ ${t}`);
        b.onclick = () => {
          $('helpDlg').close();
          const input = $('input');
          input.value = t;
          input.dispatchEvent(new Event('input'));
          input.focus();
        };
        box.append(b);
      }
    }
    $('helpDlg').showModal();
  }

  return {
    openHelp, onQr, onMailTest, onMistralTest, onStatus, onCallTest,
    onPush() { refreshPush(); api.send({ t: 'status' }, true); },
    onInbox() { if ($('inboxDlg').open) renderInbox(); },
    onCfg() {
      if ($('peopleDlg').open) renderPeople();
      if ($('inboxDlg').open) renderInbox();
      if ($('settingsDlg').open) { $('setQuickModel').value = S.quickModel; $('setCalPhone').value = S.cfg.skills.calendarPhone; $('setMessenger').value = S.cfg.skills.messenger; }
      if ($('prioDlg').open) fillPrio();
    },
    onConn() {
      if ($('prioDlg').open) $('prioOffline').hidden = online();
      if ($('inboxDlg').open) renderInbox();
      if ($('settingsDlg').open) $('setQuickModel').disabled = !online();
    },
  };
}
