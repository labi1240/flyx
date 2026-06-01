/**
 * AllAnime Extractor (browser-direct via extension SW relay)
 *
 * AllAnime (api.allanime.day) is a large, reliable anime catalog that serves
 * H.264 streams (universally playable in Chrome/Edge, unlike Miruro's HEVC).
 * It is the same backend used by ani-cli.
 *
 * Pipeline (all network via the SW relay — bypasses CORS + Cloudflare bot
 * scoring by fetching as real Chrome from the user's residential IP; a DNR
 * rule injects the required Referer for api.allanime.day):
 *   1. GraphQL search by title          → show _id
 *   2. GraphQL availableEpisodesDetail   → episode list (sub/dub)
 *   3. GraphQL sourceUrls for episode    → array of obfuscated source paths
 *   4. Decode '--'-prefixed paths (hex bytes XOR 0x38), '/clock'→'/clock.json'
 *   5. Fetch clock.json on api.allanime.day → { links: [{ link, hls }] }
 *      = direct H.264 m3u8/mp4 URLs.
 */

import { swFetch } from './sw-fetch';

export interface AllAnimeSource {
  quality: string;
  title: string;
  url: string;
  type: 'hls';
  language: string;
  requiresSegmentProxy: boolean;
}

const API = 'https://api.allanime.day';
const REFERER = 'https://allmanga.to';
// ani-cli sends Referer only (no Origin) — match it. The SW DNR rule injects
// the Referer (fetch() can't set it); Accept is harmless.
const HEADERS: Record<string, string> = {
  'Accept': 'application/json',
  'Referer': REFERER + '/',
};

const SEARCH_GQL =
  'query($search:SearchInput,$limit:Int,$page:Int,$translationType:VaildTranslationTypeEnumType,$countryOrigin:VaildCountryOriginEnumType){shows(search:$search,limit:$limit,page:$page,translationType:$translationType,countryOrigin:$countryOrigin){edges{_id name englishName availableEpisodes}}}';
const EPISODES_GQL =
  'query($showId:String!){show(_id:$showId){_id availableEpisodesDetail}}';
const SOURCES_GQL =
  'query($showId:String!,$translationType:VaildTranslationTypeEnumType!,$episodeString:String!){episode(showId:$showId,translationType:$translationType,episodeString:$episodeString){episodeString sourceUrls}}';

// ── Helpers ────────────────────────────────────────────────────────────────

function gqlUrl(query: string, variables: Record<string, unknown>): string {
  return `${API}/api?variables=${encodeURIComponent(JSON.stringify(variables))}&query=${encodeURIComponent(query)}`;
}

async function gql<T = any>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  const res = await swFetch(gqlUrl(query, variables), HEADERS, 12000);
  if (!res || !res.ok) return null;
  try {
    const json = JSON.parse(res.body) as { data?: T };
    return json.data ?? null;
  } catch {
    return null;
  }
}

/** Decode an AllAnime obfuscated sourceUrl: strip '--', hex bytes XOR 0x38. */
function decodeSourceUrl(encoded: string): string | null {
  if (!encoded.startsWith('--')) return null;
  const hex = encoded.slice(2);
  if (hex.length % 2 !== 0) return null;
  let out = '';
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.substr(i, 2), 16);
    if (Number.isNaN(byte)) return null;
    out += String.fromCharCode(byte ^ 0x38);
  }
  // The decoded path points at the clock endpoint; the JSON variant returns links.
  return out.replace('/clock', '/clock.json');
}

