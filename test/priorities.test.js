import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, decide, defaultSettings, matchPerson, inQuiet } from '../lib/priorities.js';

const NOW = new Date(2026, 10, 11, 14, 0); // Středa 11. listopadu 2026, 14:00
const defaultCfg = defaultSettings();

// Vytvoř testovací nastavení
function createSettings(overrides = {}) {
  return {
    ...defaultCfg,
    people: [
      { name: 'Petr Novák', phone: '+420 777 111 222', email: 'petr@firma.cz', vip: true },
      { name: 'Jana Svobodová', phone: '602333444', email: 'jana@seznam.cz', vip: false },
      { name: 'Máma', phone: '601 000 111', aliases: 'maminka, mamka', vip: true },
    ],
    priorities: {
      ...defaultCfg.priorities,
      ...overrides.priorities,
    },
    watch: {
      ...defaultCfg.watch,
      ...overrides.watch,
    },
  };
}

test('classify: VIP odesílatel', () => {
  const settings = createSettings({
    priorities: { notify: 'vip', call: 'vip' },
  });
  
  // E-mail od VIP
  const item = {
    source: 'mail',
    app: 'E-mail',
    from: 'Petr Novák',
    fromAddr: 'petr@firma.cz',
    title: 'Důležitá zpráva',
    text: 'Potřebuji to vyřídit hned.',
    bulk: false,
  };
  
  const result = classify(item, settings, NOW);
  assert.equal(result.level, 'vip', 'VIP odesílatel by měl být klasifikován jako vip');
  assert.equal(result.action, 'call', 'VIP s call:vip by měl spustit call');
  assert.ok(result.why.includes('Petr Novák'), 'Důvod by měl obsahovat jméno odesílatele');
});

test('classify: důležité slovo', () => {
  const settings = createSettings({
    priorities: { 
      keywords: ['urgentní', 'faktura', 'důležité'],
      notify: 'important',
      call: 'important'
    },
  });
  
  // E-mail s důležitým slovem od běžného člověka
  const item = {
    source: 'mail',
    app: 'E-mail',
    from: 'Jana Svobodová',
    fromAddr: 'jana@seznam.cz',
    title: 'Faktura č. 123',
    text: 'Prosím zaplaťte fakturu.',
    bulk: false,
  };
  
  const result = classify(item, settings, NOW);
  assert.equal(result.level, 'important', 'Důležité slovo by mělo způsobit level important');
  assert.equal(result.action, 'call', 'S call:important by měl spustit call');
  assert.ok(result.why.includes('důležité slovo'), 'Důvod by měl zmínit důležité slovo');
});

test('classify: ztlumený newsletter', () => {
  const settings = createSettings({
    priorities: {
      mute: ['newsletter', 'unsubscribe', 'odhlásit'],
      notify: 'important',
      call: 'vip',
    },
  });
  
  // Newsletter
  const item = {
    source: 'mail',
    app: 'E-mail',
    from: 'Newsletter Company',
    fromAddr: 'news@company.com',
    title: 'Naše novinky',
    text: 'Přihlaste se k odběru newsletteru. Odhlásit odběr: ...',
    bulk: false,
  };
  
  const result = classify(item, settings, NOW);
  assert.equal(result.level, 'muted', 'Newsletter s mute slovem by měl být ztlumen');
  assert.equal(result.action, 'drop', 'Ztlumené zprávy by se měly zahodit');
  assert.ok(result.why.includes('ztlumeno'), 'Důvod by měl zmínit ztlumení');
});

test('classify: VIP i s mute slovem', () => {
  const settings = createSettings({
    priorities: {
      mute: ['newsletter', 'unsubscribe'],
      notify: 'important',
      call: 'vip',
    },
  });
  
  // VIP odesílatel, ale s mute slovem v textu
  const item = {
    source: 'mail',
    app: 'E-mail',
    from: 'Petr Novák',
    fromAddr: 'petr@firma.cz',
    title: 'Newsletter od Petry',
    text: 'Tady máš newsletter. Odhlásit odběr ...',
    bulk: false,
  };
  
  const result = classify(item, settings, NOW);
  // VIP by měl mít přednost před mute
  assert.equal(result.level, 'vip', 'VIP by měl mít přednost před mute slovem');
  assert.notEqual(result.action, 'drop', 'VIP zpráva by se neměla zahodit');
});

