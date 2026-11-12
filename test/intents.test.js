import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent, parseWhen, findPerson, phoneDigits, fold, fmtWhen, toLocalIso } from '../public/intents.js';

// Středa 11. 11. 2026, 14:00
const NOW = new Date(2026, 10, 11, 14, 0);
const people = [
  { name: 'Petr Novák', phone: '+420 777 111 222', email: 'petr@firma.cz', vip: true },
  { name: 'Jana Svobodová', phone: '602333444' },
  { name: 'Máma', phone: '601 000 111', aliases: 'maminka, mamka' },
  { name: 'Honza', phone: '+420608555666', aliases: 'Jan Dvořák' },
];
const P = (t, extra) => parseIntent(t, { people, now: NOW, ...extra });
const iso = (y, mo, d, h = 0, mi = 0) => toLocalIso(new Date(y, mo - 1, d, h, mi));

test('fold zachovává délku a pozice', () => {
  const s = 'Příliš žluťoučký kůň ÚPĚL ďábelské ódy 😀 ok';
  assert.equal(fold(s).length, s.normalize('NFC').length);
  assert.equal(fold('Čeština Řeka'), 'cestina reka');
});

test('kontakty: skloňování', () => {
  assert.equal(findPerson(people, 'Petrovi').person.name, 'Petr Novák');
  assert.equal(findPerson(people, 'petru novákovi').person.name, 'Petr Novák');
  assert.equal(findPerson(people, 'Janě').person.name, 'Jana Svobodová');
  assert.equal(findPerson(people, 'mamince').person.name, 'Máma');
  assert.equal(findPerson(people, 'mámě').person.name, 'Máma');
  assert.equal(findPerson(people, 'mojí mámě').person.name, 'Máma');
  assert.equal(findPerson(people, 'Honzovi').person.name, 'Honza');
  assert.equal(findPerson(people, 'funkci'), null);
  assert.equal(findPerson(people, 'test'), null);
  assert.equal(findPerson(people, 'petrolejovou lampu'), null);
});

test('telefonní čísla', () => {
  assert.equal(phoneDigits('+420 777 111 222'), '420777111222');
  assert.equal(phoneDigits('602333444'), '420602333444');
  assert.equal(phoneDigits('00420 602 333 444'), '420602333444');
  assert.equal(phoneDigits(''), '');
});

test('WhatsApp', () => {
  let r = P('Napiš Petrovi na WhatsApp, že přijdu později.');
  assert.equal(r.id, 'whatsapp');
  assert.equal(r.args.to, 'Petr Novák');
  assert.equal(r.args.text, 'Přijdu později');
  assert.equal(r.args.rephrase, false);

  r = P('pošli mamince přes whatsapp že nestíhám');
  assert.deepEqual([r.id, r.args.to, r.args.text], ['whatsapp', 'Máma', 'Nestíhám']);

  r = P('napiš na WhatsApp Janě, že dorazím v pět');
  assert.deepEqual([r.id, r.args.to, r.args.text], ['whatsapp', 'Jana Svobodová', 'Dorazím v pět']);

  r = P('WhatsApp Honzovi: zavolám ti zítra');
  assert.deepEqual([r.id, r.args.to, r.args.text], ['whatsapp', 'Honza', 'Zavolám ti zítra']);

  r = P('napiš Petrovi že jsem na cestě');
  assert.deepEqual([r.id, r.args.to, r.args.text], ['whatsapp', 'Petr Novák', 'Jsem na cestě']);

  r = P('napiš Petrovi ať koupí mlíko');
  assert.equal(r.id, 'whatsapp');
  assert.equal(r.args.rephrase, true);

  // neznámý člověk – zpráva se připraví, příjemce se vybere ve WhatsAppu
  r = P('napiš Karlovi na vocap že přijdu');
  assert.equal(r.id, 'whatsapp');
  assert.equal(r.args.person, null);
  assert.equal(r.args.to, 'Karlovi');

  // výchozí kanál SMS
  r = P('napiš Petrovi že jsem na cestě', { messenger: 'sms' });
  assert.equal(r.id, 'sms');
});

