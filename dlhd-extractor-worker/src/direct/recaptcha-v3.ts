/**
 * reCAPTCHA v3 HTTP-only Bypass
 *
 * Ported from rpi-proxy/rust-fetch/src/main.rs (recaptcha_v3 module).
 * Replicates the api2/anchor → api2/reload flow used by PyPasser,
 * go-recaptcha-v3-bypass, and s0ftik3/recaptcha-bypass.
 *
 * No browser, no WASM, no external services — pure HTTP + string parsing.
 * Runs directly in a Cloudflare Worker via fetch().
 */

const RECAPTCHA_SITE_KEY = '6LfJv4AsAAAAALTLEHKaQ7LN_VYfFqhLPrB2Tvgj';
// UPDATED May 27 2026: ksohls.ru DEAD. www.newkso.ru is the new player domain.
const PAGE_URL_TEMPLATE = 'https://www.newkso.ru/premiumtv/daddyhd.php?id=';

/**
 * Extract the reCAPTCHA JS version string from Google's API loader.
 * Looks for `releases/VERSION/` in the script body.
 */
async function getRecaptchaVersion(): Promise<string> {
  const urls = [
    'https://www.google.com/recaptcha/api.js?render=explicit',
    'https://www.google.com/recaptcha/enterprise.js?render=explicit',
  ];

  for (const url of urls) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
          'Referer': 'https://www.newkso.ru/',
        },
      });
      const body = await resp.text();

      const releasesIdx = body.indexOf('releases/');
      if (releasesIdx !== -1) {
        const rest = body.substring(releasesIdx + 9);
        const slashIdx = rest.indexOf('/');
        if (slashIdx > 0 && slashIdx < 60) {
          const version = rest.substring(0, slashIdx);
          console.log(`[reCAPTCHA] version=${version}`);
          return version;
        }
      }
    } catch {
      // try next URL
    }
  }

  throw new Error('could not extract reCAPTCHA version from api.js');
}

/**
 * Extract value from `<input ... id="ID" ... value="VALUE">` in HTML.
 */
function extractInputValue(html: string, id: string): string | null {
  const idPattern = `id="${id}"`;
  const pos = html.indexOf(idPattern);
  if (pos === -1) return null;

  // Find the enclosing <input> tag
  const tagStart = html.lastIndexOf('<', pos);
  const tagEnd = html.indexOf('>', pos);
  if (tagStart === -1 || tagEnd === -1) return null;

  const tag = html.substring(tagStart, tagEnd + 1);

  // Extract value="..."
  const valIdx = tag.indexOf('value="');
  if (valIdx === -1) return null;
  const valStart = valIdx + 7;
  const valEnd = tag.indexOf('"', valStart);
  if (valEnd === -1) return null;

  return tag.substring(valStart, valEnd);
}

/**
 * Extract token from rresp response: )]\}\n["rresp","TOKEN",...]
 */
function extractRresp(body: string): string | null {
  // Try rresp pattern
  const rrespIdx = body.indexOf('["rresp","');
  if (rrespIdx !== -1) {
    const rest = body.substring(rrespIdx + 10);
    const endIdx = rest.indexOf('"');
    if (endIdx > 20) {
      return rest.substring(0, endIdx);
    }
  }

  // Fallback: try uvresp
  const uvrespIdx = body.indexOf('["uvresp","');
  if (uvrespIdx !== -1) {
    const rest = body.substring(uvrespIdx + 11);
    const endIdx = rest.indexOf('"');
    if (endIdx > 20) {
      return rest.substring(0, endIdx);
    }
  }

  return null;
}

/**
 * Solve reCAPTCHA v3 via HTTP-only anchor/reload flow.
 *
 * @param siteKey - reCAPTCHA site key
 * @param pageUrl - The page URL the reCAPTCHA is embedded on
 * @param action  - reCAPTCHA action string (e.g., "verify_premium44")
 * @returns The reCAPTCHA token, or null on failure
 */
export async function solveRecaptchaV3(
  siteKey: string,
  pageUrl: string,
  action: string,
): Promise<string | null> {
  try {
    // 1. Get reCAPTCHA version
    const version = await getRecaptchaVersion();

    // 2. Build co param: base64(origin:port) with trailing dot
    const parsed = new URL(pageUrl);
    const port = parsed.protocol === 'https:' ? 443 : 80;
    const originWithPort = `${parsed.protocol}//${parsed.hostname}:${port}`;
    const coRaw = btoa(originWithPort);
    // reCAPTCHA uses URL-safe base64 with trailing dot, no padding
    const co = coRaw.replace(/=+$/, '') + '.';
    console.log(`[reCAPTCHA] co=${co}`);

    // 3. Random callback name
    const cb = `cb${Math.floor(Math.random() * 999999)}`;

    // 4. GET anchor page
    const anchorUrl = `https://www.google.com/recaptcha/api2/anchor?ar=1&k=${siteKey}&co=${co}&hl=en&v=${version}&size=invisible&cb=${cb}`;
    console.log(`[reCAPTCHA] anchor GET: ${anchorUrl.substring(0, 120)}`);

    const anchorResp = await fetch(anchorUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Referer': pageUrl,
      },
    });
    const anchorHtml = await anchorResp.text();
    console.log(`[reCAPTCHA] anchor HTML: ${anchorHtml.length} bytes`);

    // 5. Parse recaptcha-token from anchor HTML
    const token = extractInputValue(anchorHtml, 'recaptcha-token');
    if (!token || token.length < 20) {
      console.log(`[reCAPTCHA] ❌ no recaptcha-token in anchor page`);
      return null;
    }
    console.log(`[reCAPTCHA] anchor token: ${token.substring(0, 20)}...${token.substring(token.length - 10)}`);

    // 6. POST reload
    const reloadUrl = `https://www.google.com/recaptcha/api2/reload?k=${siteKey}`;

    const formParams = new URLSearchParams({
      v: version,
      reason: 'q',
      c: token,
      k: siteKey,
      co: co,
      hl: 'en',
      size: 'invisible',
      chr: '%5B89%2C64%2C27%5D',
      vh: '13599012192',
      bg: '',
      sa: action,
    });

    console.log(`[reCAPTCHA] reload POST: ${reloadUrl}`);

    const reloadResp = await fetch(reloadUrl, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': anchorUrl,
      },
      body: formParams.toString(),
    });
    const reloadBody = await reloadResp.text();
    console.log(`[reCAPTCHA] reload response: ${reloadBody.length} bytes`);

    // 7. Parse rresp token from reload response
    const finalToken = extractRresp(reloadBody);
    if (!finalToken) {
      console.log(`[reCAPTCHA] ❌ no rresp in reload response`);
      console.log(`[reCAPTCHA] response preview: ${reloadBody.substring(0, 200)}`);
      return null;
    }

    console.log(`[reCAPTCHA] ✅ got token: ${finalToken.substring(0, 20)}...${finalToken.substring(finalToken.length - 10)} (${finalToken.length}b)`);
    return finalToken;
  } catch (e) {
    console.log(`[reCAPTCHA] ❌ error: ${e}`);
    return null;
  }
}

/**
 * Convenience: solve reCAPTCHA for a DLHD channel.
 * Uses the known site key and page URL template.
 */
export async function solveDLHDRecaptcha(channelId: string): Promise<string | null> {
  const channelNum = channelId.replace('premium', '');
  const pageUrl = `${PAGE_URL_TEMPLATE}${channelNum}`;
  const action = `verify_${channelId.startsWith('premium') ? channelId : 'premium' + channelId}`;
  return solveRecaptchaV3(RECAPTCHA_SITE_KEY, pageUrl, action);
}
