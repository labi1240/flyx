'use client';

import { useCallback, useRef, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import type { MALAnimeListItem } from '@/lib/services/mal-listings';
import { PageTransition } from '@/components/layout/PageTransition';
import { useAnalytics } from '@/components/analytics/AnalyticsProvider';
import { usePresenceContext } from '@/components/analytics/PresenceProvider';

interface CategoryData {
  items: MALAnimeListItem[];
  total: number;
}

interface AnimeData {
  airing: CategoryData;
  popular: CategoryData;
  topRated: CategoryData;
  action: CategoryData;
  fantasy: CategoryData;
  romance: CategoryData;
  movies: CategoryData;
}

interface AnimePageClientProps {
  data: AnimeData | null;
}

// 4-tier fallback for fetching anime browse data:
//   1. SSR on CF edge (handled by page.tsx — if it returns null, we fall through)
//   2. /api/content/anime-browse (CF edge, uses malListingsService)
//   3. /api/anilist/graphql proxy (CF edge but same-domain — no ad blocker)
//   4. Direct graphql.anilist.co from browser (residential IP, bypasses CF edge block)
// Tiers 2-3 may fail if AniList blocks CF edge IPs. Tier 4 may fail if
// the user has an ad blocker. Between them, one should always work.
async function fetchAniListDirect(): Promise<AnimeData | null> {
  // Try proxy first (same domain, avoids ad blockers)
  const viaProxy = await fetchAnimeData('/api/anilist/graphql');
  if (viaProxy) return viaProxy;

  // Try direct AniList call (residential IP, bypasses CF edge block)
  return fetchAnimeData('https://graphql.anilist.co');
}

const ANILIST_LISTING_QUERY = `
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
        studios(isMain: true) { nodes { id name } }
      }
    }
  }
`;

interface RawMedia {
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
  studios: { nodes: Array<{ id: number; name: string }> } | null;
}

const FORMAT_MAP: Record<string, string> = {
  TV: 'TV', TV_SHORT: 'TV', MOVIE: 'Movie', SPECIAL: 'Special', OVA: 'OVA', ONA: 'ONA', MUSIC: 'Music',
};
const STATUS_MAP: Record<string, string> = {
  FINISHED: 'Finished Airing', RELEASING: 'Currently Airing', NOT_YET_RELEASED: 'Not yet aired',
  CANCELLED: 'Cancelled', HIATUS: 'Hiatus',
};
const SEASON_MAP: Record<string, string> = {
  WINTER: 'winter', SPRING: 'spring', SUMMER: 'summer', FALL: 'fall',
};

function mapMedia(m: RawMedia): MALAnimeListItem | null {
  if (!m.idMal) return null;
  const coverLarge = m.coverImage?.extraLarge || m.coverImage?.large || m.coverImage?.medium || '';
  const coverSmall = m.coverImage?.medium || m.coverImage?.large || '';
  const score100 = m.averageScore ?? m.meanScore;
  const score = score100 != null ? Math.round(score100) / 10 : null;
  const synopsis = m.description
    ?.replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim() ?? null;

  return {
    mal_id: m.idMal,
    title: m.title?.romaji || m.title?.english || m.title?.native || 'Unknown',
    title_english: m.title?.english ?? null,
    title_japanese: m.title?.native ?? null,
    type: m.format ? (FORMAT_MAP[m.format] ?? 'Unknown') : 'Unknown',
    episodes: m.episodes ?? null,
    status: m.status ? (STATUS_MAP[m.status] ?? 'Unknown') : 'Unknown',
    airing: m.status === 'RELEASING',
    score,
    members: m.popularity ?? null,
    rank: null,
    popularity: m.popularity ?? null,
    synopsis,
    year: m.seasonYear || m.startDate?.year || null,
    season: m.season ? (SEASON_MAP[m.season] ?? null) : null,
    images: {
      jpg: { image_url: coverSmall, large_image_url: coverLarge },
      webp: { image_url: coverSmall, large_image_url: coverLarge },
    },
    genres: (m.genres || []).map((g, i) => ({ mal_id: i, name: g })),
    studios: (m.studios?.nodes || []).map(s => ({ mal_id: s.id, name: s.name })),
  };
}

async function fetchAnimeData(endpoint: string): Promise<AnimeData | null> {
  const isProxy = endpoint.startsWith('/');

  async function fetchCategory(variables: Record<string, unknown>): Promise<CategoryData> {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: ANILIST_LISTING_QUERY, variables }),
        signal: isProxy ? undefined : AbortSignal.timeout(10000),
      });
      if (!res.ok) return { items: [], total: 0 };
      const json = await res.json();
      const media = json?.data?.Page?.media as RawMedia[] | undefined;
      const total: number = json?.data?.Page?.pageInfo?.total ?? 0;
      if (!media?.length) return { items: [], total: 0 };
      return { items: media.map(mapMedia).filter((i): i is MALAnimeListItem => i !== null), total };
    } catch {
      return { items: [], total: 0 };
    }
  }

  try {
    const [airing, popular, topRated, action, fantasy, romance, movies] = await Promise.all([
      fetchCategory({ page: 1, perPage: 25, sort: ['POPULARITY_DESC'], status: 'RELEASING' }),
      fetchCategory({ page: 1, perPage: 25, sort: ['POPULARITY_DESC'] }),
      fetchCategory({ page: 1, perPage: 25, sort: ['SCORE_DESC'] }),
      fetchCategory({ page: 1, perPage: 25, sort: ['POPULARITY_DESC'], genre: 'Action' }),
      fetchCategory({ page: 1, perPage: 25, sort: ['POPULARITY_DESC'], genre: 'Fantasy' }),
      fetchCategory({ page: 1, perPage: 25, sort: ['POPULARITY_DESC'], genre: 'Romance' }),
      fetchCategory({ page: 1, perPage: 25, sort: ['POPULARITY_DESC'], format: 'MOVIE' }),
    ]);

    const hasAnyData = airing.items.length > 0 || popular.items.length > 0 ||
      topRated.items.length > 0 || movies.items.length > 0;
    if (!hasAnyData) return null;

    return { airing, popular, topRated, action, fantasy, romance, movies };
  } catch {
    return null;
  }
}

