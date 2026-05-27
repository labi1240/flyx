import { Metadata } from 'next';
import { Suspense } from 'react';
import BrowsePageClient from './BrowsePageClient';
import { fetchTMDBData } from '@/app/lib/services/tmdb';

export const metadata: Metadata = {
  title: 'Browse | FlyX',
  description: 'Browse all content on FlyX',
};

export const revalidate = 3600;

// Fetch multiple pages to get more content (40 items = 2 pages of 20)
const PAGES_TO_FETCH = 2;

interface BrowsePageProps {
  searchParams: Promise<{ type?: string; filter?: string; genre?: string; page?: string; region?: string }>;
}

// ─── AniList GraphQL query for anime browse ──────────────────────

const ANILIST_BROWSE_QUERY = `
  query ($page: Int, $perPage: Int, $sort: [MediaSort], $status: MediaStatus, $format: MediaFormat, $genre: String) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { total }
      media(type: ANIME, sort: $sort, status: $status, format: $format, genre: $genre) {
        id idMal
        title { romaji english native }
        format status episodes
        averageScore meanScore popularity
        description(asHtml: false)
        season seasonYear
        startDate { year month day }
        coverImage { extraLarge large medium }
        genres
      }
    }
  }
`;

interface RawAniListMedia {
  id: number;
  idMal: number | null;
  title: { romaji: string | null; english: string | null; native: string | null };
  format: string | null;
  status: string | null;
  episodes: number | null;
  averageScore: number | null;
  meanScore: number | null;
  popularity: number | null;
  description: string | null;
  season: string | null;
  seasonYear: number | null;
  startDate: { year: number | null } | null;
  coverImage: { extraLarge: string | null; large: string | null; medium: string | null };
  genres: string[];
}

async function fetchAniListBrowse(variables: Record<string, unknown>): Promise<{ items: any[]; total: number }> {
  try {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: ANILIST_BROWSE_QUERY, variables }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { items: [], total: 0 };
    const json = await res.json();
    const media = json?.data?.Page?.media as RawAniListMedia[] | undefined;
    const total = json?.data?.Page?.pageInfo?.total ?? 0;
    if (!media?.length) return { items: [], total: 0 };

    const items = media
      .filter(m => m.idMal)
      .map(m => ({
        id: m.idMal!,
        title: m.title?.english || m.title?.romaji || 'Unknown',
        name: m.title?.romaji || m.title?.english || 'Unknown',
        poster_path: undefined,
        imageUrl: m.coverImage?.extraLarge || m.coverImage?.large || '',
        overview: m.description?.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?[^>]+>/g, '').trim() || undefined,
        vote_average: m.averageScore != null ? Math.round(m.averageScore) / 10 : undefined,
        year: m.seasonYear || m.startDate?.year || undefined,
        episodes: m.episodes ?? undefined,
        format: m.format ?? undefined,
        mediaType: m.format === 'MOVIE' ? 'movie' : 'tv',
      }));
    return { items, total };
  } catch {
    return { items: [], total: 0 };
  }
}

