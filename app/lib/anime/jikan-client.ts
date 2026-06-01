/**
 * Shared Jikan (MAL) v4 client for the /anime pages.
 *
 * Jikan rate limits: 3 req/s (burst returns 429). This module serializes every
 * request through a single queue so listing, details, and watch pages cooperate
 * instead of stampeding the API.
 *
 * Two-tier cache:
 *   - detailCache (30 min, 500 entries) for /full, /episodes, /characters,
 *     /recommendations — stable data that rarely changes
 *   - listCache  (5 min,  200 entries) for listings, search, seasonal pages —
 *     volatile data that shifts with airing schedules
 *
 * Works both client-side (browser) and server-side (Next.js SSR /
 * generateMetadata). On the server the module-level caches are shared across
 * requests, acting as a built-in server-side cache layer.
 *
 * Exponential backoff on 429: 1s → 2s → 4s → 8s (max 3 retries).
 */

import { BoundedCache } from './bounded-cache';

export const JIKAN_BASE = 'https://api.jikan.moe/v4';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface JikanImageSet {
  jpg?: {
    image_url?: string;
    small_image_url?: string;
    large_image_url?: string;
  };
  webp?: {
    image_url?: string;
    small_image_url?: string;
    large_image_url?: string;
  };
}

export interface JikanGenre {
  mal_id: number;
  name: string;
  type?: string;
}

export interface JikanStudio {
  mal_id: number;
  name: string;
}

export interface JikanRelation {
  relation: string;
  entry: Array<{ mal_id: number; name: string; type: string }>;
}

export interface JikanTrailer {
  youtube_id?: string | null;
  url?: string | null;
  embed_url?: string | null;
  images?: {
    image_url?: string;
    maximum_image_url?: string;
  };
}

export interface JikanTheme {
  openings?: string[];
  endings?: string[];
}

export interface JikanAnime {
  mal_id: number;
  title: string;
  title_english: string | null;
  title_japanese?: string | null;
  type: string;
  source?: string;
  episodes: number | null;
  status: string;
  airing?: boolean;
  duration?: string;
  rating?: string;
  score: number | null;
  scored_by?: number | null;
  rank?: number | null;
  popularity?: number | null;
  members?: number | null;
  favorites?: number | null;
  synopsis: string | null;
  background?: string | null;
  season?: string | null;
  year: number | null;
  images: JikanImageSet;
  genres: JikanGenre[];
  themes?: JikanGenre[];
  demographics?: JikanGenre[];
  studios?: JikanStudio[];
  trailer?: JikanTrailer;
  aired?: { from: string | null; to: string | null; string: string };
  relations?: JikanRelation[];
  theme?: JikanTheme;
}

export interface JikanEpisode {
  mal_id: number;
  title: string;
  title_japanese?: string | null;
  title_romanji?: string | null;
  aired?: string | null;
  score?: number | null;
  filler?: boolean;
  recap?: boolean;
}

export interface JikanCharacter {
  character: {
    mal_id: number;
    name: string;
    images: JikanImageSet;
  };
  role: string;
  voice_actors?: Array<{
    person: { mal_id: number; name: string; images: JikanImageSet };
    language: string;
  }>;
}

export interface JikanRecommendation {
  entry: {
    mal_id: number;
    title: string;
    images: JikanImageSet;
  };
  votes?: number;
}

// ─── Normalized card shape used by listing/grid/recommendation UIs ──────────

export interface AnimeCard {
  mal_id: number;
  title: string;
  title_english: string | null;
  image: string;
  score: number | null;
  year: number | null;
  episodes: number | null;
  type: string;
}

export function toCard(a: any): AnimeCard | null {
  if (!a?.mal_id) return null;
  return {
    mal_id: a.mal_id,
    title: a.title || 'Unknown',
    title_english: a.title_english || null,
    image:
      a.images?.webp?.large_image_url ||
      a.images?.jpg?.large_image_url ||
      a.images?.jpg?.image_url ||
      '',
    score: a.score ?? null,
    year: a.year ?? null,
    episodes: a.episodes ?? null,
    type: a.type || 'TV',
  };
}

// ─── Two-tier cache ─────────────────────────────────────────────────────────
//
// Detail cache: 30 min TTL for stable data (anime details, episodes,
// characters, recommendations don't change day-to-day).
// List cache: 5 min TTL for volatile data (seasonal, airing, search results).

const detailCache = new BoundedCache<string, unknown>(500, 30 * 60_000);
const listCache   = new BoundedCache<string, unknown>(200,  5 * 60_000);

const DETAIL_PATTERNS = ['/full', '/episodes', '/characters', '/recommendations'];

function getCache(endpoint: string): BoundedCache<string, unknown> {
  for (const p of DETAIL_PATTERNS) {
    if (endpoint.includes(p)) return detailCache;
  }
  return listCache;
}

// ─── Rate-limited queue (serialized, ~3 req/s) ──────────────────────────────
//
// Single-flight serialization keeps the implementation small. Empirically
// Jikan returns 429 if more than 3 requests fire within a sliding second.
// We cap at one every 333ms (3/sec). Works on both client and server.

const MIN_INTERVAL_MS = 400; // 2.5 req/s — Jikan hard-caps at 3/s; 400ms leaves headroom
let lastRequestAt = 0;
let chain: Promise<void> = Promise.resolve();

