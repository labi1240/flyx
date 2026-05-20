'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import type { MALAnime, MALSeason } from '@/lib/services/mal';
import type { MediaItem } from '@/types/media';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { FluidButton } from '@/components/ui/FluidButton';
import { WatchlistButton } from '@/components/ui/WatchlistButton';
import styles from './AnimeDetails.module.css';

/** Convert MALAnime to a MediaItem so the WatchlistButton can consume it. */
function malToMediaItem(anime: MALAnime): MediaItem {
  return {
    id: `mal-${anime.mal_id}`,
    title: anime.title_english || anime.title,
    name: anime.title,
    overview: anime.synopsis || undefined,
    posterPath: anime.images.jpg.large_image_url,
    backdropPath: anime.images.jpg.large_image_url,
    vote_average: anime.score ?? undefined,
    mediaType: anime.type === 'Movie' ? 'movie' : 'tv',
    genres: anime.genres?.map(g => ({ id: g.mal_id, name: g.name })),
    releaseDate: anime.aired?.from ?? undefined,
  };
}

interface EpisodeData {
  number: number;
  title: string;
  titleJapanese: string | null;
  aired: string | null;
  score: number | null;
  filler: boolean;
  recap: boolean;
}

interface Props {
  malId?: number;
  anime?: MALAnime | null;
  allSeasons?: MALSeason[];
  totalEpisodes?: number;
}

// Client-side AniList fetch for when the server can't reach AniList from CF edge.
// Same 2-tier pattern as the browse page: proxy first (same-domain, no ad blocker),
// then direct (residential IP, bypasses CF edge block).
async function fetchAnimeDetailClient(malId: number): Promise<{ anime: MALAnime; allSeasons: MALSeason[]; totalEpisodes: number } | null> {
  const data = await fetchAnimeDetail('/api/anilist/graphql', malId);
  if (data) return data;
  return fetchAnimeDetail('https://graphql.anilist.co', malId);
}

const ANIME_DETAIL_QUERY = `
  query ($malId: Int) {
    Media(idMal: $malId, type: ANIME) {
      id idMal
      title { romaji english native }
      type format status episodes duration
      averageScore meanScore popularity
      description(asHtml: false)
      season seasonYear
      startDate { year month day }
      endDate { year month day }
      coverImage { extraLarge large medium }
      bannerImage
      genres
      studios(isMain: true) { nodes { id name } }
      relations {
        edges {
          relationType
          node { id idMal type format title { romaji english } }
        }
      }
    }
  }
`;

interface RawMediaDetail {
  id: number;
  idMal: number | null;
  title: { romaji: string | null; english: string | null; native: string | null };
  format: string | null;
  status: string | null;
  episodes: number | null;
  duration: number | null;
  averageScore: number | null;
  meanScore: number | null;
  popularity: number | null;
  description: string | null;
  season: string | null;
  seasonYear: number | null;
  startDate: { year: number | null; month: number | null; day: number | null } | null;
  endDate: { year: number | null; month: number | null; day: number | null } | null;
  coverImage: { extraLarge: string | null; large: string | null; medium: string | null };
  bannerImage: string | null;
  genres: string[];
  studios: { nodes: Array<{ id: number; name: string }> } | null;
  relations: {
    edges: Array<{
      relationType: string;
      node: {
        id: number;
        idMal: number | null;
        type: string;
        format: string | null;
        title: { romaji: string | null; english: string | null };
      };
    }>;
  } | null;
}

const FMT: Record<string, string> = {
  TV: 'TV', TV_SHORT: 'TV', MOVIE: 'Movie', SPECIAL: 'Special', OVA: 'OVA', ONA: 'ONA', MUSIC: 'Music',
};
const STS: Record<string, string> = {
  FINISHED: 'Finished Airing', RELEASING: 'Currently Airing', NOT_YET_RELEASED: 'Not yet aired',
  CANCELLED: 'Cancelled', HIATUS: 'Hiatus',
};
const SSN: Record<string, string> = {
  WINTER: 'winter', SPRING: 'spring', SUMMER: 'summer', FALL: 'fall',
};

