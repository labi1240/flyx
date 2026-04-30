/**
 * AniList GraphQL Client
 *
 * Replacement for the Jikan (api.jikan.moe) backend, which has a chronic
 * MongoDB outage that 500s ~87% of requests. AniList is a stable GraphQL
 * service at graphql.anilist.co that exposes MAL IDs via the `idMal` field,
 * so we can continue to key everything off MAL IDs.
 *
 * This module returns data in the shape Jikan returned it (MALAnime,
 * MALSearchResult, MALListingResponse, etc.) so the rest of the app can
 * keep using those types without changes.
 */

import type {
  MALAnime,
  MALSearchResult,
  MALEpisode,
} from '../anime/mal-types';

const ANILIST_URL = 'https://graphql.anilist.co';

// ============================================================================
// GraphQL Types (raw responses from AniList)
// ============================================================================

export interface AniListMedia {
  id: number;
  idMal: number | null;
  title: {
    romaji: string | null;
    english: string | null;
    native: string | null;
  };
  type: 'ANIME';
  format: AniListFormat | null;
  status: AniListStatus | null;
  episodes: number | null;
  duration: number | null;
  averageScore: number | null;
  meanScore: number | null;
  popularity: number | null;
  favourites: number | null;
  description: string | null;
  season: AniListSeason | null;
  seasonYear: number | null;
  startDate: AniListFuzzyDate;
  endDate: AniListFuzzyDate;
  coverImage: {
    extraLarge: string | null;
    large: string | null;
    medium: string | null;
  };
  bannerImage: string | null;
  genres: string[];
  studios: {
    nodes: Array<{ id: number; name: string; isAnimationStudio?: boolean }>;
  };
  relations?: {
    edges: Array<{
      relationType: AniListRelationType;
      node: {
        id: number;
        idMal: number | null;
        type: 'ANIME' | 'MANGA';
        format: AniListFormat | null;
        title: { romaji: string | null; english: string | null };
      };
    }>;
  };
  streamingEpisodes?: Array<{
    title: string | null;
    thumbnail: string | null;
    url: string | null;
    site: string | null;
  }>;
}

type AniListFormat = 'TV' | 'TV_SHORT' | 'MOVIE' | 'SPECIAL' | 'OVA' | 'ONA' | 'MUSIC';
type AniListStatus = 'FINISHED' | 'RELEASING' | 'NOT_YET_RELEASED' | 'CANCELLED' | 'HIATUS';
type AniListSeason = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';
type AniListRelationType =
  | 'ADAPTATION' | 'PREQUEL' | 'SEQUEL' | 'PARENT' | 'SIDE_STORY'
  | 'CHARACTER' | 'SUMMARY' | 'ALTERNATIVE' | 'SPIN_OFF' | 'OTHER'
  | 'SOURCE' | 'COMPILATION' | 'CONTAINS';

interface AniListFuzzyDate {
  year: number | null;
  month: number | null;
  day: number | null;
}

// ============================================================================
// Rate limiting + retry
// AniList: 90 requests/min/IP. We use a proper queue-based throttle that
// allows parallel requests while respecting the rate limit.
// For batch operations (like the anime page loading 7 categories), requests
// fire in parallel but are spaced ~100ms apart to stay well under the limit.
// ============================================================================

let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 100; // 100ms between requests = max 600/min, well under 90/min limit
let requestQueue: Promise<void> = Promise.resolve();

async function throttle(): Promise<void> {
  // Chain onto the queue so parallel calls are properly spaced
  const myTurn = requestQueue.then(async () => {
    const elapsed = Date.now() - lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL) {
      await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - elapsed));
    }
    lastRequestTime = Date.now();
  });
  requestQueue = myTurn;
  await myTurn;
}

export async function anilistQuery<T = any>(
  query: string,
  variables: Record<string, any> = {},
): Promise<T | null> {
  await throttle();

  try {
    const res = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(10000),
      next: { revalidate: 3600 },
    });

    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '1');
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        return anilistQuery<T>(query, variables);
      }
      console.error(`[AniList] HTTP ${res.status}`);
      return null;
    }

    const json = await res.json() as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) {
      const msg = json.errors.map(e => e.message).join('; ');
      // "Not Found" is a normal outcome (e.g. malId not in AniList), not an error
      if (!/not found/i.test(msg)) {
        console.error('[AniList] GraphQL errors:', msg);
      }
      return null;
    }
    return json.data ?? null;
  } catch (error) {
    console.error('[AniList] Request error:', error instanceof Error ? error.message : error);
    return null;
  }
}

// ============================================================================
// Mappers: AniList → Jikan-shaped
// ============================================================================

const FORMAT_MAP: Record<AniListFormat, string> = {
  TV: 'TV',
  TV_SHORT: 'TV',
  MOVIE: 'Movie',
  SPECIAL: 'Special',
  OVA: 'OVA',
  ONA: 'ONA',
  MUSIC: 'Music',
};

