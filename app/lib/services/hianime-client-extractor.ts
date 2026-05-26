/**
 * HiAnime Browser-Direct Extractor
 *
 * Calls aniwatchtv.to APIs directly from the browser's residential IP.
 * The Service Worker (residential-ip-sw.js) intercepts these requests,
 * adds Referer/Origin headers, and returns responses with CORS headers.
 *
 * No CF Worker dependency for extraction — the browser handles everything:
 * search → MAL match → episode list → servers → extract → MegaCloud decrypt.
 */

export interface HiAnimeSource {
  quality: string;
  title: string;
  url: string;
  type: 'hls';
  language: string;
  requiresSegmentProxy: boolean;
  skipIntro?: [number, number];
  skipOutro?: [number, number];
}

const HIANIME_DOMAIN = 'aniwatchtv.to';
const MEGACLOUD_KEYS_URLS = [
  'https://raw.githubusercontent.com/yogesh-hacker/MegacloudKeys/refs/heads/main/keys.json',
  'https://raw.githubusercontent.com/CattoFish/MegacloudKeys/refs/heads/main/keys.json',
  'https://raw.githubusercontent.com/ghoshRitesh12/aniwatch/refs/heads/main/src/extractors/megacloud-keys.json',
];

// ═══════════════════════════════════════════════════════════════════════════
// MegaCloud Decryption Engine (pure JS, no dependencies)
// Ported from cloudflare-proxy/src/hianime-proxy.ts
// ═══════════════════════════════════════════════════════════════════════════

function keygen2(megacloudKey: string, clientKey: string): string {
  const keygenHashMultVal = BigInt(31);
  const keygenXORVal = 247;
  const keygenShiftVal = 5;
  let tempKey = megacloudKey + clientKey;

  let hashVal = BigInt(0);
  for (let i = 0; i < tempKey.length; i++) {
    hashVal = BigInt(tempKey.charCodeAt(i)) + hashVal * keygenHashMultVal + (hashVal << BigInt(7)) - hashVal;
  }
  hashVal = hashVal < BigInt(0) ? -hashVal : hashVal;
  const lHash = Number(hashVal % BigInt("0x7fffffffffffffff"));

  tempKey = tempKey.split('').map(c => String.fromCharCode(c.charCodeAt(0) ^ keygenXORVal)).join('');
  const pivot = (lHash % tempKey.length) + keygenShiftVal;
  tempKey = tempKey.slice(pivot) + tempKey.slice(0, pivot);

  const leafStr = clientKey.split('').reverse().join('');
  let returnKey = '';
  for (let i = 0; i < Math.max(tempKey.length, leafStr.length); i++) {
    returnKey += (tempKey[i] || '') + (leafStr[i] || '');
  }
  returnKey = returnKey.substring(0, 96 + (lHash % 33));
  returnKey = [...returnKey].map(c => String.fromCharCode((c.charCodeAt(0) % 95) + 32)).join('');
  return returnKey;
}

function seedShuffle2(charArray: string[], iKey: string): string[] {
  let hashVal = BigInt(0);
  for (let i = 0; i < iKey.length; i++) {
    hashVal = (hashVal * BigInt(31) + BigInt(iKey.charCodeAt(i))) & BigInt("0xffffffff");
  }
  let shuffleNum = hashVal;
  const psudoRand = (arg: number) => {
    shuffleNum = (shuffleNum * BigInt(1103515245) + BigInt(12345)) & BigInt("0x7fffffff");
    return Number(shuffleNum % BigInt(arg));
  };
  const retStr = [...charArray];
  for (let i = retStr.length - 1; i > 0; i--) {
    const swapIndex = psudoRand(i + 1);
    [retStr[i], retStr[swapIndex]] = [retStr[swapIndex], retStr[i]];
  }
  return retStr;
}

function columnarCipher2(src: string, ikey: string): string {
  const columnCount = ikey.length;
  const rowCount = Math.ceil(src.length / columnCount);
  const cipherArry = Array(rowCount).fill(null).map(() => Array(columnCount).fill(' '));
  const keyMap = ikey.split('').map((char, index) => ({ char, idx: index }));
  const sortedMap = [...keyMap].sort((a, b) => a.char.charCodeAt(0) - b.char.charCodeAt(0));

  let srcIndex = 0;
  sortedMap.forEach(({ idx: index }) => {
    for (let i = 0; i < rowCount; i++) {
      cipherArry[i][index] = src[srcIndex++];
    }
  });

  let returnStr = '';
  for (let x = 0; x < rowCount; x++) {
    for (let y = 0; y < columnCount; y++) {
      returnStr += cipherArry[x][y];
    }
  }
  return returnStr;
}

