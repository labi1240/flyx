/**
 * CDN-Live Client-Side Token Extractor
 *
 * Fetches the cdn-live.tv player page directly from the browser (residential IP,
 * no CF-to-CF block), decodes the HUNTER obfuscation, and returns the M3U8 URL.
 *
 * The M3U8 URL points to edge.cdn-live.ru which is NOT behind Cloudflare,
 * so the cdn-live-extractor worker can proxy it without issues.
 */

const CDN_LIVE_WORKER = process.env.NEXT_PUBLIC_CDN_LIVE_WORKER_URL
  || process.env.CDN_LIVE_WORKER_URL
  || 'https://cdn-live-extractor.vynx-3b3.workers.dev';

// ── HUNTER decoder ──────────────────────────────────────────

function decodeHunter(
  encodedData: string,
  charset: string,
  base: number,
  offset: number,
): string {
  let result = '';
  let i = 0;
  const delimiter = charset[base];
  while (i < encodedData.length) {
    let s = '';
    while (i < encodedData.length && encodedData[i] !== delimiter) {
      s += encodedData[i];
      i++;
    }
    i++;
    if (!s) continue;
    let numStr = '';
    for (const c of s) {
      const idx = charset.indexOf(c);
      if (idx !== -1) numStr += idx.toString();
    }
    const charCode = parseInt(numStr, base) - offset;
    if (charCode > 0 && charCode < 65536) result += String.fromCharCode(charCode);
  }
  return result;
}

// ── Extract HUNTER params from HTML ─────────────────────────

function getHunterParams(html: string) {
  const evalIdx = html.indexOf('eval(function(h,u,n,t,e,r)');
  if (evalIdx === -1) return null;
  const evalBlock = html.substring(evalIdx);

  let pd = 0;
  let ee = -1;
  for (let i = 0; i < evalBlock.length && i < 200_000; i++) {
    if (evalBlock[i] === '(') pd++;
    if (evalBlock[i] === ')') {
      pd--;
      if (pd === 0) { ee = i; break; }
    }
  }
  if (ee === -1) return null;

  const tail = evalBlock.substring(Math.max(0, ee - 200), ee + 5);
  const pm = tail.match(/",(\d+),"(\w+)",(\d+),(\d+),(\d+)\)\)/);
  if (!pm) return null;

  const fullEval = evalBlock.substring(0, ee + 1);
  const dsi = fullEval.lastIndexOf('}("');
  if (dsi === -1) return null;
  const afterMarker = fullEval.substring(dsi + 3);
  const dei = afterMarker.indexOf('",');
  if (dei === -1) return null;

  return {
    encodedData: afterMarker.substring(0, dei),
    charset: pm[2],
    offset: parseInt(pm[3]),
    base: parseInt(pm[4]),
  };
}

// ── Extract URLs from decoded script ────────────────────────

function extractUrlsFromDecoded(decoded: string): string[] {
  const fnMatch = decoded.match(/function\s+(\w+)\s*\(\s*str\s*\)/);
  if (!fnMatch) return [];
  const fn = fnMatch[1];

  const b64Vars: Record<string, string> = {};
  let m: RegExpExecArray | null;
  const bp = /const\s+(\w+)\s*=\s*'([A-Za-z0-9+/_-]+={0,2})'/g;
  while ((m = bp.exec(decoded)) !== null) b64Vars[m[1]] = m[2];

  const cp = new RegExp(
    'const\\s+\\w+\\s*=\\s*(' +
      fn + '\\s*\\(\\s*\\w+\\s*\\)(?:\\s*\\+\\s*' + fn + '\\s*\\(\\s*\\w+\\s*\\))*)',
    'g',
  );
  const urls: string[] = [];
  while ((m = cp.exec(decoded)) !== null) {
    const rp = new RegExp(fn + '\\s*\\(\\s*(\\w+)\\s*\\)', 'g');
    let rm: RegExpExecArray | null;
    let url = '';
    while ((rm = rp.exec(m[1])) !== null) {
      if (b64Vars[rm[1]]) {
        let b64 = b64Vars[rm[1]].replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        try { url += atob(b64); } catch { /* skip */ }
      }
    }
    if (url) urls.push(url);
  }
  return urls;
}

// ── Public API ──────────────────────────────────────────────

export interface CDNLiveStreamResult {
  success: boolean;
  /** Worker-proxied M3U8 URL ready for HLS.js */
  streamUrl?: string;
  /** Raw M3U8 URL on edge.cdn-live.ru (not proxied) */
  rawM3u8Url?: string;
  error?: string;
}

/**
 * Extract a playable CDN-Live stream URL.
 *
 * 1. Browser fetches cdn-live.tv player page (residential IP — no block)
 * 2. Decode HUNTER obfuscation → get tokenised M3U8 URL on edge.cdn-live.ru
 * 3. Return worker /proxy URL so HLS.js segments go through the worker
 */
export async function extractCDNLiveStream(
  channelName: string,
  countryCode = 'us',
): Promise<CDNLiveStreamResult> {
  try {
    const name = channelName.replace(/\s+/g, '+').toLowerCase();
    const playerUrl =
      `https://cdn-live.tv/api/v1/channels/player/?name=${encodeURIComponent(name)}&code=${countryCode}&user=cdnlivetv&plan=free`;

    console.log('[CDNLive] Fetching player page:', playerUrl);
    const res = await fetch(playerUrl);
    if (!res.ok) {
      return { success: false, error: `Player page HTTP ${res.status}` };
    }

    const html = await res.text();
    const params = getHunterParams(html);
    if (!params) {
      return { success: false, error: 'No HUNTER obfuscation found in player page' };
    }

    const decoded = decodeHunter(params.encodedData, params.charset, params.base, params.offset);
    if (!decoded || decoded.length < 50) {
      return { success: false, error: 'HUNTER decode failed' };
    }

    const urls = extractUrlsFromDecoded(decoded);
    const rawM3u8Url = urls.find(u => u.includes('token=')) || urls[0];

    if (!rawM3u8Url) {
      // Fallback regex
      const m = decoded.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
      if (!m) return { success: false, error: 'No M3U8 URL found in decoded script' };
      const workerProxy = `${CDN_LIVE_WORKER}/proxy?url=${encodeURIComponent(m[0])}`;
      return { success: true, streamUrl: workerProxy, rawM3u8Url: m[0] };
    }

    // Wrap through the worker /proxy so segments also get proxied with correct headers
    const streamUrl = `${CDN_LIVE_WORKER}/proxy?url=${encodeURIComponent(rawM3u8Url)}`;
    return { success: true, streamUrl, rawM3u8Url };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Extraction failed',
    };
  }
}