async function scheduled<T>(fn: () => Promise<T>): Promise<T> {
  const release = chain;
  let releaseNext!: () => void;
  chain = new Promise<void>((res) => { releaseNext = res; });

  try {
    await release;
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return await fn();
  } finally {
    releaseNext();
  }
}

// ─── Exponential-backoff fetch (429 handling) ───────────────────────────────
//
// On 429: wait 1s, retry. If still 429: wait 2s, retry. Then 4s, then 8s.
// Non-429 errors or non-ok responses after retries return null.

async function fetchWithRetry(
  url: string,
  signal?: AbortSignal,
  retries = 3,
): Promise<Response | null> {
  let res: Response;
  try {
    res = await fetch(url, { signal: signal ?? AbortSignal.timeout(15000) });
  } catch {
    return null;
  }

  if (res.ok) return res;
  if (res.status !== 429 || retries <= 0) return null;

  // Exponential backoff: 1s, 2s, 4s, 8s
  const delay = 1000 * Math.pow(2, 3 - retries);
  console.warn(`[jikan] 429 — backing off ${delay}ms (${retries} retries left)`);
  await new Promise((r) => setTimeout(r, delay));
  return fetchWithRetry(url, signal, retries - 1);
}

// ─── Core fetch ─────────────────────────────────────────────────────────────

async function jikanRaw(endpoint: string, signal?: AbortSignal): Promise<any> {
  const cache = getCache(endpoint);
  const cached = cache.get(endpoint);
  if (cached !== undefined) return cached;

  const url = `${JIKAN_BASE}${endpoint}`;

  const data = await scheduled(async () => {
    const res = await fetchWithRetry(url, signal);
    if (!res) return null;
    try {
      return await res.json();
    } catch {
      return null;
    }
  });

  if (data) cache.set(endpoint, data);
  return data;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Fetch a Jikan list endpoint and return mapped AnimeCards. */
export async function jikanList(endpoint: string, signal?: AbortSignal): Promise<AnimeCard[]> {
  try {
    const json = await jikanRaw(endpoint, signal);
    return (json?.data || [])
      .map(toCard)
      .filter((x: AnimeCard | null): x is AnimeCard => x !== null);
  } catch {
    return [];
  }
}

/** Fetch a single anime by MAL ID using /anime/{id}/full.
 *  Works on both client and server (generateMetadata, SSR). */
export async function jikanFull(malId: number, signal?: AbortSignal): Promise<JikanAnime | null> {
  try {
    const json = await jikanRaw(`/anime/${malId}/full`, signal);
    return (json?.data as JikanAnime) || null;
  } catch {
    return null;
  }
}

/**
 * Fetch every page of /anime/{id}/episodes. Most TV series fit one page (100
 * items); long-runners need multiple. Cap at 8 pages (~800 eps) for safety.
 */
export async function jikanEpisodes(malId: number, signal?: AbortSignal): Promise<JikanEpisode[]> {
  const all: JikanEpisode[] = [];
  for (let page = 1; page <= 8; page++) {
    const json = await jikanRaw(`/anime/${malId}/episodes?page=${page}`, signal);
    const items: JikanEpisode[] = json?.data || [];
    if (items.length === 0) break;
    all.push(...items);
    if (!json?.pagination?.has_next_page) break;
  }
  return all;
}

/** Fetch /anime/{id}/characters. */
export async function jikanCharacters(
  malId: number,
  signal?: AbortSignal,
): Promise<JikanCharacter[]> {
  try {
    const json = await jikanRaw(`/anime/${malId}/characters`, signal);
    return (json?.data as JikanCharacter[]) || [];
  } catch {
    return [];
  }
}

/** Fetch /anime/{id}/recommendations. */
export async function jikanRecommendations(
  malId: number,
  signal?: AbortSignal,
): Promise<AnimeCard[]> {
  try {
    const json = await jikanRaw(`/anime/${malId}/recommendations`, signal);
    const items = (json?.data as JikanRecommendation[]) || [];
    return items
      .map((r) => toCard(r.entry))
      .filter((x): x is AnimeCard => x !== null);
  } catch {
    return [];
  }
}

/** Search anime by title. */
export async function jikanSearch(query: string, signal?: AbortSignal): Promise<AnimeCard[]> {
  if (!query.trim()) return [];
  const q = encodeURIComponent(query.trim());
  return jikanList(`/anime?q=${q}&limit=20&sfw=true&order_by=popularity&sort=desc`, signal);
}

// ─── Genre map (MAL IDs) ────────────────────────────────────────────────────

export const GENRES: Array<{ name: string; id: number }> = [
  { name: 'Action', id: 1 },
  { name: 'Adventure', id: 2 },
  { name: 'Comedy', id: 4 },
  { name: 'Drama', id: 8 },
  { name: 'Fantasy', id: 10 },
  { name: 'Horror', id: 14 },
  { name: 'Mystery', id: 7 },
  { name: 'Romance', id: 22 },
  { name: 'Sci-Fi', id: 24 },
  { name: 'Slice of Life', id: 36 },
  { name: 'Sports', id: 30 },
  { name: 'Supernatural', id: 37 },
  { name: 'Thriller', id: 41 },
];