function decryptSrc2(src: string, clientKey: string, megacloudKey: string): string {
  const layers = 3;
  const genKey = keygen2(megacloudKey, clientKey);
  let decSrc = atob(src);
  const charArray = [...Array(95)].map((_, index) => String.fromCharCode(32 + index));

  const reverseLayer = (iteration: number) => {
    const layerKey = genKey + iteration;
    let hashVal = BigInt(0);
    for (let i = 0; i < layerKey.length; i++) {
      hashVal = (hashVal * BigInt(31) + BigInt(layerKey.charCodeAt(i))) & BigInt("0xffffffff");
    }
    let seed = hashVal;
    const seedRand = (arg: number) => {
      seed = (seed * BigInt(1103515245) + BigInt(12345)) & BigInt("0x7fffffff");
      return Number(seed % BigInt(arg));
    };

    decSrc = decSrc.split('').map((char) => {
      const cArryIndex = charArray.indexOf(char);
      if (cArryIndex === -1) return char;
      const randNum = seedRand(95);
      const newCharIndex = (cArryIndex - randNum + 95) % 95;
      return charArray[newCharIndex];
    }).join('');

    decSrc = columnarCipher2(decSrc, layerKey);
    const subValues = seedShuffle2(charArray, layerKey);
    const charMap: Record<string, string> = {};
    subValues.forEach((char, index) => { charMap[char] = charArray[index]; });
    decSrc = decSrc.split('').map(char => charMap[char] || char).join('');
  };

  for (let i = layers; i > 0; i--) {
    reverseLayer(i);
  }
  const dataLen = parseInt(decSrc.substring(0, 4), 10);
  return decSrc.substring(4, 4 + dataLen);
}

// ═══════════════════════════════════════════════════════════════════════════
// HiAnime API (browser-direct via Service Worker)
// ═══════════════════════════════════════════════════════════════════════════

async function hianimeSearch(query: string): Promise<Array<{ id: string; name: string; hianimeId: string | null }>> {
  const searchUrl = `https://${HIANIME_DOMAIN}/ajax/search/suggest?keyword=${encodeURIComponent(query)}`;
  console.log(`[HiAnime] Search: ${searchUrl}`);
  const res = await fetch(searchUrl);
  if (!res.ok) {
    console.warn(`[HiAnime] Search returned ${res.status}`);
    return [];
  }
  try {
    const json = await res.json() as { status: boolean; html: string };
    if (!json.status || !json.html) return [];

    const results: Array<{ id: string; name: string; hianimeId: string | null }> = [];
    const linkRegex = /<a[^>]*href="\/([^"]+)"[^>]*data-id="(\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = linkRegex.exec(json.html)) !== null) {
      const name = match[3].replace(/<[^>]+>/g, '').trim();
      if (name) {
        results.push({ id: match[1], name, hianimeId: match[2] });
      }
    }
    return results;
  } catch (e) {
    console.warn('[HiAnime] Search parse error:', e);
    return [];
  }
}

async function getHiAnimeMalId(animeSlug: string): Promise<number | null> {
  const res = await fetch(`https://${HIANIME_DOMAIN}/${animeSlug}`);
  if (!res.ok) return null;
  const html = await res.text();
  const syncMatch = html.match(/<script[^>]*id="syncData"[^>]*>([\s\S]*?)<\/script>/) ||
                    html.match(/<div[^>]*id="syncData"[^>]*>([^<]*)<\/div>/);
  if (!syncMatch) return null;
  try {
    const syncData = JSON.parse(syncMatch[1]);
    return syncData.mal_id ? parseInt(syncData.mal_id) : null;
  } catch {
    return null;
  }
}

async function findHiAnimeByMalId(malId: number, title: string): Promise<{ hianimeId: string; slug: string } | null> {
  let results = await hianimeSearch(title);
  if (results.length === 0) {
    const cleanTitle = title
      .replace(/\s*\(TV\)\s*/gi, '')
      .replace(/\s*Season\s*\d+\s*/gi, '')
      .replace(/\s*\d+(?:st|nd|rd|th)\s+Season\s*/gi, '')
      .trim();
    if (cleanTitle !== title) {
      results = await hianimeSearch(cleanTitle);
    }
  }

  for (const result of results.slice(0, 8)) {
    const malIdFromPage = await getHiAnimeMalId(result.id);
    if (malIdFromPage === malId && result.hianimeId) {
      console.log(`[HiAnime] MAL match: ${result.id} (malId=${malId})`);
      return { hianimeId: result.hianimeId, slug: result.id };
    }
  }

  if (results.length === 1 && results[0].hianimeId) {
    console.log(`[HiAnime] Single result fallback: ${results[0].id}`);
    return { hianimeId: results[0].hianimeId, slug: results[0].id };
  }

  return null;
}

