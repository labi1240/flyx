/**
 * MegaUp Decryption Reverse Engineering Script
 *
 * Goes through the full AnimeKai extraction flow to get a real MegaUp
 * encrypted payload, then analyzes it to determine the decryption algorithm.
 *
 * Usage: node test_megaup_re.js
 */

// Use Node.js built-in fetch (Node 18+)
const KAI_DOMAINS = ['https://animekai.to', 'https://anikai.to'];

// Browser-compatible AnimeKai crypto (copied from animekai-crypto.ts)
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function urlSafeBase64Decode(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const binaryStr = atob(padded);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}

function urlSafeBase64Encode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

const HEADER = hexToBytes('c509bdb497cbc06873ff412af12fd8007624c29faa');
const HEADER_LEN = 21;

const CONSTANT_BYTES = {
  1: 0xf2, 2: 0xdf, 3: 0x9b, 4: 0x9d, 5: 0x16, 6: 0xe5,
  8: 0x67, 9: 0xc9, 10: 0xdd, 12: 0x9c, 14: 0x29, 16: 0x35, 18: 0xc8,
};

function getCipherPosition(plainPos) {
  if (plainPos === 0) return 0;
  if (plainPos === 1) return 7;
  if (plainPos === 2) return 11;
  if (plainPos === 3) return 13;
  if (plainPos === 4) return 15;
  if (plainPos === 5) return 17;
  if (plainPos === 6) return 19;
  return 20 + (plainPos - 7);
}

