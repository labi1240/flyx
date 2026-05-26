/**
 * Miruro Client-Side Extractor
 *
 * Calls CF Worker /miruro/* endpoints which handle XOR+gzip pipe encryption.
 * Browser calls CF Worker directly (browser → CF Worker → miruro.to).
 * MAL→AniList mapping done via malService or graphql.anilist.co from browser.
 */

import { malService } from '@/lib/services/mal';

const CF_WORKER_BASE = typeof window !== 'undefined'
  ? (process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL || 'https://media-proxy.vynx-3b3.workers.dev/stream').replace(/\/stream\/?$/, '')
  : '';

export interface MiruroSource {
  quality: string;
  title: string;
  url: string;
  type: 'hls';
  language: string;
  requiresSegmentProxy: boolean;
  referer?: string;
}

interface MiruroEpisode {
  id: string;
  number: number;
  title: string;
  audio: 'sub' | 'dub';
}

interface MiruroStream {
  url: string;
  type: string;
  quality: string;
  resolution?: { width: number; height: number };
  isActive: boolean;
  referer?: string;
}

const PROVIDER_PRIORITY = ['kiwi', 'gogo', 'zoro', 'animepahe', 'kayo', 'hianime'];

/**
 * Get AniList ID from MAL ID using malService.
 * Falls back to direct graphql.anilist.co call.
 */
async function getAnilistId(malId: number): Promise<number | null> {
  try {
    const anime = await malService.getById(malId);
    // malService stores AniList ID — check the returned object
    const record = anime as any;
    if (record?.id) return record.id;
  } catch (e) {
    console.warn('[Miruro] malService.getById failed, trying direct AniList:', e);
  }
  // Fallback: direct AniList query
  try {
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
      signal: AbortSignal.timeout(8000),
    });
    const json = await res.json();
    return json?.data?.Media?.id || null;
  } catch (e) {
    console.warn('[Miruro] AniList direct query failed:', e);
    return null;
  }
}

export async function extractMiruroClient(
  malId: number,
  title: string,
  episode?: number,
  audioPref: 'sub' | 'dub' = 'sub',
): Promise<MiruroSource[]> {
  console.log(`[Miruro] Extracting: malId=${malId} title="${title}" ep=${episode} pref=${audioPref}`);

  // Step 1: MAL → AniList
  const anilistId = await getAnilistId(malId);
  if (!anilistId) {
    console.warn('[Miruro] Could not resolve AniList ID');
    return [];
  }
  console.log(`[Miruro] AniList ID: ${anilistId}`);

  // Step 2: Get episodes from CF Worker
  const epRes = await fetch(`${CF_WORKER_BASE}/miruro/episodes?anilistId=${anilistId}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!epRes.ok) {
    console.warn(`[Miruro] episodes ${epRes.status}`);
    return [];
  }

  const epData = await epRes.json() as {
    providers: Record<string, { episodes: { sub: MiruroEpisode[]; dub: MiruroEpisode[] } }>;
  };

  if (!epData.providers) {
    console.warn('[Miruro] No providers in episodes response');
    return [];
  }

  // Step 3: Find target episode — try each provider in priority order
  const targetEp = episode || 1;
  const sources: MiruroSource[] = [];

  for (const providerId of PROVIDER_PRIORITY) {
    const provider = epData.providers[providerId];
    if (!provider) continue;

    const category = audioPref === 'dub' && provider.episodes.dub?.length > 0 ? 'dub' : 'sub';
    const episodes = category === 'dub' ? provider.episodes.dub : provider.episodes.sub;

    const ep = episodes.find(e => e.number === targetEp);
    if (!ep) continue;

    console.log(`[Miruro] Found ep ${targetEp} on ${providerId} (${category}): ${ep.id}`);

    // Step 4: Get stream sources
    try {
      const srcRes = await fetch(
        `${CF_WORKER_BASE}/miruro/sources?episodeId=${ep.id}&provider=${providerId}&category=${category}`,
        { signal: AbortSignal.timeout(15000) },
      );

      if (!srcRes.ok) continue;

      const srcData = await srcRes.json() as { streams?: MiruroStream[] };
      if (!srcData.streams?.length) continue;

      for (const stream of srcData.streams) {
        if (!stream.url || !stream.isActive) continue;

        // SW method: return raw CDN URL — no CF Worker stream proxying.
        // The Service Worker (residential-ip-sw.js) intercepts and fetches
        // from the browser's residential IP with proper Referer/Origin.
        const videoUrl = stream.url;

        sources.push({
          quality: stream.quality || stream.resolution?.height?.toString() || 'auto',
          title: `Miruro ${providerId} (${category})${stream.quality ? ' ' + stream.quality : ''}`,
          url: videoUrl,
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