test('SMS a e-mail', () => {
  let r = P('pošli mámě SMS, že volám večer');
  assert.deepEqual([r.id, r.args.to, r.args.text], ['sms', 'Máma', 'Volám večer']);
  r = P('napiš Petrovi esemesku že čekám dole');
  assert.equal(r.id, 'sms');
  r = P('napiš Petrovi mail, že posílám fakturu');
  assert.deepEqual([r.id, r.args.to, r.args.text], ['mail', 'Petr Novák', 'Posílám fakturu']);
});

test('programátorské věty nejsou rychlé povely', () => {
  for (const t of [
    'napiš funkci která sečte dvě čísla',
    'napiš test pro server.js',
    'najdi v projektu chyby a oprav je',
    'co je v téhle složce?',
    'shrň, na čem jsem naposledy pracoval',
    'otevři soubor server.js a oprav chybu',
    'co mám dělat s tou chybou',
    'vytvoř nový soubor index.html',
    'přidej validaci formuláře a upozorni uživatele když chybí e-mail',
    'spusť testy',
    'pošli to na GitHub',
    'napiš mi shrnutí změn',
    'jak se jmenuje ta funkce',
  ]) assert.equal(P(t, { strict: true }), null, t);
  assert.equal(P('vyhledej v projektu všechny TODO', { strict: true }), null);
  assert.equal(P('napiš funkci mailer, která posílá zprávy', { strict: true }), null);
});

test('volání', () => {
  let r = P('zavolej Petrovi');
  assert.deepEqual([r.id, r.args.to], ['call', 'Petr Novák']);
  r = P('zavolej na 777 123 456');
  assert.deepEqual([r.id, r.args.number], ['call', '777123456']);
  r = P('zavolej Karlovi');
  assert.equal(r.id, 'call');
  assert.ok(r.need);
  assert.equal(P('zavolej api endpoint a vypiš odpověď'), null);
});

test('VS Code a počítač', () => {
  assert.deepEqual(P('otevři VS Code').args, { project: '' });
  assert.equal(P('otevři vscode').id, 'vscode');
  assert.equal(P('Spusť vs kód').id, 'vscode');
  assert.equal(P('otevři Visual Studio Code').id, 'vscode');
  assert.equal(P('otevři VS Code ve složce talktoclaude').args.project, 'talktoclaude');
  assert.equal(P('otevři projekt Moje Hra ve VS Code').args.project, 'Moje Hra');
  assert.equal(P('otevři na počítači VS Code').id, 'vscode');
  const r = P('otevři Spotify na počítači');
  assert.deepEqual([r.id, r.args.target], ['pc_open', 'Spotify']);
});