test('classify: reminder vždy důležitý', () => {
  const settings = createSettings();
  
  const item = {
    source: 'reminder',
    app: 'Připomínka',
    from: 'Připomínka',
    title: 'Zavolej Petrovi',
    text: 'Nezapomeň zavolat.',
  };
  
  const result = classify(item, settings, NOW);
  assert.equal(result.level, 'important', 'Připomínka by měla být vždy důležitá');
  assert.equal(result.action, 'call', 'Připomínka by měla spustit call');
});

test('classify: calendar event důležitý', () => {
  const settings = createSettings();
  
  const item = {
    source: 'calendar',
    app: 'Kalendář',
    from: 'Kalendář',
    title: 'Schůzka s klientem',
    text: 'V 15:00 schůzka.',
  };
  
  const result = classify(item, settings, NOW);
  assert.equal(result.level, 'important', 'Kalendářová událost by měla být důležitá');
  assert.equal(result.action, 'notify', 'Kalendář by měl poslat upozornění');
});

test('classify: bulk email má nižší prioritu', () => {
  const settings = createSettings({
    priorities: {
      notify: 'vip', // Jen VIP dostanou upozornění
      call: 'never',
      mute: [],
    },
  });
  
  const item = {
    source: 'mail',
    app: 'E-mail',
    from: 'Info Company',
    fromAddr: 'info@company.com',
    title: 'Hromadný e-mail',
    text: 'Toto je hromadný e-mail pro všechny zaměstnance.',
    bulk: true,
  };
  
  const result = classify(item, settings, NOW);
  assert.equal(result.level, 'normal', 'Bulk e-mail by měl být normální');
  // S notify: 'vip' a level: 'normal' by action měl být 'log'
  assert.equal(result.action, 'log', 'Bulk e-mail s notify:vip by neměl spustit upozornění');
});

test('decide: noční klid', () => {
  const settings = createSettings({
    priorities: {
      quiet: { on: true, from: '22:00', to: '07:00', vip: false },
    },
  });
  
  // V nočním klidu
  const nightTime = new Date(2026, 10, 11, 23, 0); // 23:00
  
  let result = decide('important', settings, nightTime);
  assert.equal(result.action, 'log', 'V nočním klidu by důležitá zpráva měla být jen zapsána');
  assert.equal(result.held, true, 'Měla by být označena jako zadržená');
  
  // VIP v nočním klidu s vip: false
  result = decide('vip', settings, nightTime);
  assert.equal(result.action, 'log', 'VIP by měl být také zadržen pokud vip: false');
});

test('decide: noční klid s VIP průchodem', () => {
  const settings = createSettings({
    priorities: {
      quiet: { on: true, from: '22:00', to: '07:00', vip: true },
      notify: 'vip',
      call: 'vip',
    },
  });
  
  // V nočním klidu, ale VIP by měl projít
  const nightTime = new Date(2026, 10, 11, 23, 0);
  
  const result = decide('vip', settings, nightTime);
  assert.equal(result.action, 'call', 'VIP by měl projít i v nočním klidu');
  assert.equal(result.held, undefined, 'Neměla by být označena jako zadržená (held je undefined)');
});

test('decide: mimo noční klid', () => {
  const settings = createSettings({
    priorities: {
      quiet: { on: true, from: '22:00', to: '07:00', vip: true },
      notify: 'important',
      call: 'vip',
    },
  });
  
  // Mimo noční klid (14:00)
  const dayTime = NOW;
  
  let result = decide('vip', settings, dayTime);
  assert.equal(result.action, 'call', 'VIP mimo noční klid by měl spustit call');
  
  result = decide('important', settings, dayTime);
  assert.equal(result.action, 'notify', 'Důležitý mimo noční klid by měl spustit notify');
  
  result = decide('normal', settings, dayTime);
  assert.equal(result.action, 'log', 'Normální by měl být jen zapsán');
});

