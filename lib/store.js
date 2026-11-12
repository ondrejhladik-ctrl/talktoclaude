// Drobné ukládání do JSON souborů ve složce data/ (není v gitu – jsou tam i hesla).
import fs from 'node:fs';

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.error(`  Uložení ${file} selhalo: ${e.message}`);
    return false;
  }
}

// Zápis nejdřív po chvíli klidu (časté změny se slijí do jednoho zápisu).
export function debounced(file, getData, ms = 500) {
  let timer = null;
  const flush = () => { clearTimeout(timer); timer = null; writeJson(file, getData()); };
  const save = () => { clearTimeout(timer); timer = setTimeout(flush, ms); };
  save.flush = () => { if (timer) flush(); };
  return save;
}

export const errText = e => (e && e.message) || String(e);
export const sleep = ms => new Promise(r => setTimeout(r, ms));