// Need the encryption tables - import from the compiled module
// For now let's just import from the TS file using dynamic import
async function main() {
  // Dynamic import the crypto module
  const { encryptAnimeKai, decryptAnimeKai } = await import('./app/lib/animekai-crypto.ts');

  function encrypt(text) {
    try { return encryptAnimeKai(text); } catch (e) { return null; }
  }

  function decrypt(text) {
    try { return decryptAnimeKai(text); } catch (e) { return null; }
  }

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
  const AJAX_HEADERS = {
    'User-Agent': UA,
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': 'https://animekai.to/',
    'Origin': 'https://animekai.to',
  };

  const PAGE_HEADERS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Referer': 'https://animekai.to/',
  };

  async function fetchKai(url) {
    for (const domain of KAI_DOMAINS) {
      try {
        const resolved = url.startsWith('http')
          ? (domain === KAI_DOMAINS[0] ? url : url.replace(KAI_DOMAINS[0], domain))
          : `${domain}${url}`;
        const res = await fetch(resolved, { headers: url.includes('/watch/') ? PAGE_HEADERS : AJAX_HEADERS });
        if (res.ok) return res;
      } catch (e) { /* try next */ }
    }
    return null;
  }

  // Step 1: Search for an anime
  console.log('[Test] Searching for Cyberpunk Edgerunners...');
  const searchRes = await fetchKai('/ajax/anime/search?keyword=cyberpunk%20edgerunners');
  if (!searchRes) { console.log('Search failed'); return; }
  const searchJson = await searchRes.json();
  const html = searchJson.result?.html || '';
  const slugMatch = html.match(/href="\/watch\/([^"]+)"/);
  if (!slugMatch) { console.log('No results'); return; }
  const slug = slugMatch[1];
  console.log(`[Test] Found: ${slug}`);

  // Step 2: Get anime_id from syncData
  const watchRes = await fetchKai(`/watch/${slug}`);
  if (!watchRes) { console.log('Watch page failed'); return; }
  const watchHtml = await watchRes.text();
  const syncMatch = watchHtml.match(/<script[^>]*id="syncData"[^>]*>([\s\S]*?)<\/script>/);
  if (!syncMatch) { console.log('No syncData'); return; }
  const syncData = JSON.parse(syncMatch[1]);
  const contentId = syncData.anime_id;
  console.log(`[Test] content_id=${contentId} mal_id=${syncData.mal_id}`);

  // Step 3: Get episodes
  const encId = encrypt(contentId);
  if (!encId) { console.log('encrypt failed'); return; }
  const epRes = await fetchKai(`/ajax/episodes/list?ani_id=${contentId}&_=${encId}`);
  if (!epRes) { console.log('Episodes failed'); return; }
  const epJson = await epRes.json();
  const epHtml = epJson.result;
  // Parse episode token
  const tokenMatch = epHtml.match(/num="1"[^>]*token="([^"]+)"/);
  if (!tokenMatch) { console.log('No episode 1 token'); return; }
  const token = tokenMatch[1];
  console.log(`[Test] Episode 1 token: ${token.substring(0, 20)}...`);

  // Step 4: Get servers
  const encToken = encrypt(token);
  if (!encToken) { console.log('encrypt token failed'); return; }
  const srvRes = await fetchKai(`/ajax/links/list?token=${token}&_=${encToken}`);
  if (!srvRes) { console.log('Servers failed'); return; }
  const srvJson = await srvRes.json();
  const srvHtml = srvJson.result;

  // Parse first sub server lid
  const lidMatch = srvHtml.match(/data-lid="([^"]+)"/);
  if (!lidMatch) { console.log('No server lid'); return; }
  const lid = lidMatch[1];
  console.log(`[Test] Server lid: ${lid.substring(0, 20)}...`);

  // Step 5: Get encrypted embed
  const encLid = encrypt(lid);
  if (!encLid) { console.log('encrypt lid failed'); return; }
  const embedRes = await fetchKai(`/ajax/links/view?id=${lid}&_=${encLid}`);
  if (!embedRes) { console.log('Embed failed'); return; }
  const embedJson = await embedRes.json();
  const encryptedEmbed = embedJson.result;
  console.log(`[Test] Encrypted embed (${encryptedEmbed.length} chars): ${encryptedEmbed.substring(0, 50)}...`);

  // Step 6: Decrypt embed natively
  let decrypted = decrypt(encryptedEmbed);
  if (!decrypted) { console.log('Decrypt embed failed'); return; }
  // Decode }XX format
  decrypted = decrypted.replace(/}([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  console.log(`[Test] Decrypted embed: ${decrypted.substring(0, 200)}`);

  let embedData;
  try {
    embedData = JSON.parse(decrypted);
  } catch {
    if (decrypted.startsWith('http')) {
      embedData = { url: decrypted };
    } else {
      console.log('Parse failed');
      return;
    }
  }

  const embedUrl = embedData.url || embedData.sources?.[0]?.url || embedData.file;
  if (!embedUrl) { console.log('No embed URL'); return; }
  console.log(`[Test] Embed URL: ${embedUrl}`);

  // Step 7: Check if MegaUp embed
  if (!embedUrl.includes('/e/')) {
    console.log('[Test] Not a MegaUp/RapidShare embed, no /media/ needed');
    return;
  }

  // Extract video ID
  const mediaMatch = embedUrl.match(/https?:\/\/([^\/]+)\/e\/([^\/\?]+)/);
  if (!mediaMatch) { console.log('Invalid embed URL format'); return; }
  const [, megaHost, videoId] = mediaMatch;
  const mediaUrl = `https://${megaHost}/media/${videoId}`;
  console.log(`[Test] MegaUp host: ${megaHost}`);
  console.log(`[Test] Video ID: ${videoId}`);
  console.log(`[Test] Media URL: ${mediaUrl}`);

  // Step 8: Fetch /media/ endpoint
  // MegaUp BLOCKS Referer/Origin headers
  const mediaHeaders = {
    'User-Agent': UA,
    'Accept': 'application/json',
  };
  console.log(`[Test] Fetching /media/ with UA: ${UA.substring(0, 50)}...`);

  let mediaRes;
  try {
    mediaRes = await fetch(mediaUrl, { headers: mediaHeaders });
    console.log(`[Test] /media/ response: ${mediaRes.status}`);
  } catch (e) {
    console.log(`[Test] /media/ fetch error: ${e.message}`);
    return;
  }

  if (!mediaRes.ok) {
    console.log(`[Test] /media/ failed: ${mediaRes.status}`);
    const errText = await mediaRes.text();
    console.log(`[Test] Error body: ${errText.substring(0, 300)}`);
    return;
  }

  const mediaJson = await mediaRes.json();
  console.log(`[Test] /media/ status: ${mediaJson.status}`);

  if (mediaJson.status !== 200 || !mediaJson.result) {
    console.log('[Test] No encrypted data in /media/ response');
    console.log(JSON.stringify(mediaJson).substring(0, 300));
    return;
  }

  const encryptedPayload = mediaJson.result;
  console.log(`\n[Test] ===== ENCRYPTED MEGAUPLOAD PAYLOAD =====`);
  console.log(`[Test] Length: ${encryptedPayload.length} chars`);
  console.log(`[Test] First 100: ${encryptedPayload.substring(0, 100)}`);
  console.log(`[Test] Last 100: ${encryptedPayload.substring(encryptedPayload.length - 100)}`);

  // Decode base64 to analyze raw bytes
  const rawBytes = urlSafeBase64Decode(encryptedPayload);
  console.log(`\n[Test] Raw bytes: ${rawBytes.length}`);
  console.log(`[Test] First 30 hex: ${Array.from(rawBytes.slice(0, 30)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);

  // Entropy analysis
  const freq = new Array(256).fill(0);
  for (const b of rawBytes) freq[b]++;
  const nonZero = freq.filter(f => f > 0).length;
  console.log(`[Test] Unique byte values: ${nonZero}/256`);

  // Check if it looks like XOR-encrypted JSON
  // JSON starts with {, ", or whitespace
  // If the first byte decrypted should be '{' (0x7b), then keystream[0] = ciphertext[0] XOR 0x7b
  const firstByte = rawBytes[0];
  const keyStream0 = firstByte ^ 0x7b; // '{' = 0x7b
  console.log(`\n[Test] If plaintext[0] = '{' (0x7b): keystream[0] = 0x${keyStream0.toString(16)}`);

  // Try XOR with keystream derived from user agent
  // Simple hash: sum of char codes
  let uaSum = 0;
  for (let i = 0; i < UA.length; i++) uaSum += UA.charCodeAt(i);
  console.log(`[Test] UA sum: ${uaSum}, UA length: ${UA.length}`);

  // Try: keystream = repeated hash of UA
  // Let's try various hash functions
  console.log(`\n[Test] === Trying various keystream derivations ===`);

  // Attempt 1: Simple PRNG seeded with UA hash
  function tryDecrypt(seedFn, name) {
    const seed = seedFn(UA);
    // Simple LCG
    let state = seed;
    const lcg = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state & 0xff;
    };

    // Try simple XOR
    const decrypted = new Uint8Array(rawBytes.length);
    for (let i = 0; i < rawBytes.length; i++) {
      decrypted[i] = rawBytes[i] ^ lcg();
    }

    const text = new TextDecoder().decode(decrypted);
    const looksLikeJson = text.startsWith('{') || text.startsWith('[') || text.includes('sources');

    if (looksLikeJson) {
      console.log(`[Test] *** ${name}: LOOKS VALID! First 200 chars:`);
      console.log(text.substring(0, 200));
      return true;
    } else {
      console.log(`[Test] ${name}: invalid (starts with: ${text.substring(0, 30).replace(/[^ -~]/g, '.')})`);
      return false;
    }
  }

  // Different seed functions
  const seedFns = {
    'djb2': (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h >>> 0; },
    'sdbm': (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + (h << 6) + (h << 16) - h; return h >>> 0; },
    'loseLose': (s) => { let h = 0; for (let i = 0; i < s.length; i++) h += s.charCodeAt(i); return h >>> 0; },
    'fnv1a': (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) | 0; } return h >>> 0; },
  };

  for (const [name, fn] of Object.entries(seedFns)) {
    if (tryDecrypt(fn, name)) break;
  }

  // Also try: the key might be the video ID, not the UA
  console.log(`\n[Test] === Trying videoId as seed ===`);
  for (const [name, fn] of Object.entries(seedFns)) {
    if (tryDecrypt((s) => fn(videoId), `videoId-${name}`)) break;
  }

  // Try: combined UA + videoId
  console.log(`\n[Test] === Trying UA+videoId as seed ===`);
  for (const [name, fn] of Object.entries(seedFns)) {
    if (tryDecrypt((s) => fn(UA + '|' + videoId), `combined-${name}`)) break;
  }

  // Try plaintext feedback: keystream[i] = PRNG(seed XOR plaintext[i-1])
  console.log(`\n[Test] === Trying plaintext feedback cipher ===`);
  function tryFeedbackDecrypt(seedFn, name) {
    const seed = seedFn(UA);
    let state = seed;
    const lcg = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state & 0xff;
    };

    const decrypted = new Uint8Array(rawBytes.length);
    let prevPlain = 0;
    for (let i = 0; i < rawBytes.length; i++) {
      // Mix previous plaintext into state
      state = (state ^ (prevPlain << 8)) >>> 0;
      const ks = lcg();
      decrypted[i] = rawBytes[i] ^ ks;
      prevPlain = decrypted[i];
    }

    const text = new TextDecoder().decode(decrypted);
    const looksLikeJson = text.startsWith('{') || text.startsWith('[');

    if (looksLikeJson) {
      console.log(`[Test] *** ${name}: LOOKS VALID! First 200 chars:`);
      console.log(text.substring(0, 200));
      return true;
    } else {
      console.log(`[Test] ${name}: invalid (starts with: ${text.substring(0, 30).replace(/[^ -~]/g, '.')})`);
      return false;
    }
  }

  for (const [name, fn] of Object.entries(seedFns)) {
    if (tryFeedbackDecrypt(fn, `feedback-${name}`)) break;
  }

  // Save the encrypted payload for further analysis
  const fs = await import('fs');
  fs.writeFileSync('megaup_encrypted_payload.txt', encryptedPayload);
  fs.writeFileSync('megaup_encrypted_raw.bin', rawBytes);
  fs.writeFileSync('megaup_context.json', JSON.stringify({
    videoId,
    megaHost,
    userAgent: UA,
    embedUrl,
    encryptedPayloadLength: encryptedPayload.length,
  }, null, 2));
  console.log(`\n[Test] Saved encrypted payload and context for further analysis`);
}

main().catch(e => console.error('Fatal:', e));
