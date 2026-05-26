/**
 * Miruro Browser-Direct Extractor
 *
 * Calls miruro.to API directly from the browser's residential IP.
 * The Service Worker intercepts these requests, adds Referer/Origin headers,
 * and returns responses with CORS headers.
 *
 * Pipe encryption: XOR with obfuscation key + gzip.
 * Browser handles XOR and uses DecompressionStream for gzip.
 */

export interface MiruroSource {
  quality: string;
  title: string;
  url: string;
  type: 'hls';
  language: string;
  requiresSegmentProxy: boolean;
  referer?: string;
}

interface MiruroStream {
  url: string;
  type: string;
  quality: string;
  resolution?: { width: number; height: number };
  isActive: boolean;
  referer?: string;
}

const MIRURO_BASE = 'https://miruro.to';
const PIPE_OBF_KEY = '71951034f8fbcf53d89db52ceb3dc22c';
const PROVIDER_PRIORITY = ['kiwi', 'gogo', 'zoro', 'animepahe', 'kayo', 'hianime'];

// ═══════════════════════════════════════════════════════════════════════════
// Pipe Encryption (XOR + gzip)
// ═══════════════════════════════════════════════════════════════════════════

function xorEncrypt(data: string, key: string): Uint8Array {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(data);
  const keyBytes = encoder.encode(key);
  const result = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    result[i] = bytes[i] ^ keyBytes[i % keyBytes.length];
  }
  return result;
}

function xorDecrypt(data: Uint8Array, key: string): Uint8Array {
  const keyBytes = new TextEncoder().encode(key);
  const result = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    result[i] = data[i] ^ keyBytes[i % keyBytes.length];
  }
  return result;
}

async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(data as BufferSource);
  writer.close();
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

async function gzipDecompress(data: Uint8Array): Promise<string> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(data as BufferSource);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(result);
}

async function pipeRequest(endpoint: string, payload: Record<string, unknown>): Promise<unknown> {
  const json = JSON.stringify(payload);
  const encrypted = xorEncrypt(json, PIPE_OBF_KEY);
  const compressed = await gzipCompress(encrypted);

  const res = await fetch(`${MIRURO_BASE}/api/secure/pipe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Accept': '*/*',
      'X-Api-Endpoint': endpoint,
    },
    body: compressed as BufferSource,
  });

  if (!res.ok) {
    throw new Error(`Miruro pipe ${endpoint}: ${res.status}`);
  }

  const respBuffer = new Uint8Array(await res.arrayBuffer());
  const decrypted = xorDecrypt(respBuffer, PIPE_OBF_KEY);
  const decompressed = await gzipDecompress(decrypted);
  return JSON.parse(decompressed);
}

// ═══════════════════════════════════════════════════════════════════════════
// AniList ID Lookup
// ═══════════════════════════════════════════════════════════════════════════

async function getAnilistId(malId: number): Promise<number | null> {
  const query = `
    query ($idMal: Int) {
      Media(idMal: $idMal, type: ANIME) {
        id
      }
    }`;
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { idMal: malId } }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json?.data?.Media?.id || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Extractor
// ═══════════════════════════════════════════════════════════════════════════

export async function extractMiruroClient(
  malId: number,
  title: string,
  episode?: number,
  audioPref: 'sub' | 'dub' = 'sub',
): Promise<MiruroSource[]> {
  const targetEp = episode || 1;
  console.log(`[Miruro] Extracting: malId=${malId} title="${title}" ep=${targetEp} pref=${audioPref}`);

  // Ensure Service Worker is in control before making cross-origin requests.
  // Without this, CORS preflight requests fire before SW activation and fail.
  if ('serviceWorker' in navigator) await navigator.serviceWorker.ready;

  // Step 1: MAL → AniList
  const anilistId = await getAnilistId(malId);
  if (!anilistId) {
    console.warn('[Miruro] Could not resolve AniList ID');
    return [];
  }
  console.log(`[Miruro] AniList ID: ${anilistId}`);

  // Step 2: Get episodes via pipe API
  let epData: {
    providers: Record<string, { episodes: { sub: Array<{ id: string; number: number }>; dub: Array<{ id: string; number: number }> } }>;
  };
  try {
    epData = await pipeRequest('episodes', {
      anilistId,
      type: 'anime',
    }) as typeof epData;
  } catch (e) {
    console.warn('[Miruro] Pipe episodes failed:', e);
    return [];
  }

  if (!epData.providers) {
    console.warn('[Miruro] No providers in episodes response');
    return [];
  }

  // Step 3: Try each provider in priority order
  const sources: MiruroSource[] = [];

  for (const providerId of PROVIDER_PRIORITY) {
    const provider = epData.providers[providerId];
    if (!provider) continue;

    const category = audioPref === 'dub' && provider.episodes.dub?.length > 0 ? 'dub' : 'sub';
    const episodes = category === 'dub' ? provider.episodes.dub : provider.episodes.sub;

    const ep = episodes.find(e => e.number === targetEp);
    if (!ep) continue;

    console.log(`[Miruro] Found ep ${targetEp} on ${providerId} (${category}): ${ep.id}`);

    // Step 4: Get sources via pipe API
    try {
      const srcData = await pipeRequest('sources', {
        episodeId: ep.id,
        provider: providerId,
        category,
      }) as { streams?: MiruroStream[] };

      if (!srcData.streams?.length) continue;

      for (const stream of srcData.streams) {
        if (!stream.url || !stream.isActive) continue;
        sources.push({
          quality: stream.quality || stream.resolution?.height?.toString() || 'auto',
          title: `Miruro ${providerId} (${category})${stream.quality ? ' ' + stream.quality : ''}`,
          url: stream.url,
          type: 'hls',
          language: category === 'dub' ? 'en' : 'ja',
          requiresSegmentProxy: true,
          referer: stream.referer || 'https://kwik.cx/',
        });
      }

      if (sources.length > 0) {
        console.log(`[Miruro] ${sources.length} sources from ${providerId}/${category}`);
        break;
      }
    } catch (e) {
      console.warn(`[Miruro] ${providerId} sources failed:`, e);
    }
  }

  console.log(`[Miruro] Total: ${sources.length} sources`);
  return sources;
}
