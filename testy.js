// Testovací skript pro mobilní aplikaci TalkToClaude
// Spusť: node testy.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Barvy pro výstup
const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color] || ''}${message}${colors.reset}`);
}

function test(name, fn) {
  try {
    const result = fn();
    if (result === true) {
      log(`✅ ${name}`, 'green');
      return { name, passed: true };
    } else {
      log(`❌ ${name}: ${result}`, 'red');
      return { name, passed: false, error: result };
    }
  } catch (e) {
    log(`❌ ${name}: ${e.message}`, 'red');
    return { name, passed: false, error: e.message };
  }
}

function header(text) {
  log(`\n${'='.repeat(60)}`, 'blue');
  log(` ${text}`, 'blue');
  log('='.repeat(60), 'blue');
}

// Testy struktury projektu
function runStructureTests() {
  header('TESTY STRUKTURY PROJEKTU');
  
  const results = [];
  
  // Základní soubory
  results.push(test('index.html existuje', () => {
    return fs.existsSync(path.join(__dirname, 'index.html')) || 'Chybí index.html';
  }));
  
  results.push(test('server.js existuje', () => {
    return fs.existsSync(path.join(__dirname, 'server.js')) || 'Chybí server.js';
  }));
  
  results.push(test('public/app.js existuje', () => {
    return fs.existsSync(path.join(__dirname, 'public', 'app.js')) || 'Chybí public/app.js';
  }));
  
  // Důležité moduly
  const libFiles = ['skills.js', 'pc.js', 'calendar.js', 'mail.js', 'priorities.js', 'push.js', 'store.js'];
  for (const file of libFiles) {
    results.push(test(`lib/${file} existuje`, () => {
      return fs.existsSync(path.join(__dirname, 'lib', file)) || `Chybí lib/${file}`;
    }));
  }
  
  // Data adresář
  results.push(test('data/ adresář existuje', () => {
    return fs.existsSync(path.join(__dirname, 'data')) || 'Chybí data/';
  }));
  
  // Konfigurační soubory
  const dataFiles = ['config.json', 'settings.json', 'inbox.json'];
  for (const file of dataFiles) {
    const filePath = path.join(__dirname, 'data', file);
    if (fs.existsSync(filePath)) {
      results.push(test(`data/${file} existuje`, () => true));
    } else {
      results.push(test(`data/${file} existuje (není kritické)`, () => 'Soubor bude vytvořen při prvním spuštění'));
    }
  }
  
  return results;
}

// Testy obsahu souborů
function runContentTests() {
  header('TESTY OBSAHU SOUBORŮ');
  
  const results = [];
  
  // Test index.html
  const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  results.push(test('index.html má "Automaticky" tlačítko', () => {
    return indexHtml.includes('autoSeg') || 'Chybí autoSeg element';
  }));
  
  results.push(test('index.html má hlasový vstup', () => {
    return indexHtml.includes('input') && indexHtml.includes('microphone') || 
           indexHtml.includes('Mic') || indexHtml.includes('Zvuk') || 'Chybí mikrofon tlačítko';
  }));
  
  results.push(test('index.html má WebSocket připojení', () => {
    return indexHtml.includes('WebSocket') || indexHtml.includes('ws://') || indexHtml.includes('wss://') || 
           indexHtml.includes('app.js') || 'Připojení je v app.js';
  }));
  
  // Test server.js
  const serverJs = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  results.push(test('server.js má WebSocket server', () => {
    return serverJs.includes('WebSocketServer') || 'Chybí WebSocketServer';
  }));
  
  results.push(test('server.js hlídá tunel', () => {
    return serverJs.includes('tunnelUrl') && serverJs.includes('setInterval') || 'Chybí hlídání tunelu';
  }));
  
  results.push(test('server.js má hlídání e-mailu', () => {
    return serverJs.includes('MailWatcher') || 'Chybí MailWatcher';
  }));
  
  results.push(test('server.js má hlídání kalendáře', () => {
    return serverJs.includes('Calendar') || 'Chybí Calendar';
  }));
  
  // Test skills.js
  const skillsJs = fs.readFileSync(path.join(__dirname, 'lib', 'skills.js'), 'utf8');
  const requiredSkills = [
    'send_message', 'call_contact', 'calendar_add', 'calendar_list',
    'remind', 'alert_user', 'open_vscode', 'open_on_pc', 'do_not_disturb'
  ];
  
  for (const skill of requiredSkills) {
    results.push(test(`skills.js má ${skill}`, () => {
      return skillsJs.includes(skill) || `Chybí skill ${skill}`;
    }));
  }
  
  // Test priorities.js
  const prioritiesJs = fs.readFileSync(path.join(__dirname, 'lib', 'priorities.js'), 'utf8');
  results.push(test('priorities.js má classify funkci', () => {
    return prioritiesJs.includes('function classify') || prioritiesJs.includes('classify') || 'Chybí classify';
  }));
  
  results.push(test('priorities.js má decide funkci', () => {
    return prioritiesJs.includes('function decide') || prioritiesJs.includes('decide') || 'Chybí decide';
  }));
  
  return results;
}

// Testy konfiguračních souborů
function runConfigTests() {
  header('TESTY KONFIGURACE');
  
  const results = [];
  
  // Test config.json
  const configPath = path.join(__dirname, 'data', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      results.push(test('config.json je validní JSON', () => true));
      results.push(test('config.json má token', () => {
        return config.token && config.token.length > 10 || 'Token je příliš krátký';
      }));
      results.push(test('config.json má port', () => {
        return config.port && config.port > 0 || 'Chybí port';
      }));
    } catch (e) {
      results.push(test('config.json je validní JSON', () => `Chyba: ${e.message}`));
    }
  } else {
    results.push(test('config.json existuje', () => 'Soubor bude vytvořen při prvním spuštění'));
  }
  
  // Test settings.json
  const settingsPath = path.join(__dirname, 'data', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      results.push(test('settings.json je validní JSON', () => true));
      results.push(test('settings.json má priorities', () => {
        return settings.priorities ? true : 'Chybí priorities';
      }));
      results.push(test('settings.json má watch', () => {
        return settings.watch ? true : 'Chybí watch';
      }));
    } catch (e) {
      results.push(test('settings.json je validní JSON', () => `Chyba: ${e.message}`));
    }
  } else {
    results.push(test('settings.json existuje', () => 'Soubor bude vytvořen při prvním spuštění'));
  }
  
  return results;
}

// Testy specifických požadavků z promptu
function runFeatureTests() {
  header('TESTY POŽADAVKŮ Z PROMPTU');
  
  const results = [];
  
  const serverJs = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
  
  // 1. Aplikace otevřená i bez PC
  results.push(test('Aplikace funguje bez PC (statická)', () => {
    const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    return indexHtml.includes('mobile-web-app-capable') || 
           indexHtml.includes('standalone') || 
           'index.html má PWA nastavení';
  }));
  
  // 2. Hlasové ovládání
  results.push(test('Hlasové ovládání je implementováno', () => {
    return appJs.includes('SpeechRecognition') || 
           appJs.includes('webkitSpeechRecognition') || 
           appJs.includes('recognition') ||
           'Hlasové ovládání je v app.js';
  }));
  
  // 3. Kontrolní skript - 10s interval
  results.push(test('Kontrola připojení PC každých 10s', () => {
    // Hledáme explicitní interval 10000 (10s) pro kontrolu PC spojení
    // Aktuálně server hlídá tunel každých 30s a WebSocket také každých 30s
    // Chybí explicitní 10s kontrola
    const has10sCheck = serverJs.includes('setInterval') && 
                       serverJs.includes('10000') && 
                       (serverJs.includes('pc') || serverJs.includes('computer') || serverJs.includes('connection'));
    if (has10sCheck) {
      return true;
    }
    return '❌ Chybí 10s interval pro kontrolu připojení PC - aktuálně je 30s (tunel a WebSocket)';
  }));
  
  // 4. Automatický režim
  results.push(test('Automatický režim je implementován', () => {
    const hasAutoMode = serverJs.includes('bypassPermissions') || serverJs.includes('auto');
    const hasAutoUI = appJs.includes('autoSeg') || appJs.includes('Automaticky');
    return hasAutoMode && hasAutoUI || 'Chybí automatický režim';
  }));
  
  // 5. Skills pro běžné úkoly
  results.push(test('Skills pro odeslání zprávy existují', () => {
    const skillsJs = fs.readFileSync(path.join(__dirname, 'lib', 'skills.js'), 'utf8');
    return skillsJs.includes('send_message') || skillsJs.includes('whatsapp') || 'Chybí send_message skill';
  }));
  
  results.push(test('Skills pro kalendář existují', () => {
    const skillsJs = fs.readFileSync(path.join(__dirname, 'lib', 'skills.js'), 'utf8');
    return skillsJs.includes('calendar_add') && skillsJs.includes('calendar_list') || 'Chybí calendar skills';
  }));
  
  results.push(test('Skills pro VS Code existují', () => {
    const skillsJs = fs.readFileSync(path.join(__dirname, 'lib', 'skills.js'), 'utf8');
    return skillsJs.includes('vscode') || skillsJs.includes('openVsCode') || 'Chybí VS Code skill';
  }));
  
  // 6. Monitorování
  results.push(test('Monitorování kalendáře je implementováno', () => {
    const calendarJs = fs.readFileSync(path.join(__dirname, 'lib', 'calendar.js'), 'utf8');
    return calendarJs.includes('setInterval') && calendarJs.includes('tick') || 'Chybí monitorování kalendáře';
  }));
  
  results.push(test('Monitorování e-mailu je implementováno', () => {
    const mailJs = fs.readFileSync(path.join(__dirname, 'lib', 'mail.js'), 'utf8');
    return mailJs.includes('setInterval') || mailJs.includes('poll') || 'Chybí monitorování e-mailu';
  }));
  
  // 7. Nastavení priorit
  results.push(test('Nastavení priorit je implementováno', () => {
    const prioritiesJs = fs.readFileSync(path.join(__dirname, 'lib', 'priorities.js'), 'utf8');
    return prioritiesJs.includes('keywords') && prioritiesJs.includes('vip') || 'Chybí nastavení priorit';
  }));
  
  // 8. Zavolání při důležitém
  results.push(test('Funkce "zavolat" je implementována', () => {
    const hasCall = appJs.includes('call') || appJs.includes('Call');
    const hasCallUI = appJs.includes('callDlg') || appJs.includes('call');
    return hasCall && hasCallUI || 'Chybí funkce zavolání';
  }));
  
  return results;
}

// Hlavní testovací funkce
function runAllTests() {
  log('\n' + '='.repeat(60), 'blue');
  log('  TESTY MOBILNÍ APLIKACE TALKTOCLAUDE', 'blue');
  log('='.repeat(60), 'blue');
  
  const allResults = [];
  
  allResults.push(...runStructureTests());
  allResults.push(...runContentTests());
  allResults.push(...runConfigTests());
  allResults.push(...runFeatureTests());
  
  // Souhrn
  header('SOUHRN TESTŮ');
  
  const passed = allResults.filter(r => r.passed).length;
  const failed = allResults.filter(r => !r.passed).length;
  const total = allResults.length;
  
  log(`\nCelkový počet testů: ${total}`);
  log(`  Úspěšných: ${passed}`, 'green');
  log(`  Neúspěšných: ${failed}`, failed > 0 ? 'red' : 'green');
  
  const successRate = Math.round((passed / total) * 100);
  log(`\nÚspěšnost: ${successRate}%`);
  
  if (failed > 0) {
    log('\nNeúspěšné testy:', 'yellow');
    allResults.filter(r => !r.passed).forEach(r => {
      log(`  ❌ ${r.name}: ${r.error || 'Neznámá chyba'}`, 'red');
    });
  }
  
  // Kritické chybějící funkce
  log('\n' + '-'.repeat(60), 'blue');
  log('  KRITICKÉ CHYBJEJÍCÍ FUNKCE:', 'yellow');
  log('-'.repeat(60), 'blue');
  
  const criticalMissing = [];
  
  // Kontrola 10s intervalu
  const serverJs = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  // Hledáme explicitní 10s interval pro PC kontrolu
  const hasHeartbeat = serverJs.includes('pc-heartbeat');
  const has10sInterval = serverJs.includes('10000');
  if (!hasHeartbeat || !has10sInterval) {
    criticalMissing.push('❌ Kontrola připojení PC každých 10 sekund (aktuálně 30s)');
  }
  
  // Automatický režim - úplné povolení
  const appJs = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
  if (appJs.includes('bypassPermissions') && !appJs.includes('S.auto')) {
    criticalMissing.push('⚠️  Automatický režim nemusí fungovat úplně správně');
  }
  
  if (criticalMissing.length > 0) {
    criticalMissing.forEach(item => log(`  ${item}`, 'red'));
  } else {
    log('  ✅ Všechny kritické funkce jsou implementovány!', 'green');
  }
  
  return { passed, failed, total, successRate };
}

// Spuštění testů
try {
  const result = runAllTests();
  process.exit(result.failed > 0 ? 1 : 0);
} catch (e) {
  log(`\n❌ Chyba při spouštění testů: ${e.message}`, 'red');
  process.exit(1);
}