const STATUS_MAP: Record<AniListStatus, string> = {
  FINISHED: 'Finished Airing',
  RELEASING: 'Currently Airing',
  NOT_YET_RELEASED: 'Not yet aired',
  CANCELLED: 'Cancelled',
  HIATUS: 'Hiatus',
};

const SEASON_MAP: Record<AniListSeason, string> = {
  WINTER: 'winter',
  SPRING: 'spring',
  SUMMER: 'summer',
  FALL: 'fall',
};

function fuzzyDateToISO(d: AniListFuzzyDate | null | undefined): string | null {
  if (!d || !d.year) return null;
  const year = String(d.year).padStart(4, '0');
  const month = d.month ? String(d.month).padStart(2, '0') : '01';
  const day = d.day ? String(d.day).padStart(2, '0') : '01';
  return `${year}-${month}-${day}T00:00:00+00:00`;
}

function fuzzyDateToString(d: AniListFuzzyDate | null | undefined): string {
  if (!d || !d.year) return '';
  const month = d.month ? String(d.month) : '';
  const day = d.day ? String(d.day) : '';
  if (!month) return String(d.year);
  return `${month}/${day || '1'}/${d.year}`;
}

function airedString(start?: AniListFuzzyDate | null, end?: AniListFuzzyDate | null): string {
  const s = fuzzyDateToString(start);
  const e = fuzzyDateToString(end);
  if (!s && !e) return '';
  if (s && e) return `${s} to ${e}`;
  if (s) return `${s} to ?`;
  return `? to ${e}`;
}