function normalizeTitle(t: string): string {
  return t.toLowerCase()
    .replace(/[-_:;,./\\|]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreMatch(candidate: string, query: string): number {
  const nc = normalizeTitle(candidate);
  const nq = normalizeTitle(query);
  if (!nc || !nq) return 0;
  if (nc === nq) return 100;
  if (nc.startsWith(nq) || nq.startsWith(nc)) return 88;
  if (nc.includes(nq) || nq.includes(nc)) return 70;
  return 0;
}

// ── Types for AllAnime responses ────────────────────────────────────────────

interface ShowEdge {
  _id: string;
  name: string;
  englishName?: string;
  availableEpisodes?: { sub?: number; dub?: number };
}

interface SourceEntry {
  sourceUrl: string;
  sourceName?: string;
  type?: string;
  priority?: number;
}

interface ClockLink {
  link?: string;
  src?: string;
  hls?: boolean;
  resolutionStr?: string;
  mp4?: boolean;
}

// ── Pipeline steps ───────────────────────────────────────────────────────────

async function findShow(title: string, mode: 'sub' | 'dub'): Promise<ShowEdge | null> {
  const data = await gql<{ shows?: { edges?: ShowEdge[] } }>(SEARCH_GQL, {
    search: { allowAdult: false, allowUnknown: false, query: title },
    limit: 40,
    page: 1,
    translationType: mode,
    countryOrigin: 'ALL',
  });
  const edges = data?.shows?.edges || [];
  if (edges.length === 0) return null;

  const scored = edges
    .map(e => ({
      edge: e,
      score: Math.max(scoreMatch(e.name, title), e.englishName ? scoreMatch(e.englishName, title) : 0),
    }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length > 0) return scored[0].edge;
  // Fall back to the first result that has episodes for the requested mode.
  return edges.find(e => (mode === 'dub' ? e.availableEpisodes?.dub : e.availableEpisodes?.sub)) || edges[0];
}

async function getEpisodeList(showId: string, mode: 'sub' | 'dub'): Promise<string[]> {
  const data = await gql<{ show?: { availableEpisodesDetail?: Record<string, string[]> } }>(
    EPISODES_GQL,
    { showId },
  );
  const detail = data?.show?.availableEpisodesDetail;
  return (detail && detail[mode]) || [];
}

/** Pick the episode string matching the target number (lists may be unsorted/strings). */
function pickEpisodeString(list: string[], target: number): string | null {
  const t = String(target);
  if (list.includes(t)) return t;
  // numeric match (handles "1.0" / leading zeros)
  for (const e of list) {
    const n = parseFloat(e);
    if (!Number.isNaN(n) && n === target) return e;
  }
  return null;
}

async function resolveClockLinks(decodedPath: string): Promise<ClockLink[]> {
  const url = decodedPath.startsWith('http') ? decodedPath : `${API}${decodedPath}`;
  const res = await swFetch(url, HEADERS, 12000);
  if (!res || !res.ok) return [];
  try {
    const json = JSON.parse(res.body) as { links?: ClockLink[] };
    return json.links || [];
  } catch {
    return [];
  }
}

async function getSources(
  showId: string,
  episodeString: string,
  mode: 'sub' | 'dub',
): Promise<AllAnimeSource[]> {
  const data = await gql<{ episode?: { sourceUrls?: SourceEntry[] } }>(SOURCES_GQL, {
    showId,
    translationType: mode,
    episodeString,
  });
  const sourceUrls = data?.episode?.sourceUrls || [];
  if (sourceUrls.length === 0) return [];

  // Decode only the internal '--' providers (they resolve to direct links).
  const decoded = sourceUrls
    .map(s => ({ name: s.sourceName || 'AllAnime', priority: s.priority || 0, path: decodeSourceUrl(s.sourceUrl) }))
    .filter(s => !!s.path) as Array<{ name: string; priority: number; path: string }>;

  // Resolve in parallel; collect direct video links.
  const results = await Promise.allSettled(
    decoded.map(async (d) => {
      const links = await resolveClockLinks(d.path);
      return links.map(l => ({ name: d.name, link: l }));
    }),
  );

  const sources: AllAnimeSource[] = [];
  const lang = mode === 'dub' ? 'en' : 'ja';
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const { name, link } of r.value) {
      const url = link.link || link.src;
      if (!url) continue;
      const isHls = link.hls || /\.m3u8(\?|$)/i.test(url);
      // The anime player is hls.js-only, so keep direct m3u8 (HLS) sources.
      // AllAnime's reliable internal providers (Default/Sak/Luf-mp4) are HLS.
      if (!isHls) continue;
      sources.push({
        quality: link.resolutionStr || 'auto',
        title: `AllAnime - ${name}${link.resolutionStr ? ' ' + link.resolutionStr : ''}`,
        url,
        type: 'hls',
        language: lang,
        requiresSegmentProxy: true,
      });
    }
  }

  // Dedupe by URL.
  const seen = new Set<string>();
  return sources.filter(s => (seen.has(s.url) ? false : (seen.add(s.url), true)));
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function extractAllAnimeClient(
  _malId: number,
  title: string,
  episode?: number,
  audioPref: 'sub' | 'dub' = 'sub',
): Promise<AllAnimeSource[]> {
  const targetEp = episode || 1;
  const mode: 'sub' | 'dub' = audioPref === 'dub' ? 'dub' : 'sub';
  console.log(`[AllAnime] Extracting: title="${title}" ep=${targetEp} mode=${mode}`);

  let show = await findShow(title, mode);
  // If dub requested but not found, retry sub (and vice versa).
  let activeMode = mode;
  if (!show && mode === 'dub') { show = await findShow(title, 'sub'); activeMode = 'sub'; }
  if (!show) {
    console.warn('[AllAnime] No matching show');
    return [];
  }
  console.log(`[AllAnime] Matched "${show.englishName || show.name}" (_id=${show._id})`);

  let list = await getEpisodeList(show._id, activeMode);
  if (list.length === 0 && activeMode === 'dub') {
    activeMode = 'sub';
    list = await getEpisodeList(show._id, activeMode);
  }
  const epString = pickEpisodeString(list, targetEp);
  if (!epString) {
    console.warn(`[AllAnime] Episode ${targetEp} not in list (${list.length} eps)`);
    return [];
  }

  const sources = await getSources(show._id, epString, activeMode);
  console.log(`[AllAnime] ${sources.length} source(s) for ep ${targetEp} (${activeMode})`);
  return sources;
}