function mapRawToMALAnime(m: RawMediaDetail): MALAnime | null {
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

  const fuzzyToISO = (d: { year: number | null; month: number | null; day: number | null } | null) => {
    if (!d || !d.year) return null;
    return `${String(d.year).padStart(4, '0')}-${String(d.month || 1).padStart(2, '0')}-${String(d.day || 1).padStart(2, '0')}T00:00:00+00:00`;
  };
  const fuzzyToString = (d: { year: number | null; month: number | null; day: number | null } | null) => {
    if (!d || !d.year) return '';
    return d.month ? `${d.month}/${d.day || 1}/${d.year}` : String(d.year);
  };
  const airedFrom = fuzzyToISO(m.startDate);
  const airedTo = fuzzyToISO(m.endDate);
  const airedStrFrom = fuzzyToString(m.startDate);
  const airedStrTo = fuzzyToString(m.endDate);
  const airedString = airedStrFrom && airedStrTo ? `${airedStrFrom} to ${airedStrTo}`
    : airedStrFrom ? `${airedStrFrom} to ?` : airedStrTo ? `? to ${airedStrTo}` : '';

  return {
    mal_id: m.idMal,
    title: m.title?.romaji || m.title?.english || m.title?.native || 'Unknown',
    title_english: m.title?.english ?? null,
    title_japanese: m.title?.native ?? null,
    type: m.format ? (FMT[m.format] ?? 'Unknown') : 'Unknown',
    episodes: m.episodes ?? null,
    status: m.status ? (STS[m.status] ?? 'Unknown') : 'Unknown',
    score,
    scored_by: null,
    rank: null,
    popularity: m.popularity ?? null,
    members: m.popularity ?? null,
    synopsis,
    season: m.season ? (SSN[m.season] ?? null) : null,
    year: m.seasonYear || m.startDate?.year || null,
    images: {
      jpg: { image_url: coverSmall, large_image_url: coverLarge },
      webp: { image_url: coverSmall, large_image_url: coverLarge },
    },
    aired: {
      from: airedFrom,
      to: airedTo,
      string: airedString,
    },
    genres: (m.genres || []).map((g, i) => ({ mal_id: i, name: g })),
    studios: (m.studios?.nodes || []).map(s => ({ mal_id: s.id, name: s.name })),
  };
}

function buildSeasons(main: RawMediaDetail, relatedEdges: NonNullable<RawMediaDetail['relations']>['edges']): MALSeason[] {
  const seasons: MALSeason[] = [];

  // Start with the main entry
  if (main.idMal) {
    seasons.push({
      malId: main.idMal,
      title: main.title?.romaji || main.title?.english || 'Unknown',
      titleEnglish: main.title?.english || main.title?.romaji || null,
      imageUrl: main.coverImage?.extraLarge || main.coverImage?.large || '',
      episodes: main.episodes ?? null,
      score: main.averageScore != null ? Math.round(main.averageScore) / 10 : null,
      status: main.status ? (STS[main.status] ?? 'Unknown') : 'Unknown',
      type: main.format ? (FMT[main.format] ?? 'TV') : 'TV',
      aired: '',
      synopsis: null,
      members: null,
      seasonOrder: 1,
      year: main.seasonYear ?? main.startDate?.year ?? undefined,
    } as MALSeason);
  }

  // Add related entries that are sequels/prequels
  const relevantTypes = new Set(['SEQUEL', 'PREQUEL', 'SIDE_STORY', 'ALTERNATIVE', 'SPIN_OFF']);
  let order = 2;
  for (const edge of relatedEdges) {
    if (!edge.node.idMal) continue;
    if (!relevantTypes.has(edge.relationType) && edge.node.type !== 'ANIME') continue;
    if (seasons.some(s => s.malId === edge.node.idMal)) continue;

    seasons.push({
      malId: edge.node.idMal,
      title: edge.node.title?.romaji || edge.node.title?.english || 'Unknown',
      titleEnglish: edge.node.title?.english || edge.node.title?.romaji || null,
      imageUrl: '',
      episodes: null,
      score: null,
      status: 'Unknown',
      type: edge.node.format ? (FMT[edge.node.format] ?? 'TV') : 'TV',
      aired: '',
      synopsis: null,
      members: null,
      seasonOrder: order++,
    } as MALSeason);
  }

  if (seasons.length === 0) {
    seasons.push({
      malId: main.idMal ?? 0, title: 'Unknown', titleEnglish: null,
      imageUrl: '', episodes: null, score: null, status: 'Unknown',
      type: 'TV', aired: '', synopsis: null, members: null, seasonOrder: 1,
    } as MALSeason);
  }
  return seasons;
}