test('decide: notify a call nastavení', () => {
  const settings = createSettings({
    priorities: {
      quiet: { on: false, from: '22:00', to: '07:00', vip: true },
      notify: 'vip',
      call: 'vip',
    },
  });
  
  const dayTime = NOW;
  
  // notify: 'vip' - jen VIP dostanou upozornění
  let result = decide('vip', settings, dayTime);
  assert.equal(result.action, 'call', 'VIP by měl spustit call (call: vip)');
  
  result = decide('important', settings, dayTime);
  assert.equal(result.action, 'log', 'Important by neměl dostat upozornění (notify: vip)');
  
  // notify: 'important'
  const settings2 = createSettings({
    priorities: {
      notify: 'important',
      call: 'important',
    },
  });
  
  result = decide('vip', settings2, dayTime);
  assert.equal(result.action, 'call', 'VIP by měl spustit call (call: important)');
  
  result = decide('important', settings2, dayTime);
  assert.equal(result.action, 'call', 'Important by měl spustit call');
  
  result = decide('normal', settings2, dayTime);
  assert.equal(result.action, 'log', 'Normal by měl být jen zapsán');
});

test('inQuiet: uvnitř intervalu', () => {
  const quiet = { on: true, from: '22:00', to: '07:00', vip: true };
  
  const night = new Date(2026, 10, 11, 23, 30);
  assert.equal(inQuiet(quiet, night), true, '23:30 by mělo být v klidu');
  
  const earlyMorning = new Date(2026, 10, 11, 6, 0);
  assert.equal(inQuiet(quiet, earlyMorning), true, '06:00 by mělo být v klidu');
  
  const noon = new Date(2026, 10, 11, 12, 0);
  assert.equal(inQuiet(quiet, noon), false, '12:00 by nemělo být v klidu');
});

test('inQuiet: přes půlnoc', () => {
  const quiet = { on: true, from: '22:00', to: '06:00', vip: true };
  
  const lateNight = new Date(2026, 10, 11, 23, 0);
  assert.equal(inQuiet(quiet, lateNight), true);
  
  const midnight = new Date(2026, 10, 11, 0, 30);
  assert.equal(inQuiet(quiet, midnight), true, '00:30 by mělo být v klidu');
  
  const morning = new Date(2026, 10, 11, 7, 0);
  assert.equal(inQuiet(quiet, morning), false);
});

test('inQuiet: vypnuto', () => {
  const quiet = { on: false, from: '22:00', to: '07:00', vip: true };
  
  const night = new Date(2026, 10, 11, 23, 0);
  assert.equal(inQuiet(quiet, night), false, 'Klid vypnutý by neměl blokovat');
});

test('matchPerson: e-mail doména', () => {
  const people = [
    { name: 'Petr Novák', email: '@firma.cz', vip: true },
    { name: 'Jana', email: 'jana@seznam.cz', vip: false },
  ];
  
  const result = matchPerson(people, 'Uživatel', 'petr@firma.cz');
  assert.equal(result?.name, 'Petr Novák', 'Mělo by matchnout podle domény');
  
  const result2 = matchPerson(people, 'Jana Svobodová', 'svobodova@seznam.cz');
  assert.equal(result2?.name, 'Jana', 'Mělo by matchnout podle domény seznam.cz');
});

test('matchPerson: telefon', () => {
  const people = [
    { name: 'Petr', phone: '+420777123456', vip: true },
    { name: 'Jana', phone: '602333444', vip: false },
  ];
  
  const result = matchPerson(people, 'Petr Novák', '+420777123456');
  assert.equal(result?.name, 'Petr', 'Mělo by matchnout podle telefonu');
  
  const result2 = matchPerson(people, 'Jana', '602333444');
  assert.equal(result2?.name, 'Jana', 'Mělo by matchnout podle telefonu');
});
