/**
 * Miruro Extension-Direct Extractor
 *
 * Extraction runs entirely through the Flyx Bypass browser extension's
 * service worker — NO CF Worker intermediary. The SW fetches from
 * Miruro's API directly from the browser's residential IP using the
 * Miruro Pipe Protocol (XOR+gzip encryption).
 *
 * Flow:
 *   web app → postMessage('miruro') → bridge.js → SW (pipe crypto + API)
 *   SW → bridge.js → postMessage('miruroRes') → web app
 */

export interface MiruroSource {
  quality: string;
  title: string;
  url: string;
  type: 'hls';
  language: string;
  requiresSegmentProxy: boolean;
}

const EXT_TIMEOUT = 30000;

function extractViaExtension(
  malId: number,
  episode: number,
  audioPref: 'sub' | 'dub',
): Promise<MiruroSource[]> {
  return new Promise(function (resolve, reject) {
    var id = 'mir_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    var timer = setTimeout(function () {
      cleanup();
      reject(new Error('Extension Miruro extraction timed out'));
    }, EXT_TIMEOUT);

    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
    }

    function onMsg(e: MessageEvent) {
      if (e.source !== window || !e.data || e.data.__flyx !== 'miruroRes' || e.data.id !== id) return;
      cleanup();
      if (e.data.ok && e.data.sources) {
        console.log('[Miruro Ext] Extension returned ' + e.data.sources.length + ' sources');
        resolve(e.data.sources as MiruroSource[]);
      } else {
        reject(new Error(e.data.error || 'Extension Miruro extraction failed'));
      }
    }

    window.addEventListener('message', onMsg);
    window.postMessage({
      __flyx: 'miruro',
      id: id,
      malId: malId,
      episode: episode,
      audioPref: audioPref,
    }, '*');
  });
}

/**
 * Extract Miruro stream sources via the browser extension.
 * Falls back to CF Worker path if extension not detected.
 */
export async function extractMiruroClient(
  malId: number,
  title: string,
  episode?: number,
  audioPref: 'sub' | 'dub' = 'sub',
): Promise<MiruroSource[]> {
  var targetEp = episode || 1;
  console.log('[Miruro] Extracting via extension: malId=' + malId + ' ep=' + targetEp + ' pref=' + audioPref);

  // Check if extension is available
  var hasExtension = !!(
    (window as any).__FLYX_EXTENSION__?.installed
  );

  if (hasExtension) {
    try {
      return await extractViaExtension(malId, targetEp, audioPref);
    } catch (e) {
      console.warn('[Miruro] Extension extraction failed, falling back to CF Worker:', e);
      // Fall through to CF Worker fallback
    }
  }

  // Fallback: CF Worker path (kept for when extension is not installed)
  return extractViaWorker(malId, title, targetEp, audioPref);
}

// ─── CF Worker fallback (used when extension is not available) ────────────

function getCfWorkerBase(): string {
  if (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_CF_STREAM_PROXY_URL) {
    return process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL.replace(/\/stream\/?$/, '');
  }
  return 'https://media-proxy.vynx-3b3.workers.dev';
}

async function getAnilistId(malId: number): Promise<number | null> {
  var query = 'query($idMal:Int){Media(idMal:$idMal,type:ANIME){id}}';
  var res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: query, variables: { idMal: malId } }),
  });
  if (!res.ok) return null;
  var json = await res.json();
  return json?.data?.Media?.id || null;
}

interface MiruroStream {
  url: string; type: string; quality: string;
  resolution?: { width: number; height: number };
  isActive: boolean; referer?: string;
}

var PROVIDER_PRIORITY = ['kiwi', 'bee', 'ally', 'dune', 'hop'];

async function extractViaWorker(
  malId: number,
  _title: string,
  targetEp: number,
  audioPref: 'sub' | 'dub',
): Promise<MiruroSource[]> {
  var cfBase = getCfWorkerBase();
  var anilistId = await getAnilistId(malId);
  if (!anilistId) return [];

  var epData: any;
  try {
    var epRes = await fetch(cfBase + '/miruro/episodes?anilistId=' + anilistId);
    if (!epRes.ok) return [];
    epData = await epRes.json();
  } catch (e) {
    return [];
  }
  if (!epData.providers) return [];

  var sources: MiruroSource[] = [];
  for (var pi = 0; pi < PROVIDER_PRIORITY.length; pi++) {
    var providerId = PROVIDER_PRIORITY[pi];
    var provider = epData.providers[providerId];
    if (!provider) continue;
    var cat = (audioPref === 'dub' && provider.episodes.dub?.length > 0) ? 'dub' : 'sub';
    var eps = cat === 'dub' ? provider.episodes.dub : provider.episodes.sub;
    var ep = eps.find((e: any) => e.number === targetEp);
    if (!ep) continue;

    try {
      var srcRes = await fetch(
        cfBase + '/miruro/sources?episodeId=' + encodeURIComponent(ep.id) + '&provider=' + providerId + '&category=' + cat
      );
      if (!srcRes.ok) continue;
      var srcData = await srcRes.json() as { streams?: MiruroStream[] };
      if (!srcData.streams?.length) continue;
      for (var si = 0; si < srcData.streams.length; si++) {
        var s = srcData.streams[si];
        if (!s.url || !s.isActive || s.type === 'embed') continue;
        sources.push({
          quality: s.quality || s.resolution?.height?.toString() || 'auto',
          title: 'Miruro ' + providerId + ' (' + cat + ')' + (s.quality ? ' ' + s.quality : ''),
          url: s.url,
          type: 'hls',
          language: cat === 'dub' ? 'en' : 'ja',
          requiresSegmentProxy: true,
        });
      }
      if (sources.length > 0) break;
    } catch (e) {}
  }
  return sources;
}
