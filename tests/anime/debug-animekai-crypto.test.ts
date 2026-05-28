/**
 * Quick debug v2: test AnimeKai with new HTML-in-JSON search format
 * Run: bun test tests/anime/debug-animekai-crypto.test.ts --timeout 120000
 */

import { describe, test, expect } from 'bun:test';

const KAI_BASE = 'https://animekai.to';
const AJAX_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': `${KAI_BASE}/`,
  'X-Requested-With': 'XMLHttpRequest',
};

const PAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

describe('Debug AnimeKai v2', () => {
  test('trace full pipeline with new API format', async () => {
    const { encryptAnimeKai, decryptAnimeKai } = await import('@/app/lib/animekai-crypto');

    // Step 1: Search - now returns HTML inside JSON
    const searchUrl = `${KAI_BASE}/ajax/anime/search?keyword=${encodeURIComponent('One Punch Man')}`;
    console.log('[1] Searching...');
    const searchRes = await fetch(searchUrl, { headers: AJAX_HEADERS, signal: AbortSignal.timeout(15000) });
    const searchData = await searchRes.json();

    // New format: { status: "ok", result: { html: "..." } }
    const html = searchData?.result?.html || '';
    console.log('[1] Search HTML length:', html.length);

    // Parse result URLs from HTML
    const linkMatches = [...html.matchAll(/<a\s+class="aitem"\s+href="([^"]+)"/g)];
    console.log('[1] Found', linkMatches.length, 'results');

    if (linkMatches.length === 0) {
      console.log('[1] No results found');
      return;
    }

    const resultUrls = linkMatches.map(m => m[1]);
    console.log('[1] URLs:', resultUrls.slice(0, 4));

    // Step 2: Fetch watch pages to find MAL match
    let contentId = '';
    for (const url of resultUrls.slice(0, 4)) {
      const watchUrl = `${KAI_BASE}${url}`;
      console.log('[2] Fetching:', watchUrl);
      try {
        const res = await fetch(watchUrl, {
          headers: {
            ...PAGE_HEADERS,
            'Referer': `${KAI_BASE}/`,
            'Origin': KAI_BASE,
          },
          signal: AbortSignal.timeout(10000),
        });
        console.log('[2] Status:', res.status, 'Content-Type:', res.headers.get('content-type'));
        if (!res.ok) {
          const errText = await res.text();
          console.log('[2] Error body (first 500):', errText.substring(0, 500));
          continue;
        }
        const pageHtml = await res.text();
        console.log('[2] HTML length:', pageHtml.length);

        // New format: <script id="syncData" type="application/json">{...}</script>
        const syncMatch = pageHtml.match(/<script\s+id="syncData"[^>]*>([^<]+)<\/script>/);
        if (syncMatch) {
          try {
            const sync = JSON.parse(syncMatch[1]);
            console.log('[2] syncData:', JSON.stringify(sync));
            if (sync.mal_id === '30276' || sync.mal_id === 30276) {
              // NEW: field is "anime_id" not "content_id"
              contentId = sync.anime_id || '';
              console.log('[2] MATCH! anime_id:', contentId);
              break;
            }
          } catch { console.log('[2] Failed to parse syncData JSON'); }
        }

        // Also grep for key terms
        for (const term of ['syncData', 'anime_id', 'mal_id']) {
          const idx = pageHtml.indexOf(term);
          if (idx >= 0) {
            console.log(`[2] Found "${term}" at position ${idx}:`, pageHtml.substring(idx, idx + 200));
          }
        }

        break; // Just test first result for now
      } catch (e) {
        console.log('[2] Error:', (e as Error).message);
      }
    }

    if (!contentId) {
      console.log('[2] Could not find content_id for MAL 30276');
      return;
    }

    // Step 3: Get episodes
    const encContentId = encryptAnimeKai(contentId);
    console.log('[3] Encrypted content_id:', encContentId);

    const epUrl = `${KAI_BASE}/ajax/episodes/list?ani_id=${contentId}&_=${encodeURIComponent(encContentId!)}`;
    console.log('[3] Fetching episodes...');
    const epRes = await fetch(epUrl, { headers: AJAX_HEADERS, signal: AbortSignal.timeout(15000) });
    const epRaw = await epRes.text();
    console.log('[3] Episodes raw length:', epRaw.length);
    console.log('[3] First 500 chars:', epRaw.substring(0, 500));

    // New format: {"status":"ok","result":"<html>..."}
    let epHtml: string;
    try {
      const epJson = JSON.parse(epRaw);
      epHtml = epJson?.result || epJson?.html || '';
      console.log('[3] Extracted HTML from JSON, length:', epHtml.length);
    } catch {
      epHtml = epRaw;
      console.log('[3] Using raw response as HTML');
    }

    // Show HTML content
    console.log('[3] HTML first 500:', epHtml.substring(0, 500));

    // Search for all patterns related to episodes
    for (const term of ['data-token', 'data-ep', 'num="1"', 'token="', 'data-num']) {
      const idx = epHtml.indexOf(term);
      if (idx >= 0) {
        console.log(`[3] Found "${term}" at ${idx}:`, epHtml.substring(idx, idx + 200));
      } else {
        console.log(`[3] "${term}" NOT FOUND`);
      }
    }

    // Try multiple token extraction patterns
    let epToken = '';
    const patterns = [
      /data-token\s*=\s*"([^"]+)"[^>]*data-ep\s*=\s*"1"/,
      /data-token\s*=\s*"([^"]+)"[^>]*data-ep\s*=\s*"1"/g,
      /token\s*=\s*"([^"]+)"[^>]*num\s*=\s*"1"/,
      /num\s*=\s*"1"[^>]*token\s*=\s*"([^"]+)"/,
      /data-token\s*=\s*"([^"]+)"/,
    ];

    for (const p of patterns) {
      const m = p.global ? [...epHtml.matchAll(p)] : [epHtml.match(p)].filter(Boolean);
      if (m.length > 0) {
        console.log(`[3] Pattern "${p.source.substring(0, 50)}":`, m.slice(0, 3).map(x => x[1]));
        if (!epToken && m[0][1]) epToken = m[0][1];
      }
    }

    if (!epToken) {
      console.log('[3] Could not find episode token');
      return;
    }

    console.log('[3] Episode 1 token:', epToken);

    // Step 4: Get servers
    const encToken = encryptAnimeKai(epToken);
    console.log('[4] Encrypted token:', encToken);

    const serversUrl = `${KAI_BASE}/ajax/links/list?token=${epToken}&_=${encodeURIComponent(encToken!)}`;
    console.log('[4] Fetching servers...');
    const serversRes = await fetch(serversUrl, { headers: AJAX_HEADERS, signal: AbortSignal.timeout(15000) });
    const serversRaw = await serversRes.text();
    console.log('[4] Servers raw length:', serversRaw.length);
    console.log('[4] First 1000 chars:', serversRaw.substring(0, 1000));

    // Extract HTML from JSON
    let serversHtml: string;
    try {
      const serversJson = JSON.parse(serversRaw);
      serversHtml = serversJson?.result || serversJson?.html || '';
      console.log('[4] Extracted HTML from JSON, length:', serversHtml.length);
    } catch {
      serversHtml = serversRaw;
    }

    // Show full servers HTML for debugging
    console.log('[4] Full servers HTML:');
    console.log(serversHtml);
    console.log('[4] --- END ---');

    // Search for lid patterns
    for (const term of ['data-lid', 'data-id', 'data-link', 'data-url', 'data-srv', 'lid', 'server']) {
      const idx = serversHtml.indexOf(term);
      if (idx >= 0) {
        console.log(`[4] Found "${term}" at ${idx}:`, serversHtml.substring(Math.max(0, idx - 20), idx + 150));
      } else {
        console.log(`[4] "${term}" NOT FOUND`);
      }
    }

    // Try multiple lid patterns
    const lidPatterns = [
      /data-lid\s*=\s*"([^"]+)"/g,
      /data-id\s*=\s*"([^"]+)"/g,
      /data-link\s*=\s*"([^"]+)"/g,
      /lid\s*=\s*"([^"]+)"/g,
      /data-srv\s*=\s*"([^"]+)"/g,
      /href="[^"]*\?[^"]*lid=([^"&]+)/g,
    ];

    let firstLid = '';
    for (const p of lidPatterns) {
      const matches = [...serversHtml.matchAll(p)];
      if (matches.length > 0) {
        console.log(`[4] Pattern "${p.source.substring(0, 50)}":`, matches.slice(0, 4).map(m => m[1]));
        if (!firstLid) firstLid = matches[0][1];
      }
    }

    if (!firstLid) {
      console.log('[4] No LIDs found with any pattern');
      return;
    }

    console.log('[4] First LID:', firstLid);
    const encLid = encryptAnimeKai(firstLid);
    console.log('[5] LID:', firstLid);
    console.log('[5] Encrypted LID:', encLid);

    const embedUrl = `${KAI_BASE}/ajax/links/view?id=${firstLid}&_=${encodeURIComponent(encLid!)}`;
    console.log('[5] Fetching embed...');
    const embedRes = await fetch(embedUrl, { headers: AJAX_HEADERS, signal: AbortSignal.timeout(15000) });
    const embedData = await embedRes.json();
    console.log('[5] Embed keys:', Object.keys(embedData));

    // The encrypted embed might be in embedData.result or embedData.html
    const encryptedEmbed = embedData.result || embedData.html || embedData.data || '';
    console.log('[5] Full encrypted embed:');
    console.log(encryptedEmbed);

    if (!encryptedEmbed) {
      console.log('[5] No encrypted embed - full response:', JSON.stringify(embedData).substring(0, 500));
      return;
    }

    // Step 6: Decrypt
    let decrypted = decryptAnimeKai(encryptedEmbed);
    console.log('[6] Decrypted length:', decrypted.length);
    console.log('[6] Full decrypted:');
    console.log(decrypted);
    console.log('[6] Last 30 chars:', decrypted.substring(decrypted.length - 30));
    console.log('[6] Char codes last 10:', [...decrypted.substring(decrypted.length - 10)].map(c => c.charCodeAt(0)));

    // Apply }XX decoding
    const beforeDecode = decrypted;
    decrypted = decrypted.replace(/}([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (beforeDecode !== decrypted) {
      console.log('[6] }XX decoding changed:');
      console.log('  Before:', beforeDecode);
      console.log('  After:', decrypted);
    }

    // Fix: trim garbage after valid JSON
    // Step 1: Only process valid }XX sequences (scan until we hit non-}XX)
    let cleanDecoded = '';
    let pos = 0;
    while (pos < beforeDecode.length) {
      if (beforeDecode[pos] === '}' && pos + 2 < beforeDecode.length) {
        const hex1 = beforeDecode[pos + 1];
        const hex2 = beforeDecode[pos + 2];
        if (/[0-9A-Fa-f]/.test(hex1) && /[0-9A-Fa-f]/.test(hex2)) {
          cleanDecoded += String.fromCharCode(parseInt(hex1 + hex2, 16));
          pos += 3;
          continue;
        }
      }
      // Not a valid }XX sequence - check if it's a valid JSON char
      const ch = beforeDecode[pos];
      if (ch === '{' || ch === '}' || ch === '[' || ch === ']' ||
          ch === ':' || ch === ',' || ch === '"' || ch === '\\' ||
          ch === '/' || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
          (ch >= '0' && ch <= '9') || ch === '.' || ch === '-' || ch === '_' ||
          ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
        cleanDecoded += ch;
        pos++;
      } else {
        // Hit garbage - stop processing }XX
        console.log('[6] Hit garbage at position', pos, 'char:', beforeDecode.charCodeAt(pos), 'after decoding', cleanDecoded.length, 'chars');
        // Stop processing }XX but continue scanning for plain chars
        break;
      }
    }

    // Step 2: Now find where valid JSON ends in cleanDecoded
    // The JSON uses escaped slashes (\/) which are valid
    // Close any unclosed brackets

    // Count braces/brackets to find where JSON actually ends
    let braceStack = 0;
    let bracketStack = 0;
    let inString = false;
    let escape = false;
    let jsonEnd = 0;

    for (let i = 0; i < cleanDecoded.length; i++) {
      const c = cleanDecoded[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{') braceStack++;
      if (c === '}') braceStack--;
      if (c === '[') bracketStack++;
      if (c === ']') bracketStack--;
      if (braceStack === 0 && bracketStack === 0 && i > 0) {
        jsonEnd = i + 1;
      }
    }

    console.log('[6] jsonEnd:', jsonEnd, '/', cleanDecoded.length, 'braceStack:', braceStack, 'bracketStack:', bracketStack);

    // If braces are unclosed, close them
    let finalJson = cleanDecoded.substring(0, jsonEnd || cleanDecoded.length);
    while (braceStack > 0) { finalJson += '}'; braceStack--; }
    while (bracketStack > 0) { finalJson += ']'; bracketStack--; }

    if (finalJson !== cleanDecoded) {
      console.log('[6] Fixed JSON: was', cleanDecoded.length, '→ now', finalJson.length);
    }

    // Parse
    try {
      const parsed = JSON.parse(finalJson);
      console.log('[6] Parsed OK! Keys:', Object.keys(parsed));
      console.log('[6] URL:', parsed.url);
      if (parsed.skip) console.log('[6] Skip:', JSON.stringify(parsed.skip));

      // Step 7: Follow the iframe URL
      if (parsed.url?.includes('animekai.to/iframe')) {
        console.log('[7] Fetching iframe:', parsed.url);
        const iframeRes = await fetch(parsed.url, {
          headers: { ...PAGE_HEADERS, Referer: `${KAI_BASE}/` },
          signal: AbortSignal.timeout(15000),
        });

        if (iframeRes.ok) {
          const iframeHtml = await iframeRes.text();
          console.log('[7] Iframe HTML length:', iframeHtml.length);
          console.log('[7] Full Iframe HTML:');
          console.log(iframeHtml);
          console.log('[7] --- END ---');

          // Look for key terms
          for (const term of ['megaup', 'm3u8', 'mp4', 'iframe', 'src=', 'video', 'source', 'embed', 'script', 'jwplayer', 'player']) {
            const idx = iframeHtml.indexOf(term);
            if (idx >= 0) {
              console.log(`[7] "${term}" at ${idx}:`, iframeHtml.substring(Math.max(0, idx - 50), idx + 200));
            }
          }
        } else {
          console.log('[7] Iframe failed:', iframeRes.status);
        }
      }
    } catch (e) {
      console.log('[6] Parse FAILED:', (e as Error).message);
      console.log('[6] Final JSON:', finalJson.substring(0, 200));
    }
  }, 120000);
});