async function getEpisodes(hianimeId: string): Promise<Array<{ number: number; dataId: string }>> {
  const url = `https://${HIANIME_DOMAIN}/ajax/v2/episode/list/${hianimeId}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`[HiAnime] Episodes returned ${res.status}`);
    return [];
  }
  const json = await res.json() as { status: boolean; html: string };
  if (!json.status || !json.html) return [];

  const episodes: Array<{ number: number; dataId: string }> = [];
  const epRegex = /data-number="(\d+)"[^>]*data-id="([^"]+)"/gi;
  let match;
  while ((match = epRegex.exec(json.html)) !== null) {
    episodes.push({ number: parseInt(match[1]), dataId: match[2] });
  }
  return episodes;
}

interface Server {
  dataId: string;
  type: string;
  serverId: string;
}

async function getServers(episodeId: string): Promise<Server[]> {
  const url = `https://${HIANIME_DOMAIN}/ajax/v2/episode/servers?episodeId=${episodeId}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json() as { status: boolean; html: string };
  if (!json.status || !json.html) return [];

  const servers: Server[] = [];
  const srvRegex = /data-server-id="(\d+)"[^>]*data-id="([^"]+)"[^>]*data-type="([^"]+)"/gi;
  let match;
  while ((match = srvRegex.exec(json.html)) !== null) {
    servers.push({ serverId: match[1], dataId: match[2], type: match[3] });
  }
  return servers;
}

async function getSourceLink(serverDataId: string): Promise<{ link: string }> {
  const url = `https://${HIANIME_DOMAIN}/ajax/v2/episode/sources?id=${serverDataId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sources ${res.status}`);
  const json = await res.json() as { status: boolean; link: string };
  if (!json.status || !json.link) throw new Error('No source link');
  return { link: json.link };
}

interface MegaCloudResult {
  sources: Array<{ file: string; type: string }>;
  subtitles: Array<{ file: string; label: string; kind: string }>;
  intro?: { start: number; end: number };
  outro?: { start: number; end: number };
}

// In-memory cache for MegaCloud keys (fetched once per session)
let cachedMegacloudKey: string | null = null;

async function getMegacloudKey(): Promise<string> {
  if (cachedMegacloudKey) return cachedMegacloudKey;

  for (const keyUrl of MEGACLOUD_KEYS_URLS) {
    try {
      const res = await fetch(keyUrl);
      if (res.ok) {
        const keys = await res.json() as Array<{ key: string }>;
        if (keys.length > 0) {
          cachedMegacloudKey = keys[0].key;
          console.log(`[HiAnime] MegaCloud key loaded (${keys.length} keys)`);
          return cachedMegacloudKey!;
        }
      }
    } catch {}
  }
  throw new Error('Could not fetch MegaCloud decryption keys');
}