function stripHtml(html: string | null): string | null {
  if (!html) return null;
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function toScore10(anilistScore: number | null): number | null {
  if (anilistScore == null) return null;
  return Math.round(anilistScore) / 10;
}

export function anilistMediaToMALAnime(m: AniListMedia): MALAnime | null {
  if (!m.idMal) return null;
  const title = m.title.romaji || m.title.english || m.title.native || 'Unknown';
  const coverLarge = m.coverImage.extraLarge || m.coverImage.large || m.coverImage.medium || '';
  const coverSmall = m.coverImage.medium || m.coverImage.large || '';
  return {
    mal_id: m.idMal,
    title,
    title_english: m.title.english,
    title_japanese: m.title.native,
    type: m.format ? FORMAT_MAP[m.format] : 'Unknown',
    episodes: m.episodes,
    status: m.status ? STATUS_MAP[m.status] : 'Unknown',
    score: toScore10(m.averageScore ?? m.meanScore),
    scored_by: null,
    rank: null,
    popularity: m.popularity,
    members: m.popularity, // AniList doesn't distinguish; popularity is closest analogue
    synopsis: stripHtml(m.description),
    season: m.season ? SEASON_MAP[m.season] : null,
    year: m.seasonYear || m.startDate?.year || null,
    images: {
      jpg: { image_url: coverSmall, large_image_url: coverLarge },
      webp: { image_url: coverSmall, large_image_url: coverLarge },
    },
    aired: {
      from: fuzzyDateToISO(m.startDate),
      to: fuzzyDateToISO(m.endDate),
      string: airedString(m.startDate, m.endDate),
    },
    genres: m.genres.map((g, i) => ({ mal_id: i, name: g })),
    studios: (m.studios?.nodes || []).map(s => ({ mal_id: s.id, name: s.name })),
  };
}

export function anilistMediaToMALSearchResult(m: AniListMedia): MALSearchResult | null {
  if (!m.idMal) return null;
  const coverLarge = m.coverImage.extraLarge || m.coverImage.large || m.coverImage.medium || '';
  const coverSmall = m.coverImage.medium || m.coverImage.large || '';
  return {
    mal_id: m.idMal,
    title: m.title.romaji || m.title.english || m.title.native || 'Unknown',
    title_english: m.title.english,
    type: m.format ? FORMAT_MAP[m.format] : 'Unknown',
    episodes: m.episodes,
    score: toScore10(m.averageScore ?? m.meanScore),
    images: {
      jpg: { image_url: coverSmall, large_image_url: coverLarge },
    },
  };
}

// ============================================================================
// Public API: matches Jikan operations used by the app
// ============================================================================

const MEDIA_CORE_FIELDS = `
  id
  idMal
  title { romaji english native }
  type
  format
  status
  episodes
  duration
  averageScore
  meanScore
  popularity
  favourites
  description(asHtml: false)
  season
  seasonYear
  startDate { year month day }
  endDate { year month day }
  coverImage { extraLarge large medium }
  bannerImage
  genres
  studios(isMain: true) { nodes { id name isAnimationStudio } }
`;

// Short-TTL cache for Media(idMal) lookups. Functions like collectSequelChain
// hit getAnimeByMalId and getAnimeRelations for the same id back-to-back; this
// prevents duplicate round-trips.
const mediaCache = new Map<number, { media: AniListMedia; ts: number }>();
const MEDIA_CACHE_TTL = 30 * 60 * 1000;

/** Get one anime by MAL ID (includes relations). Cached for 30m. */
export async function getAnimeByMalId(malId: number): Promise<AniListMedia | null> {
  const cached = mediaCache.get(malId);
  if (cached && Date.now() - cached.ts < MEDIA_CACHE_TTL) {
    return cached.media;
  }

  const query = `
    query ($malId: Int) {
      Media(idMal: $malId, type: ANIME) {
        ${MEDIA_CORE_FIELDS}
        relations {
          edges {
            relationType
            node {
              id idMal type format
              title { romaji english }
            }
          }
        }
      }
    }
  `;
  const data = await anilistQuery<{ Media: AniListMedia | null }>(query, { malId });
  const media = data?.Media ?? null;
  if (media) mediaCache.set(malId, { media, ts: Date.now() });
  return media;
}

/** Search anime by title query. */
export async function searchAnime(query: string, limit: number = 10): Promise<AniListMedia[]> {
  const gql = `
    query ($search: String, $perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        media(search: $search, type: ANIME, sort: [SEARCH_MATCH, POPULARITY_DESC]) {
          ${MEDIA_CORE_FIELDS}
        }
      }
    }
  `;
  const data = await anilistQuery<{ Page: { media: AniListMedia[] } }>(gql, {
    search: query,
    perPage: Math.min(limit, 50),
  });
  return data?.Page?.media ?? [];
}

export interface ListingSort {
  sort: 'POPULARITY_DESC' | 'SCORE_DESC' | 'TRENDING_DESC' | 'START_DATE_DESC' | 'FAVOURITES_DESC';
  status?: AniListStatus;
  format?: AniListFormat;
  genre?: string;
  season?: AniListSeason;
  seasonYear?: number;
}

/** Fetch a paginated listing with filters. */
export async function fetchListing(
  opts: ListingSort,
  page: number = 1,
  perPage: number = 25,
): Promise<{ items: AniListMedia[]; pageInfo: { hasNextPage: boolean; lastPage: number; total: number } }> {
  const gql = `
    query ($page: Int, $perPage: Int, $sort: [MediaSort], $status: MediaStatus, $format: MediaFormat, $genre: String, $season: MediaSeason, $seasonYear: Int) {
      Page(page: $page, perPage: $perPage) {
        pageInfo { hasNextPage lastPage currentPage perPage total }
        media(
          type: ANIME
          sort: $sort
          status: $status
          format: $format
          genre: $genre
          season: $season
          seasonYear: $seasonYear
        ) {
          ${MEDIA_CORE_FIELDS}
        }
      }
    }
  `;
  const variables: Record<string, any> = {
    page,
    perPage,
    sort: [opts.sort],
  };
  if (opts.status) variables.status = opts.status;
  if (opts.format) variables.format = opts.format;
  if (opts.genre) variables.genre = opts.genre;
  if (opts.season) variables.season = opts.season;
  if (opts.seasonYear) variables.seasonYear = opts.seasonYear;

  const data = await anilistQuery<{
    Page: {
      pageInfo: { hasNextPage: boolean; lastPage: number; currentPage: number; perPage: number; total: number };
      media: AniListMedia[];
    };
  }>(gql, variables);

  if (!data?.Page) {
    return { items: [], pageInfo: { hasNextPage: false, lastPage: 1, total: 0 } };
  }
  return {
    items: data.Page.media,
    pageInfo: {
      hasNextPage: data.Page.pageInfo.hasNextPage,
      lastPage: data.Page.pageInfo.lastPage,
      total: data.Page.pageInfo.total,
    },
  };
}

/**
 * AniList Genre strings (matches AniList's genre taxonomy).
 * The app uses Jikan numeric genre IDs; we translate here.
 * Only mappings we actually care about are listed.
 */
export const JIKAN_GENRE_ID_TO_ANILIST: Record<number, string> = {
  1: 'Action',
  2: 'Adventure',
  4: 'Comedy',
  7: 'Mystery',
  8: 'Drama',
  10: 'Fantasy',
  14: 'Horror',
  22: 'Romance',
  24: 'Sci-Fi',
  30: 'Sports',
  36: 'Slice of Life',
  37: 'Supernatural',
  41: 'Thriller',
};

/**
 * Build synthetic MALEpisode list from the anime's episode count.
 * AniList doesn't expose per-episode titles/filler flags the way Jikan does,
 * so we fabricate episode stubs. The app uses this for episode selection UIs
 * only — users pick an episode number, the title/filler metadata is decorative.
 */
export function syntheticEpisodesForAnime(episodeCount: number | null): MALEpisode[] {
  if (!episodeCount || episodeCount <= 0) return [];
  return Array.from({ length: episodeCount }, (_, i) => ({
    mal_id: i + 1,
    title: `Episode ${i + 1}`,
    title_japanese: null,
    title_romanji: null,
    aired: null,
    score: null,
    filler: false,
    recap: false,
  }));
}
