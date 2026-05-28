/**
 * Shared Jikan (MAL) v4 client for the /anime client pages.
 *
 * Jikan rate limit: 3 req/s (anything beyond burst returns 429).
 * This module funnels every request through a single queue so the listing,
 * details, and watch pages cooperate instead of stampeding the API.
 *
 * Also exposes a small in-memory LRU cache so revisiting a recently viewed
 * page does not re-hit the API.
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

// ─── Rate-limited queue (3 req/s, 1 in-flight at a time) ────────────────────
//
// Single-flight serialization keeps the implementation tiny and is enough to
// stay under Jikan's burst limit. Empirically the API returns 429 if more
// than 3 requests fire within a sliding second; we cap at one every ~340ms.

const MIN_INTERVAL_MS = 350;
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

// ─── Cache + fetch ──────────────────────────────────────────────────────────

const cache = new BoundedCache<string, unknown>(200, 5 * 60_000);

async function jikanRaw(endpoint: string, signal?: AbortSignal): Promise<any> {
  const cached = cache.get(endpoint);
  if (cached !== undefined) return cached;

  const data = await scheduled(async () => {
    const res = await fetch(`${JIKAN_BASE}${endpoint}`, {
      signal: signal ?? AbortSignal.timeout(15000),
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1200));
      const retry = await fetch(`${JIKAN_BASE}${endpoint}`, {
        signal: signal ?? AbortSignal.timeout(15000),
      });
      if (!retry.ok) return null;
      return retry.json();
    }
    if (!res.ok) return null;
    return res.json();
  });

  if (data) cache.set(endpoint, data);
  return data;
}

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

/** Fetch a single anime by MAL ID using /anime/{id}/full. */
export async function jikanFull(malId: number, signal?: AbortSignal): Promise<JikanAnime | null> {
  try {
    const json = await jikanRaw(`/anime/${malId}/full`, signal);
    return (json?.data as JikanAnime) || null;
  } catch {
    return null;
  }
}

/** Fetch a single anime by MAL ID using /anime/{id}. */
export async function jikanGet(malId: number, signal?: AbortSignal): Promise<JikanAnime | null> {
  try {
    const json = await jikanRaw(`/anime/${malId}`, signal);
    return (json?.data as JikanAnime) || null;
  } catch {
    return null;
  }
}

/**
 * Fetch every page of /anime/{id}/episodes. Most TV series fit one page (100
 * items); long-runners need multiple. We cap at 8 pages (~800 eps) for safety.
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

/** Fetch /anime/{id}/characters (top-N by main role on consumer side). */
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