async function extractMegaCloud(sourceId: string): Promise<MegaCloudResult> {
  // Step 1: Get client key from embed page
  const embedUrl = `https://megacloud.blog/embed-2/v3/e-1/${sourceId}`;
  const embedRes = await fetch(embedUrl);
  if (!embedRes.ok) throw new Error(`MegaCloud embed ${embedRes.status}`);
  const embedHtml = await embedRes.text();

  // Extract client key — try multiple regex patterns
  let clientKey: string | null = null;
  const keyPatterns = [
    /clientKey\s*=\s*"([^"]+)"/,
    /data-key\s*=\s*"([^"]+)"/,
    /_k\s*=\s*"([^"]+)"/,
    /"clientKey"\s*:\s*"([^"]+)"/,
    /clientKey\s*=\s*'([^']+)'/,
  ];
  for (const pattern of keyPatterns) {
    const m = embedHtml.match(pattern);
    if (m) { clientKey = m[1]; break; }
  }
  if (!clientKey) throw new Error('Could not extract MegaCloud client key');

  // Step 2: Get encrypted sources
  const srcUrl = `https://megacloud.blog/embed-2/v3/e-1/getSources?id=${sourceId}&_k=${encodeURIComponent(clientKey)}`;
  const srcRes = await fetch(srcUrl);
  if (!srcRes.ok) throw new Error(`MegaCloud getSources ${srcRes.status}`);
  const srcData = await srcRes.json() as {
    sources?: string;
    encrypted?: boolean;
    tracks?: Array<{ file: string; label: string; kind: string }>;
    intro?: { start: number; end: number };
    outro?: { start: number; end: number };
  };

  let sourceJson: { file: string; type: string }[];

  if (srcData.encrypted && srcData.sources) {
    const megacloudKey = await getMegacloudKey();
    const decrypted = decryptSrc2(srcData.sources, clientKey, megacloudKey);
    sourceJson = JSON.parse(decrypted);
  } else if (srcData.sources) {
    sourceJson = JSON.parse(srcData.sources);
  } else {
    throw new Error('MegaCloud: no sources in response');
  }

  return {
    sources: sourceJson,
    subtitles: srcData.tracks || [],
    intro: srcData.intro,
    outro: srcData.outro,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Extractor
// ═══════════════════════════════════════════════════════════════════════════

export async function extractHiAnimeClient(
  malId: number,
  title: string,
  episode?: number,
): Promise<HiAnimeSource[]> {
  const targetEp = episode || 1;
  console.log(`[HiAnime] Extracting: malId=${malId} title="${title}" ep=${targetEp}`);

  // Step 1: Find anime on HiAnime by MAL ID
  const anime = await findHiAnimeByMalId(malId, title);
  if (!anime) {
    console.warn('[HiAnime] Could not find anime on HiAnime');
    return [];
  }
  console.log(`[HiAnime] Found: ${anime.slug} (id=${anime.hianimeId})`);

  // Step 2: Get episodes
  const episodes = await getEpisodes(anime.hianimeId);
  if (episodes.length === 0) {
    console.warn('[HiAnime] No episodes found');
    return [];
  }
  const epData = episodes.find(e => e.number === targetEp);
  if (!epData) {
    console.warn(`[HiAnime] Episode ${targetEp} not found (have ${episodes.length} episodes)`);
    return [];
  }
  console.log(`[HiAnime] Episode ${targetEp}: dataId=${epData.dataId}`);

  // Step 3: Get servers (sub + dub)
  const servers = await getServers(epData.dataId);
  if (servers.length === 0) {
    console.warn('[HiAnime] No servers');
    return [];
  }

  // Prefer VidStreaming (serverId=4), fall back to any sub/dub
  const subServer = servers.find(s => s.serverId === '4' && s.type === 'sub') ||
                   servers.find(s => s.type === 'sub');
  const dubServer = servers.find(s => s.serverId === '4' && s.type === 'dub') ||
                   servers.find(s => s.type === 'dub');

  if (!subServer && !dubServer) {
    console.warn('[HiAnime] No sub or dub servers found');
    return [];
  }

  // Step 4: Extract streams for sub and dub in parallel
  const sources: HiAnimeSource[] = [];
  const serverTasks: Array<{ server: Server; language: string; label: string }> = [];
  if (subServer) serverTasks.push({ server: subServer, language: 'ja', label: 'sub' });
  if (dubServer) serverTasks.push({ server: dubServer, language: 'en', label: 'dub' });

  const results = await Promise.allSettled(
    serverTasks.map(async ({ server, language, label }) => {
      const { link } = await getSourceLink(server.dataId);
      // link is the MegaCloud embed URL — extract sourceId from it
      const sourceIdMatch = link.match(/\/e-1\/([^?]+)/);
      if (!sourceIdMatch) throw new Error('Could not parse sourceId from embed URL');
      const sourceId = sourceIdMatch[1];

      const mcResult = await extractMegaCloud(sourceId);

      return mcResult.sources
        .filter(s => s.file)
        .map(s => ({
          quality: s.type || 'auto',
          title: `HiAnime (${label})${s.type ? ' ' + s.type : ''}`,
          url: s.file,
          type: 'hls' as const,
          language,
          requiresSegmentProxy: false,
          skipIntro: mcResult.intro?.end ? [mcResult.intro.start, mcResult.intro.end] as [number, number] : undefined,
          skipOutro: mcResult.outro?.end ? [mcResult.outro.start, mcResult.outro.end] as [number, number] : undefined,
        }));
    })
  );

  for (const r of results) {
    if (r.status === 'fulfilled') sources.push(...r.value);
    else console.warn(`[HiAnime] Server task failed:`, r.reason);
  }

  console.log(`[HiAnime] ${sources.length} sources (sub+dub)`);
  return sources;
}