test('datum a čas', () => {
  let w = parseWhen('zítra v 10 zubaře', NOW);
  assert.equal(toLocalIso(w.start), iso(2026, 11, 12, 10));
  assert.equal(w.rest, 'zubaře');
  assert.equal(w.allDay, false);

  w = parseWhen('schůzku s Janou v pátek ve 2 na hodinu', NOW);
  assert.equal(toLocalIso(w.start), iso(2026, 11, 13, 14));
  assert.equal(toLocalIso(w.end), iso(2026, 11, 13, 15));
  assert.equal(w.rest, 'schůzku s Janou');

  w = parseWhen('5. prosince oslava', NOW);
  assert.equal(toLocalIso(w.start), iso(2026, 12, 5));
  assert.equal(w.allDay, true);
  assert.equal(w.rest, 'oslava');

  w = parseWhen('5.12. v 18:30 večeře', NOW);
  assert.equal(toLocalIso(w.start), iso(2026, 12, 5, 18, 30));
  assert.equal(w.rest, 'večeře');

  w = parseWhen('3. 2. lyže', NOW);                 // už bylo → příští rok
  assert.equal(toLocalIso(w.start), iso(2027, 2, 3));

  w = parseWhen('za 20 minut vypnout troubu', NOW);
  assert.equal(toLocalIso(w.start), iso(2026, 11, 11, 14, 20));
  assert.equal(w.rest, 'vypnout troubu');

  w = parseWhen('za hodinu a půl', NOW);
  assert.equal(toLocalIso(w.start), iso(2026, 11, 11, 15, 30));
  w = parseWhen('za půl hodiny', NOW);
  assert.equal(toLocalIso(w.start), iso(2026, 11, 11, 14, 30));

  w = parseWhen('v půl čtvrté', NOW);
  assert.equal(toLocalIso(w.start), iso(2026, 11, 11, 15, 30));
  w = parseWhen('ve čtvrt na pět', NOW);
  assert.equal(toLocalIso(w.start), iso(2026, 11, 11, 16, 15));
  w = parseWhen('zítra ve tři čtvrtě na deset', NOW);
  assert.equal(toLocalIso(w.start), iso(2026, 11, 12, 9, 45));
  w = parseWhen('zítra v půl jedné', NOW);
  assert.equal(toLocalIso(w.start), iso(2026, 11, 12, 12, 30));

  w = parseWhen('v 9', NOW);                        // dnes už bylo → zítra
  assert.equal(toLocalIso(w.start), iso(2026, 11, 12, 9));
  w = parseWhen('v 8 večer', NOW);
  assert.equal(toLocalIso(w.start), iso(2026, 11, 11, 20));
  w = parseWhen('zítra ráno', NOW);
  assert.equal(toLocalIso(w.start), iso(2026, 11, 12, 8));
  w = parseWhen('zítra v poledne oběd', NOW);
  assert.equal(toLocalIso(w.start), iso(2026, 11, 12, 12));

  w = parseWhen('v pondělí od 9 do 11 porada', NOW);
  assert.equal(toLocalIso(w.start), iso(2026, 11, 16, 9));
  assert.equal(toLocalIso(w.end), iso(2026, 11, 16, 11));
  assert.equal(w.rest, 'porada');

  w = parseWhen('příští středu v 15:00', NOW);
  assert.equal(toLocalIso(w.start), iso(2026, 11, 18, 15));
  w = parseWhen('ve středu v 16', NOW);             // dnes je středa, 16:00 teprve bude
  assert.equal(toLocalIso(w.start), iso(2026, 11, 11, 16));
  w = parseWhen('ve středu v 10', NOW);             // dnes je středa, 10:00 už bylo → za týden
  assert.equal(toLocalIso(w.start), iso(2026, 11, 18, 10));

  w = parseWhen('pozítří na 2 hodiny v 10 workshop', NOW);
  assert.equal(toLocalIso(w.start), iso(2026, 11, 13, 10));
  assert.equal(toLocalIso(w.end), iso(2026, 11, 13, 12));
  w = parseWhen('zítra na 10 hodin', NOW);          // „na 10 hodin“ = čas
  assert.equal(toLocalIso(w.start), iso(2026, 11, 12, 10));

  w = parseWhen('za týden celý den školení', NOW);
  assert.equal(toLocalIso(w.start), iso(2026, 11, 18));
  assert.equal(w.allDay, true);

  assert.equal(parseWhen('kup mlíko', NOW), null);
  assert.equal(fmtWhen(new Date(2026, 10, 12, 10, 0), false, NOW), 'zítra v 10:00');
  assert.equal(fmtWhen(new Date(2026, 10, 13, 9, 5), false, NOW), 'pozítří v 9:05');
  assert.equal(fmtWhen(new Date(2026, 10, 16), true, NOW), 'v pondělí (celý den)');
});

test('kalendář: přidat', () => {
  let r = P('přidej do kalendáře zítra v 10 zubaře');
  assert.equal(r.id, 'calendar_add');
  assert.deepEqual(r.args, { title: 'Zubaře', start: iso(2026, 11, 12, 10), end: iso(2026, 11, 12, 11), allDay: false });

  r = P('naplánuj schůzku s Janou v pátek ve 2 na hodinu');
  assert.deepEqual(r.args, { title: 'Schůzka s Janou', start: iso(2026, 11, 13, 14), end: iso(2026, 11, 13, 15), allDay: false });

  r = P('Zapiš mi do kalendáře 5. prosince oslavu narozenin.');
  assert.deepEqual(r.args, { title: 'Oslava narozenin', start: iso(2026, 12, 5), end: null, allDay: true });

  r = P('dej mi do kalendáře poradu v pondělí od 9 do 11');
  assert.deepEqual(r.args, { title: 'Porada', start: iso(2026, 11, 16, 9), end: iso(2026, 11, 16, 11), allDay: false });

  r = P('přidej do kalendáře nákup dárků');
  assert.equal(r.id, 'calendar_add');
  assert.ok(r.need);
});

