/**
 * Miruro Browser-Direct Extractor
 *
 * API extraction routes through the CF Worker (/miruro/episodes, /miruro/sources)
 * which handles pipe encryption server-side. CDN streaming still goes through the
 * Service Worker for residential IP (Referer/Origin headers).
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

const PROVIDER_PRIORITY = ['kiwi', 'bee', 'ally', 'dune', 'hop'];

function getCfWorkerBase(): string {
  if (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_CF_STREAM_PROXY_URL) {
    return process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL.replace(/\/stream\/?$/, '');
  }
  return 'https://media-proxy.vynx-3b3.workers.dev';
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

  const cfBase = getCfWorkerBase();

  // Step 1: MAL → AniList
  const anilistId = await getAnilistId(malId);
  if (!anilistId) {
    console.warn('[Miruro] Could not resolve AniList ID');
    return [];
  }
  console.log(`[Miruro] AniList ID: ${anilistId}`);

  // Step 2: Get episodes via CF Worker (handles pipe encryption server-side)
  let epData: {
    providers: Record<string, { episodes: { sub: Array<{ id: string; number: number }>; dub: Array<{ id: string; number: number }> } }>;
  };
  try {
    const epRes = await fetch(`${cfBase}/miruro/episodes?anilistId=${anilistId}`);
    if (!epRes.ok) {
      console.warn(`[Miruro] Episodes fetch failed: ${epRes.status}`);
      return [];
    }
    epData = await epRes.json() as typeof epData;
  } catch (e) {
    console.warn('[Miruro] Episodes fetch error:', e);
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

    // Step 4: Get sources via CF Worker (handles pipe encryption server-side)
    try {
      const srcRes = await fetch(
        `${cfBase}/miruro/sources?episodeId=${encodeURIComponent(ep.id)}&provider=${providerId}&category=${category}`
      );
      if (!srcRes.ok) continue;

      const srcData = await srcRes.json() as { streams?: MiruroStream[] };

      if (!srcData.streams?.length) continue;

      for (const stream of srcData.streams) {
        if (!stream.url || !stream.isActive) continue;
        // Skip embed sources (kwik.cx etc.) — they need JS execution to resolve.
        // Only direct HLS URLs can be proxied through /miruro/stream.
        if (stream.type === 'embed') {
          console.log(`[Miruro] Skipping embed source from ${providerId}: ${stream.url.substring(0, 60)}`);
          continue;
        }
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