async function getBrowseData(type: string, filter: string, genre: string, page: number, region: string) {
  try {
    // ── Anime: use AniList ──
    if (type === 'anime' || type === 'anime-movies') {
      const perPage = 25 * PAGES_TO_FETCH;
      const isMovies = type === 'anime-movies';
      const variables: Record<string, unknown> = {
        page,
        perPage,
        sort: ['POPULARITY_DESC'],
        format: isMovies ? 'MOVIE' : undefined,
      };

      if (!isMovies) {
        if (filter === 'top_rated') {
          variables.sort = ['SCORE_DESC'];
        } else if (filter === 'airing') {
          variables.status = 'RELEASING';
        }
        if (genre && !filter) variables.genre = genre.charAt(0).toUpperCase() + genre.slice(1);
      }

      const result = await fetchAniListBrowse(variables);
      const totalPages = Math.min(Math.ceil(result.total / perPage), 250);
      return { items: result.items, total: result.total, page, totalPages };
    }

    // ── Movies / TV: use TMDB ──
    let endpoint = '';
    let params: Record<string, string> = {};

    if (type === 'movie') {
      if (region || genre) {
        endpoint = '/discover/movie';
        params.sort_by = 'popularity.desc';
        if (region) params.with_origin_country = region;
        if (genre) params.with_genres = genre;
        if (filter === 'top_rated') {
          params.sort_by = 'vote_average.desc';
          params['vote_count.gte'] = '200';
        } else if (filter === 'now_playing') {
          const today = new Date().toISOString().split('T')[0];
          const monthAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0];
          params['primary_release_date.gte'] = monthAgo;
          params['primary_release_date.lte'] = today;
        }
      } else if (filter === 'popular') {
        endpoint = '/movie/popular';
      } else if (filter === 'top_rated') {
        endpoint = '/movie/top_rated';
      } else if (filter === 'now_playing') {
        endpoint = '/movie/now_playing';
      } else {
        endpoint = '/movie/popular';
      }
    } else if (type === 'tv') {
      endpoint = '/discover/tv';
      params.without_genres = '16';
      params.sort_by = 'popularity.desc';

      if (region) params.with_origin_country = region;

      if (filter === 'top_rated') {
        params.sort_by = 'vote_average.desc';
        params['vote_count.gte'] = '200';
      } else if (filter === 'on_the_air') {
        params['air_date.gte'] = new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0];
      } else if (filter === 'airing_today') {
        const today = new Date().toISOString().split('T')[0];
        params['air_date.gte'] = today;
        params['air_date.lte'] = today;
      }

      if (genre) {
        params.with_genres = genre;
      }
    }

    if (!endpoint) {
      return { items: [], total: 0, page: 1, totalPages: 0 };
    }

    // Fetch multiple pages for more content
    const startPage = (page - 1) * PAGES_TO_FETCH + 1;
    const pagePromises = [];
    for (let i = 0; i < PAGES_TO_FETCH; i++) {
      pagePromises.push(fetchTMDBData(endpoint, { ...params, page: (startPage + i).toString() }));
    }

    const results = await Promise.all(pagePromises);
    const mediaType = type === 'movie' ? 'movie' : 'tv';

    // Combine results from all pages and deduplicate
    const allItems = results.flatMap(data =>
      data?.results?.map((item: any) => ({ ...item, mediaType })) || []
    ).filter((item, index, self) =>
      self.findIndex(i => i.id === item.id && i.mediaType === item.mediaType) === index
    );

    const firstResult = results[0];
    const totalResults = firstResult?.total_results || 0;
    const totalPages = Math.min(Math.ceil((firstResult?.total_pages || 0) / PAGES_TO_FETCH), 250);

    return {
      items: allItems,
      total: totalResults,
      page: page,
      totalPages: totalPages,
    };
  } catch (error) {
    console.error('Error fetching browse data:', error);
    return { items: [], total: 0, page: 1, totalPages: 0 };
  }
}

function getPageTitle(type: string, filter: string, genre: string): string {
  const titles: Record<string, Record<string, string>> = {
    movie: {
      popular: '🔥 Popular Movies',
      top_rated: '⭐ Top Rated Movies',
      now_playing: '🎬 Now Playing',
      '28': '💥 Action Movies',
      '12': '🗡️ Adventure Movies',
      '35': '😂 Comedy Movies',
      '18': '🎭 Drama Movies',
      '27': '👻 Horror Movies',
      '53': '😱 Thriller Movies',
      '878': '🚀 Sci-Fi Movies',
      '14': '✨ Fantasy Movies',
      '10749': '💕 Romance Movies',
      '9648': '🔍 Mystery Movies',
      '10751': '👨‍👩‍👧‍👦 Family Movies',
      '99': '📹 Documentary Movies',
    },
    tv: {
      popular: '🔥 Popular Series',
      top_rated: '⭐ Top Rated Series',
      on_the_air: '📡 On The Air',
      airing_today: '📺 Airing Today',
      '18': '🎭 Drama Series',
      '80': '🔍 Crime Series',
      '9648': '🔎 Mystery Series',
      '10759': '💥 Action & Adventure',
      '10765': '🚀 Sci-Fi & Fantasy',
      '35': '😂 Comedy Series',
      '99': '📹 Documentary Series',
      '10764': '📺 Reality TV',
      '10751': '👨‍👩‍👧‍👦 Family Series',
      '37': '🤠 Western Series',
      '10768': '⚔️ War & Politics',
    },
    anime: {
      popular: '🔥 Popular Anime',
      top_rated: '⭐ Top Rated Anime',
      airing: '📺 Currently Airing',
      action: '⚔️ Action Anime',
      fantasy: '✨ Fantasy Anime',
      romance: '💕 Romance Anime',
    },
    'anime-movies': {
      popular: '🎬 Anime Movies',
    },
  };

  return titles[type]?.[filter] || titles[type]?.[genre] || 'Browse';
}

export default async function BrowsePage({ searchParams }: BrowsePageProps) {
  const params = await searchParams;
  const type = params.type || 'movie';
  const filter = params.filter || 'popular';
  const genre = params.genre || '';
  const page = parseInt(params.page || '1', 10);
  const region = params.region || '';

  const data = await getBrowseData(type, filter, genre, page, region);
  const title = getPageTitle(type, filter, genre);

  return (
    <Suspense fallback={<div className="min-h-screen bg-black" />}>
      <BrowsePageClient
        items={data.items}
        total={data.total}
        currentPage={data.page}
        totalPages={data.totalPages}
        title={title}
        type={type}
        filter={filter}
        genre={genre}
      />
    </Suspense>
  );
}
