/**
 * Flyx Bypass v3 — HTTP-Only reCAPTCHA v3 Solver
 *
 * Solves reCAPTCHA v3 without loading any Google scripts in the browser.
 * Used by the extension SW for DLHD IP whitelisting.
 *
 * Flow:
 *   1. GET recaptcha/api.js → extract version
 *   2. GET recaptcha/api2/anchor → extract recaptcha-token
 *   3. POST recaptcha/api2/reload → get rresp token
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const SITE_KEY = '6LfJv4AsAAAAALTLEHKaQ7LN_VYfFqhLPrB2Tvgj';

async function getVersion() {
  var resp = await fetch('https://www.google.com/recaptcha/api.js?render=explicit', {
    headers: { 'User-Agent': UA, 'Referer': 'https://www.newkso.ru/' }
  });
  if (!resp.ok) throw new Error('reCAPTCHA API fetch failed: ' + resp.status);
  var body = await resp.text();
  var idx = body.indexOf('releases/');
  if (idx !== -1) {
    var rest = body.substring(idx + 9);
    var end = rest.search(/[/"']/);
    if (end > 0) return rest.substring(0, end);
  }
  throw new Error('Cannot extract reCAPTCHA version');
}

export async function solveRecaptchaV3(pageUrl, action) {
  action = action || 'player_access';
  var version = await getVersion();

  // Build co parameter
  var origin = new URL(pageUrl).origin;
  var co;
  try {
    co = btoa(unescape(encodeURIComponent(origin))).replace(/=+$/, '') + '.';
  } catch (e) {
    var bytes = new TextEncoder().encode(origin);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    co = btoa(bin).replace(/=+$/, '') + '.';
  }

  // Fetch anchor page
  var cb = 'cb_' + Date.now();
  var anchorUrl = 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=' + SITE_KEY +
    '&co=' + co + '&hl=en&v=' + version + '&size=invisible&cb=' + cb;

  var anchorResp = await fetch(anchorUrl, {
    headers: { 'User-Agent': UA, 'Referer': pageUrl }
  });
  if (!anchorResp.ok) throw new Error('Anchor fetch failed: ' + anchorResp.status);

  var html = await anchorResp.text();
  var m = html.match(/id="recaptcha-token"\s+value="([^"]+)"/);
  if (!m) throw new Error('No recaptcha-token in anchor');

  // POST reload
  var body = new URLSearchParams();
  body.append('v', version);
  body.append('reason', 'q');
  body.append('k', SITE_KEY);
  body.append('c', m[1]);
  body.append('sa', action);
  body.append('co', co);

  var reloadResp = await fetch('https://www.google.com/recaptcha/api2/reload?k=' + SITE_KEY, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Referer': anchorUrl,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });
  if (!reloadResp.ok) throw new Error('Reload failed: ' + reloadResp.status);

  var reloadBody = await reloadResp.text();
  var rm = reloadBody.match(/\["rresp","([^"]+)"/);
  if (rm) return rm[1];
  var am = reloadBody.match(/"rresp","([^"]+)"/);
  if (am) return am[1];
  throw new Error('No rresp in reload response');
}

export async function verifyToken(channel, token, verifyUrl) {
  var body = new URLSearchParams();
  body.append('recaptcha-token', token);
  body.append('channel_id', channel);
  var resp = await fetch(verifyUrl, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Origin': 'https://www.newkso.ru',
      'Referer': 'https://www.newkso.ru/',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });
  return resp.ok ? { success: true } : { success: false, error: 'Verify returned ' + resp.status };
}

export default solveRecaptchaV3;