test('kalendář: co mám', () => {
  let r = P('co mám zítra?');
  assert.deepEqual([r.id, r.args.from, r.args.to, r.args.label], ['calendar_list', iso(2026, 11, 12), iso(2026, 11, 13), 'zítra']);
  r = P('co mám dnes v kalendáři');
  assert.deepEqual([r.id, r.args.from, r.args.label], ['calendar_list', iso(2026, 11, 11), 'dnes']);
  r = P('co mě čeká tento týden');
  assert.deepEqual([r.args.from, r.args.to], [iso(2026, 11, 11), iso(2026, 11, 16)]);
  r = P('jaký mám zítra program');
  assert.equal(r.id, 'calendar_list');
  r = P('co mám v pátek');
  assert.deepEqual([r.args.from, r.args.to], [iso(2026, 11, 13), iso(2026, 11, 14)]);
  r = P('co mám v kalendáři');
  assert.equal(r.args.label, 'v příštích 7 dnech');
  assert.equal(P('co mám dělat'), null);
  assert.equal(P('co je v téhle složce'), null);
});

test('připomínky a časovač', () => {
  let r = P('připomeň mi za 20 minut vypnout troubu');
  assert.deepEqual([r.id, r.args.at, r.args.text], ['remind', iso(2026, 11, 11, 14, 20), 'Vypnout troubu']);
  r = P('připomeň mi zítra v 8, že mám zavolat Petrovi');
  assert.deepEqual([r.args.at, r.args.text], [iso(2026, 11, 12, 8), 'Mám zavolat Petrovi']);
  r = P('za 10 minut mi připomeň čaj');
  assert.deepEqual([r.id, r.args.at, r.args.text], ['remind', iso(2026, 11, 11, 14, 10), 'Čaj']);
  r = P('vzbuď mě v 7');
  assert.deepEqual([r.id, r.args.at, r.args.text], ['remind', iso(2026, 11, 12, 7), 'Budíček']);
  r = P('časovač na 10 minut');
  assert.deepEqual([r.id, r.args.at], ['remind', iso(2026, 11, 11, 14, 10)]);
  r = P('zavolej mi za hodinu');
  assert.deepEqual([r.id, r.args.at], ['remind', iso(2026, 11, 11, 15, 0)]);
  r = P('připomeň mi koupit chleba');
  assert.equal(r.id, 'remind');
  assert.ok(r.need);
});

test('hlídání, režimy, drobnosti', () => {
  assert.equal(P('co je nového?').id, 'inbox');
  assert.equal(P('přečti mi nové zprávy').id, 'inbox');
  assert.deepEqual(P('neruš mě hodinu').args, { minutes: 60 });
  assert.deepEqual(P('neruš mě 2 hodiny').args, { minutes: 120 });
  assert.deepEqual(P('neruš mě').args, { minutes: 60 });
  assert.deepEqual(P('neruš mě do 16:30').args, { minutes: 150 });
  assert.deepEqual(P('už mě můžeš rušit').args, { minutes: 0 });
  assert.deepEqual(P('zapni automatický režim'), { id: 'auto', args: { on: true } });
  assert.deepEqual(P('vypni automatiku'), { id: 'auto', args: { on: false } });
  assert.equal(P('co umíš?').id, 'help');
  assert.equal(P('kolik je hodin').id, 'time');
  assert.equal(P('jaké je dnes datum').id, 'date');
  assert.deepEqual(P('Claude, napiš Petrovi na WhatsApp že přijdu'), { id: 'claude', args: { text: 'napiš Petrovi na WhatsApp že přijdu' } });
});

test('navigace, hledání, YouTube', () => {
  assert.deepEqual(P('naviguj na Hlavní nádraží Praha'), { id: 'navigate', args: { destination: 'Hlavní nádraží Praha' } });
  assert.deepEqual(P('naviguj mě domů'), { id: 'navigate', args: { destination: 'domů' } });
  assert.deepEqual(P('vyhledej otevírací dobu IKEA'), { id: 'search', args: { query: 'otevírací dobu IKEA' } });
  assert.deepEqual(P('najdi na internetu recept na svíčkovou'), { id: 'search', args: { query: 'recept na svíčkovou' } });
  assert.deepEqual(P('pusť lofi na YouTube'), { id: 'youtube', args: { query: 'lofi' } });
});