async function fetchAnimeDetail(endpoint: string, malId: number): Promise<{ anime: MALAnime; allSeasons: MALSeason[]; totalEpisodes: number } | null> {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: ANIME_DETAIL_QUERY, variables: { malId } }),
      signal: endpoint.startsWith('/') ? undefined : AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const media = json?.data?.Media as RawMediaDetail | null;
    if (!media || !media.idMal) return null;

    const anime = mapRawToMALAnime(media);
    if (!anime) return null;

    const allSeasons = buildSeasons(media, media.relations?.edges || []);
    const totalEpisodes = allSeasons.reduce((sum, s) => sum + (s.episodes || 0), 0);

    return { anime, allSeasons, totalEpisodes };
  } catch {
    return null;
  }
}

export default function AnimeDetailsClient({ malId, anime: ssrAnime, allSeasons: ssrSeasons, totalEpisodes: ssrTotalEpisodes }: Props) {
  const router = useRouter();
  const [anime, setAnime] = useState<MALAnime | null>(ssrAnime || null);
  const [allSeasons, setAllSeasons] = useState<MALSeason[]>(ssrSeasons || []);
  const [totalEpisodes, setTotalEpisodes] = useState(ssrTotalEpisodes || 0);
  const [loading, setLoading] = useState(!ssrAnime && !!malId);
  const [error, setError] = useState(false);
  const [selectedSeason, setSelectedSeason] = useState(0);
  const [episodes, setEpisodes] = useState<EpisodeData[]>([]);

  // Client-side fallback when SSR fails (AniList blocks CF edge IPs)
  useEffect(() => {
    if (ssrAnime || !malId) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(false);
      try {
        const data = await fetchAnimeDetailClient(malId!);
        if (cancelled) return;
        if (data) {
          setAnime(data.anime);
          setAllSeasons(data.allSeasons);
          setTotalEpisodes(data.totalEpisodes);
        } else {
          setError(true);
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [ssrAnime, malId]);

  // Generate episodes from the season's episode count — no API call needed.
  // Enhanced with Jikan episode details (titles, air dates, filler flags) in the background.
  // MUST be before any conditional returns to avoid React hooks order errors.
  useEffect(() => {
    const currentSeason = allSeasons[selectedSeason] || allSeasons[0];
    const isMovie = anime?.type === 'Movie';
    if (!anime || !currentSeason || isMovie) return;

    const epCount = currentSeason.episodes || 0;
    if (epCount === 0) {
      setEpisodes([]);
      return;
    }

    const generated: EpisodeData[] = Array.from({ length: epCount }, (_, i) => ({
      number: i + 1,
      title: `Episode ${i + 1}`,
      titleJapanese: null,
      aired: null,
      score: null,
      filler: false,
      recap: false,
    }));
    setEpisodes(generated);

    let cancelled = false;
    (async () => {
      try {
        let allJikanEps: EpisodeData[] = [];
        let page = 1;
        let hasNextPage = true;

        while (hasNextPage && !cancelled) {
          const response = await fetch(`/api/content/mal-episodes?malId=${currentSeason.malId}&page=${page}`);
          if (!response.ok || cancelled) break;
          const data = await response.json();
          if (cancelled || !data.success || !data.data?.episodes?.length) break;

          allJikanEps = allJikanEps.concat(data.data.episodes);
          hasNextPage = data.data.hasNextPage;
          page++;

          const merged = generated.map(ep => {
            const detail = allJikanEps.find((j: EpisodeData) => j.number === ep.number);
            return detail ? { ...ep, ...detail } : ep;
          });
          if (!cancelled) setEpisodes(merged);
        }
      } catch {
        // Jikan enhancement failed — that's fine
      }
    })();

    return () => { cancelled = true; };
  }, [anime, allSeasons, selectedSeason]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0812] flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-fuchsia-500/30 border-t-fuchsia-400 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400">Loading anime details...</p>
        </div>
      </div>
    );
  }

  if (error || !anime) {
    return (
      <div className="min-h-screen bg-[#0a0812] flex items-center justify-center">
        <div className="text-center">
          <p className="text-white text-lg mb-2">Failed to load anime details</p>
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

  const currentSeason = allSeasons[selectedSeason] || allSeasons[0];
  const isMovie = anime.type === 'Movie';

  const handleBack = () => {
    router.push('/anime');
  };

  const handleWatchNow = () => {
    if (isMovie) {
      router.push(`/anime/${anime.mal_id}/watch`);
    } else if (currentSeason) {
      router.push(`/anime/${currentSeason.malId}/watch?episode=1`);
    }
  };

  const handleEpisodeSelect = (episodeNumber: number) => {
    if (currentSeason) {
      router.push(`/anime/${currentSeason.malId}/watch?episode=${episodeNumber}`);
    }
  };

  const formatAirDate = (dateStr: string | null) => {
    if (!dateStr) return null;
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
      return null;
    }
  };

  const getSeasonThumbnail = () => {
    if (currentSeason?.imageUrl) return currentSeason.imageUrl;
    return anime.images.jpg.large_image_url;
  };

  const seasonThumbnail = getSeasonThumbnail();

  return (
    <div className={styles.container}>
      {/* Back Button */}
      <button onClick={handleBack} className={styles.backButton}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        Back to Anime
      </button>

      {/* Hero Section */}
      <div className={styles.hero} style={{ backgroundImage: `url(${anime.images.jpg.large_image_url})` }}>
        <div className={styles.heroOverlay} />
        <div className={styles.heroContent}>
          <div className={styles.posterContainer}>
            <img src={anime.images.jpg.large_image_url} alt={anime.title} className={styles.poster} />
          </div>
          
          <div className={styles.info}>
            <h1 className={styles.title}>{anime.title}</h1>
            {anime.title_english && anime.title_english !== anime.title && (
              <p className={styles.englishTitle}>{anime.title_english}</p>
            )}
            
            <div className={styles.metadata}>
              <span className={styles.rating}>⭐ {anime.score?.toFixed(2) || 'N/A'}</span>
              <span className={styles.separator}>•</span>
              <span className={styles.type}>{anime.type}</span>
              <span className={styles.separator}>•</span>
              <span className={styles.status}>{anime.status}</span>
              {!isMovie && allSeasons.length > 1 && (
                <>
                  <span className={styles.separator}>•</span>
                  <span className={styles.seasons}>{allSeasons.length} Seasons</span>
                </>
              )}
              {!isMovie && (currentSeason?.episodes || totalEpisodes > 0) && (
                <>
                  <span className={styles.separator}>•</span>
                  <span className={styles.episodes}>
                    {currentSeason?.episodes || totalEpisodes}+ Episodes
                  </span>
                </>
              )}
            </div>

            {anime.genres && anime.genres.length > 0 && (
              <div className={styles.genres}>
                {anime.genres.map((genre) => (
                  <span key={genre.mal_id} className={styles.genreTag}>
                    {genre.name}
                  </span>
                ))}
              </div>
            )}

            <p className={styles.synopsis}>{anime.synopsis}</p>

            <div className={styles.actions}>
              <FluidButton onClick={handleWatchNow} variant="primary" size="lg">
                <svg className={styles.playIcon} fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
                {isMovie ? 'Watch Movie' : 'Watch Now'}
              </FluidButton>
              <WatchlistButton item={malToMediaItem(anime)} variant="full" />
            </div>
          </div>
        </div>
      </div>

      {/* Episodes Section */}
      {!isMovie && (
        <section className={styles.episodesSection}>
          <GlassPanel className={styles.episodesPanel}>
            <h2 className={styles.sectionTitle}>Episodes</h2>
            
            {/* Season Selector */}
            {allSeasons.length > 1 && (
              <div className={styles.seasonSelector}>
                {allSeasons.map((season, index) => (
                  <button
                    key={season.malId}
                    onClick={() => setSelectedSeason(index)}
                    className={`${styles.seasonButton} ${selectedSeason === index ? styles.active : ''}`}
                  >
                    {season.titleEnglish || season.title}
                    <span className={styles.episodeCount}>
                      {season.episodes ? `${season.episodes} eps` : 'Ongoing'}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* Current Season Info */}
            {currentSeason && (
              <div className={styles.seasonInfo}>
                <h3>{currentSeason.titleEnglish || currentSeason.title}</h3>
                <p className={styles.seasonMeta}>
                  ⭐ {currentSeason.score?.toFixed(2) || 'N/A'} • {currentSeason.episodes ? `${currentSeason.episodes} Episodes` : 'Ongoing'} • {currentSeason.status}
                </p>
              </div>
            )}

            {/* Episode Grid */}
            <div className={styles.episodeGrid}>
                {episodes.map((ep) => {
                  const airDate = formatAirDate(ep.aired);
                  const isFuture = ep.aired ? new Date(ep.aired) > new Date() : false;
                  
                  return (
                    <motion.div
                      key={ep.number}
                      className={`${styles.episodeCard} ${isFuture ? styles.futureEpisode : ''}`}
                      whileHover={!isFuture ? { scale: 1.02 } : undefined}
                      onClick={() => !isFuture && handleEpisodeSelect(ep.number)}
                    >
                      <div className={styles.episodeThumbnail}>
                        <img 
                          src={seasonThumbnail} 
                          alt={`Episode ${ep.number}`}
                          className={styles.thumbnailImage}
                          loading="lazy"
                        />
                        <div className={styles.thumbnailOverlay}>
                          <span className={styles.episodeNumberBadge}>{ep.number}</span>
                        </div>
                        {!isFuture && (
                          <div className={styles.playOverlay}>
                            <svg fill="currentColor" viewBox="0 0 24 24">
                              <path d="M8 5v14l11-7z" />
                            </svg>
                          </div>
                        )}
                        {ep.filler && <span className={styles.fillerBadge}>Filler</span>}
                        {ep.recap && <span className={styles.recapBadge}>Recap</span>}
                      </div>
                      <div className={styles.episodeInfo}>
                        <h4 className={styles.episodeTitle}>
                          {ep.title || `Episode ${ep.number}`}
                        </h4>
                        {airDate && (
                          <p className={styles.episodeAirDate}>
                            {isFuture ? `Airs: ${airDate}` : airDate}
                          </p>
                        )}
                        {ep.score && ep.score > 0 && (
                          <p className={styles.episodeScore}>⭐ {ep.score.toFixed(2)}</p>
                        )}
                      </div>
                    </motion.div>
                  );
                })}
              </div>
          </GlassPanel>
        </section>
      )}
    </div>
  );
}
