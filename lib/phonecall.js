// Telefonní hovory přes Twilio Voice API.
// Bez SDK – jen HTTP POST na Twilio API s TwiML.
// Tokeny (SID, token) zůstávají jen na PC, do telefonu se nevrací.

const API_BASE = 'https://api.twilio.com/2010-04-01';

// Omezení: max 5 hovorů za hodinu (kromě VIP v nočním klidu)
const MAX_CALLS_PER_HOUR = 5;
let callHistory = []; // { ts: timestamp, vip: boolean }

function pruneCallHistory() {
  const now = Date.now();
  const hourAgo = now - 3600000;
  callHistory = callHistory.filter(c => c.ts > hourAgo);
}

function canPlaceCall(vip = false, quietSettings = {}) {
  pruneCallHistory();
  
  // VIP projdou vždy v nočním klidu
  const quietOn = quietSettings?.on === true;
  const quietVip = quietSettings?.vip === true;
  const inQuiet = checkQuietTime(quietSettings);
  
  if (inQuiet && !vip) {
    return { allowed: false, reason: 'Noční klid je aktivní' };
  }
  if (inQuiet && vip && quietVip) {
    // VIP projdou
    return { allowed: true };
  }
  
  // Omez na 5 hovorů za hodinu
  const nonVipCalls = callHistory.filter(c => !c.vip).length;
  if (!vip && nonVipCalls >= MAX_CALLS_PER_HOUR) {
    return { allowed: false, reason: `Maximálně ${MAX_CALLS_PER_HOUR} hovorů za hodinu dosaženo` };
  }
  
  return { allowed: true };
}

function checkQuietTime(quiet = {}) {
  if (!quiet?.on) return false;
  
  const now = new Date();
  const mins = t => {
    const [h, m] = String(t).split(':').map(Number);
    return h * 60 + m;
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const from = mins(quiet.from || '22:00');
  const to = mins(quiet.to || '07:00');
  
  if (from === to) return false;
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

function recordCall(vip = false) {
  callHistory.push({ ts: Date.now(), vip });
  pruneCallHistory();
}

/**
 * Zavolá na číslo uživatele a přečte text přes Twilio.
 * @param {Object} config - { twilioSid, twilioToken, fromNumber, toNumber }
 * @param {string} text - Text k přečtení (v češtině)
 * @param {boolean} vip - Je to VIP hovor?
 * @param {Object} quietSettings - Nastavení nočního klidu
 * @returns {Promise<{ok: boolean, message?: string, callSid?: string}>}
 */
export async function placeCall(config, text, vip = false, quietSettings = {}) {
  if (!config?.twilioSid || !config?.twilioToken || !config?.fromNumber) {
    return { ok: false, message: 'Twilio není nastaveno – chybí SID, token nebo číslo' };
  }
  
  const check = canPlaceCall(vip, quietSettings);
  if (!check.allowed) {
    return { ok: false, message: check.reason };
  }
  
  try {
    // TwiML pro češtinu
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="cs-CZ">${escapeXml(text)}</Say>
</Response>`;
    
    // Auth pro Twilio
    const auth = Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString('base64');
    
    const response = await fetch(
      `${API_BASE}/Accounts/${config.twilioSid}/Calls.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: config.toNumber,
          From: config.fromNumber,
          Twiml: twiml,
        }),
      }
    );
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const status = response.status;
      
      if (status === 401) {
        return { ok: false, message: 'Twilio odmítlo přihlášení – zkontroluj SID a token' };
      }
      if (status === 400) {
        return { ok: false, message: `Twilio vrátilo chybu: ${errorText.slice(0, 200)}` };
      }
      if (status === 429) {
        return { ok: false, message: 'Twilio: příliš mnoho požadavků' };
      }
      return { ok: false, message: `Twilio chyba ${status}` };
    }
    
    const data = await response.json();
    const callSid = data.sid;
    
    if (callSid) {
      recordCall(vip);
      return { ok: true, message: 'Hovor spuštěn', callSid };
    }
    
    return { ok: false, message: 'Twilio nevrátilo Call SID' };
  } catch (error) {
    return { ok: false, message: `Hovor selhal: ${error.message || String(error)}` };
  }
}

/**
 * Vyzkouší připojení k Twilio (testovací hovor)
 */
export async function testCall(config) {
  return placeCall(config, 'Toto je zkušební hovor z aplikace TalkToClaude.', false);
}

/**
 * Escape XML special characters
 */
function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Získat stav omezení hovorů
 */
export function getCallStats() {
  pruneCallHistory();
  const total = callHistory.length;
  const vip = callHistory.filter(c => c.vip).length;
  return { total, vip, remaining: Math.max(0, MAX_CALLS_PER_HOUR - (total - vip)) };
}