export default function AnimePageClient({ data: ssrData }: AnimePageClientProps) {
  const router = useRouter();
  const { trackEvent } = useAnalytics();
  const presenceContext = usePresenceContext();
  const [data, setData] = useState<AnimeData | null>(ssrData);
  const [loading, setLoading] = useState(!ssrData);
  const [error, setError] = useState(false);

  // Client-side fallback: call AniList directly from the browser.
  // The CF edge SSR may fail because AniList blocks datacenter IP ranges,
  // but the user's browser IP is residential — calls from here work.
  useEffect(() => {
    if (ssrData) return;
    let cancelled = false;

    async function fetchClientSide() {
      setLoading(true);
      setError(false);
      try {
        // Fetch from OUR API first (runs on CF edge, may still be blocked)
        const res = await fetch('/api/content/anime-browse', { cache: 'no-store' });
        if (!cancelled && res.ok) {
          const json = await res.json();
          if (json.success && json.data) {
            setData(json.data);
            setLoading(false);
            return;
          }
        }
        // Edge API failed — try direct AniList call from the browser
        if (cancelled) return;
        const direct = await fetchAniListDirect();
        if (cancelled) return;
        if (direct) {
          setData(direct);
        } else {
          setError(true);
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchClientSide();
    return () => { cancelled = true; };
  }, [ssrData]);

  useEffect(() => {
    if (presenceContext?.setBrowsingContext) {
      presenceContext.setBrowsingContext('Anime');
    }
  }, []);

  const handleContentClick = useCallback((item: MALAnimeListItem, source: string) => {
    trackEvent('content_clicked', { content_id: item.mal_id, source });
    router.push(`/anime/${item.mal_id}`);
  }, [router, trackEvent]);

  const handleSeeAll = useCallback((filter: string, genre?: string) => {
    const params = new URLSearchParams({ type: filter === 'movies' ? 'anime-movies' : 'anime' });
    if (filter && filter !== 'movies') params.set('filter', filter);
    if (genre) params.set('genre', genre);
    router.push(`/browse?${params.toString()}`);
  }, [router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0812] flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-fuchsia-500/30 border-t-fuchsia-400 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400">Loading anime...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-[#0a0812] flex items-center justify-center">
        <div className="text-center">
          <p className="text-white text-lg mb-2">Failed to load anime</p>
          <p className="text-gray-500 text-sm mb-4">Please check your connection and try again.</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-fuchsia-600 hover:bg-fuchsia-500 text-white rounded-lg transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const contentSections = [
    { title: 'Currently Airing', data: data.airing, filter: 'airing', accentColor: 'pink' as const },
    { title: 'Popular Anime', data: data.popular, filter: 'popular', accentColor: 'fuchsia' as const },
    { title: 'Top Rated', data: data.topRated, filter: 'top_rated', accentColor: 'purple' as const },
    { title: 'Action', data: data.action, filter: '', genre: 'action', accentColor: 'red' as const },
    { title: 'Fantasy', data: data.fantasy, filter: '', genre: 'fantasy', accentColor: 'violet' as const },
    { title: 'Romance', data: data.romance, filter: '', genre: 'romance', accentColor: 'rose' as const },
    { title: 'Anime Movies', data: data.movies, filter: 'movies', accentColor: 'amber' as const },
  ];

  return (
    <PageTransition>
      <div className="min-h-screen bg-[#0a0812] overflow-x-hidden">
        <section className="relative pt-16 md:pt-20 pb-12 md:pb-16 overflow-hidden">
          <div className="container mx-auto px-4 md:px-6 relative z-10">
            <motion.div initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} className="text-center max-w-4xl mx-auto">
              <h1 className="text-4xl md:text-5xl lg:text-7xl font-black mb-3 md:mb-4">
                <span className="bg-gradient-to-r from-pink-300 via-fuchsia-400 to-purple-400 bg-clip-text text-transparent">Anime</span>
              </h1>
              <p className="text-base md:text-lg text-gray-400 max-w-2xl mx-auto">From shonen epics to slice-of-life gems</p>
            </motion.div>
          </div>
        </section>
        <main className="pb-20 space-y-2">
          {contentSections.filter(s => s.data?.items?.length > 0).map((section) => (
            <ContentRow key={section.title} title={section.title} data={section.data} onItemClick={handleContentClick} onSeeAll={() => handleSeeAll(section.filter, section.genre)} accentColor={section.accentColor} />
          ))}
        </main>
      </div>
    </PageTransition>
  );
}

const accentColors: Record<string, { bg: string; text: string; gradient: string }> = {
  pink: { bg: 'bg-pink-500', text: 'text-pink-400', gradient: 'from-pink-600/20 to-pink-600/40' },
  fuchsia: { bg: 'bg-fuchsia-500', text: 'text-fuchsia-400', gradient: 'from-fuchsia-600/20 to-fuchsia-600/40' },
  purple: { bg: 'bg-purple-500', text: 'text-purple-400', gradient: 'from-purple-600/20 to-purple-600/40' },
  red: { bg: 'bg-red-500', text: 'text-red-400', gradient: 'from-red-600/20 to-red-600/40' },
  violet: { bg: 'bg-violet-500', text: 'text-violet-400', gradient: 'from-violet-600/20 to-violet-600/40' },
  rose: { bg: 'bg-rose-500', text: 'text-rose-400', gradient: 'from-rose-600/20 to-rose-600/40' },
  amber: { bg: 'bg-amber-500', text: 'text-amber-400', gradient: 'from-amber-600/20 to-amber-600/40' },
};

function ContentRow({ title, data, onItemClick, onSeeAll, accentColor = 'pink' }: {
  title: string; data: CategoryData; onItemClick: (item: MALAnimeListItem, source: string) => void; onSeeAll: () => void; accentColor?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const colors = accentColors[accentColor] || accentColors.pink;

  if (!data?.items?.length) return null;

  const scroll = (direction: 'left' | 'right') => {
    if (scrollRef.current) {
      const scrollAmount = scrollRef.current.clientWidth * 0.8;
      scrollRef.current.scrollBy({
        left: direction === 'left' ? -scrollAmount : scrollAmount,
        behavior: 'smooth'
      });
    }
  };

  return (
    <section className="py-4 md:py-6 px-3 md:px-6 group/section">
      <div className="container mx-auto">
        <div className="flex items-center justify-between mb-3 md:mb-5">
          <button onClick={onSeeAll} className="text-base sm:text-lg md:text-2xl font-bold text-white flex items-center gap-2 hover:opacity-80 transition-opacity">
            {title} <span className={`text-xs sm:text-sm font-normal ${colors.text}`}>({data.total.toLocaleString()})</span>
          </button>

          {/* Scroll Buttons */}
          <div className="hidden md:flex gap-1.5 md:gap-2">
            <button
              onClick={() => scroll('left')}
              className="w-8 h-8 md:w-9 md:h-9 bg-white/5 hover:bg-white/10 active:bg-white/15 border border-white/10 rounded-full flex items-center justify-center text-white transition-all text-base md:text-lg font-bold"
              data-tv-skip="true"
              tabIndex={-1}
            >
              ‹
            </button>
            <button
              onClick={() => scroll('right')}
              className="w-8 h-8 md:w-9 md:h-9 bg-white/5 hover:bg-white/10 active:bg-white/15 border border-white/10 rounded-full flex items-center justify-center text-white transition-all text-base md:text-lg font-bold"
              data-tv-skip="true"
              tabIndex={-1}
            >
              ›
            </button>
          </div>
        </div>

        <div className="relative">
          <div
            ref={scrollRef}
            className="flex gap-3 overflow-x-auto scrollbar-hide pb-4"
            style={{ scrollbarWidth: 'none' }}
          >
            {data.items.map((item) => (
              <motion.div
                key={item.mal_id}
                initial={{ opacity: 0 }}
                whileInView={{ opacity: 1 }}
                viewport={{ once: true }}
                onClick={() => onItemClick(item, title)}
                className="flex-shrink-0 w-[120px] sm:w-32 md:w-36 lg:w-44 cursor-pointer group"
              >
                <div className="relative rounded-lg overflow-hidden bg-gray-900 shadow-lg transition-all duration-300 group-hover:scale-105 group-hover:shadow-xl group-hover:shadow-pink-500/20">
                  <img
                    src={item.images?.jpg?.large_image_url || '/placeholder-poster.jpg'}
                    alt={item.title || ''}
                    className="w-full aspect-[2/3] object-cover transition-transform duration-300 group-hover:scale-110"
                    loading="lazy"
                  />

                  {/* Hover overlay with play button */}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className={`w-12 h-12 rounded-full bg-gradient-to-r ${colors.gradient} backdrop-blur-sm flex items-center justify-center border border-white/20 transform scale-0 group-hover:scale-100 transition-transform duration-300`}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </div>
                    </div>
                  </div>

                  {/* Score badge */}
                  {(item.score ?? 0) > 0 && (
                    <div className="absolute top-1.5 right-1.5 px-1.5 py-0.5 bg-black/70 backdrop-blur-sm rounded text-[10px] font-semibold text-yellow-400 flex items-center gap-0.5">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                      </svg>
                      {item.score?.toFixed(1)}
                    </div>
                  )}
                </div>
                <div className="mt-2 px-0.5">
                  <h3 className="text-white font-medium text-xs sm:text-sm line-clamp-1 group-hover:text-pink-300 transition-colors">{item.title_english || item.title}</h3>
                  <p className="text-gray-500 text-[10px] mt-0.5">{item.year || ''}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
