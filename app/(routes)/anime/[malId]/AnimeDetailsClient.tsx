'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { FluidButton } from '@/components/ui/FluidButton';

const JIKAN = 'https://api.jikan.moe/v4';

interface AnimeData {
  mal_id: number;
  title: string;
  title_english: string | null;
  type: string;
  episodes: number | null;
  status: string;
  score: number | null;
  year: number | null;
  synopsis: string | null;
  image: string;
  genres: Array<{ mal_id: number; name: string }>;
  studios: Array<{ mal_id: number; name: string }>;
  aired: { from: string | null; to: string | null; string: string };
  relations: Array<{
    relation: string;
    entry: Array<{
      mal_id: number;
      name: string;
      type: string;
    }>;
  }>;
}

interface SeasonEntry {
  malId: number;
  title: string;
  titleEnglish: string | null;
  imageUrl: string;
  episodes: number | null;
  score: number | null;
  type: string;
  status: string;
  year: number | null;
  seasonOrder: number;
}

const SEQUEL_TYPES = new Set(['Sequel', 'Prequel', 'Side story', 'Alternative version', 'Spin-off']);

export default function AnimeDetailsClient({ malId }: { malId: number }) {
  const router = useRouter();
  const [anime, setAnime] = useState<AnimeData | null>(null);
  const [seasons, setSeasons] = useState<SeasonEntry[]>([]);
  const [selectedSeasonIdx, setSelectedSeasonIdx] = useState(0);
  const [episodes, setEpisodes] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!malId) { setError(true); setLoading(false); return; }
    let cancelled = false;

    async function load() {
      try {
        // Fetch full anime data from Jikan
        const res = await fetch(`${JIKAN}/anime/${malId}/full`, {
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) { if (!cancelled) setError(true); return; }
        const json = await res.json();
        const data = json?.data;
        if (!data?.mal_id) { if (!cancelled) setError(true); return; }

        const animeData: AnimeData = {
          mal_id: data.mal_id,
          title: data.title || 'Unknown',
          title_english: data.title_english || null,
          type: data.type || 'TV',
          episodes: data.episodes ?? null,
          status: data.status || 'Unknown',
          score: data.score ?? null,
          year: data.year ?? null,
          synopsis: data.synopsis || null,
          image: data.images?.jpg?.large_image_url || data.images?.jpg?.image_url || '',
          genres: (data.genres || []).map((g: any) => ({ mal_id: g.mal_id, name: g.name })),
          studios: (data.studios || []).map((s: any) => ({ mal_id: s.mal_id, name: s.name })),
          aired: {
            from: data.aired?.from || null,
            to: data.aired?.to || null,
            string: data.aired?.string || '',
          },
          relations: data.relations || [],
        };

        if (cancelled) return;
        setAnime(animeData);

        // Build season list from relations
        const seasonEntries: SeasonEntry[] = [];

        // Main entry is season 1
        seasonEntries.push({
          malId: animeData.mal_id,
          title: animeData.title,
          titleEnglish: animeData.title_english,
          imageUrl: animeData.image,
          episodes: animeData.episodes,
          score: animeData.score,
          type: animeData.type,
          status: animeData.status,
          year: animeData.year,
          seasonOrder: 1,
        });

        // Collect related seasons
        for (const rel of animeData.relations) {
          if (!SEQUEL_TYPES.has(rel.relation)) continue;
          for (const entry of rel.entry) {
            if (entry.type !== 'anime') continue;
            if (seasonEntries.some(s => s.malId === entry.mal_id)) continue;

            // We need more detail for each related entry - fetch individual anime
            try {
              const relRes = await fetch(`${JIKAN}/anime/${entry.mal_id}`, {
                signal: AbortSignal.timeout(10000),
              });
              if (relRes.ok) {
                const relJson = await relRes.json();
                const r = relJson?.data;
                if (r?.mal_id) {
                  seasonEntries.push({
                    malId: r.mal_id,
                    title: r.title || entry.name || 'Unknown',
                    titleEnglish: r.title_english || null,
                    imageUrl: r.images?.jpg?.large_image_url || r.images?.jpg?.image_url || '',
                    episodes: r.episodes ?? null,
                    score: r.score ?? null,
                    type: r.type || 'TV',
                    status: r.status || 'Unknown',
                    year: r.year ?? null,
                    seasonOrder: 0,
                  });
                }
              }
            } catch {}
          }
        }

        // Sort by year, then assign order
        seasonEntries.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999));
        seasonEntries.forEach((s, i) => { s.seasonOrder = i + 1; });

        if (!cancelled) {
          setSeasons(seasonEntries);

          // Generate episode numbers for first season
          const firstSeason = seasonEntries[0];
          if (firstSeason?.episodes) {
            setEpisodes(Array.from({ length: firstSeason.episodes }, (_, i) => i + 1));
          }
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [malId]);

  // Reload episodes when season changes
  useEffect(() => {
    const season = seasons[selectedSeasonIdx];
    if (season?.episodes) {
      setEpisodes(Array.from({ length: season.episodes }, (_, i) => i + 1));
    } else {
      setEpisodes([]);
    }
  }, [selectedSeasonIdx, seasons]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0812] flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-fuchsia-500/30 border-t-fuchsia-400 rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !anime) {
    return (
      <div className="min-h-screen bg-[#0a0812] flex items-center justify-center">
        <div className="text-center">
          <p className="text-white text-lg mb-2">Failed to load anime</p>
          <button onClick={() => router.push('/anime')} className="px-4 py-2 bg-fuchsia-600 hover:bg-fuchsia-500 text-white rounded-lg">
            Back to Anime
          </button>
        </div>
      </div>
    );
  }

  const currentSeason = seasons[selectedSeasonIdx] || seasons[0];
  const isMovie = anime.type === 'Movie';

  const handleWatch = () => {
    if (isMovie) {
      router.push(`/anime/${anime.mal_id}/watch`);
    } else if (currentSeason) {
      router.push(`/anime/${currentSeason.malId}/watch?episode=1`);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0812]">
      <button
        onClick={() => router.push('/anime')}
        className="fixed top-20 left-4 z-50 px-4 py-2 bg-black/50 backdrop-blur-sm border border-white/10 rounded-lg text-white hover:bg-white/10 transition-colors"
      >
        ← Back
      </button>

      {/* Hero */}
      <div className="relative pt-20 pb-10 px-4 md:px-8">
        <div className="absolute inset-0 overflow-hidden">
          <img src={anime.image} alt="" className="w-full h-full object-cover blur-3xl opacity-20 scale-110" />
          <div className="absolute inset-0 bg-gradient-to-b from-[#0a0812]/50 to-[#0a0812]" />
        </div>

        <div className="relative max-w-6xl mx-auto flex flex-col md:flex-row gap-8">
          <div className="flex-shrink-0 w-48 md:w-56 mx-auto md:mx-0">
            <img src={anime.image} alt={anime.title} className="w-full rounded-lg shadow-2xl" />
          </div>
          <div className="flex-1">
            <h1 className="text-3xl md:text-4xl font-bold text-white">{anime.title}</h1>
            {anime.title_english && anime.title_english !== anime.title && (
              <p className="text-gray-400 mt-1">{anime.title_english}</p>
            )}

            <div className="flex flex-wrap gap-2 mt-3 text-sm text-gray-300">
              {anime.score != null && <span>⭐ {anime.score.toFixed(2)}</span>}
              <span>•</span>
              <span>{anime.type}</span>
              <span>•</span>
              <span>{anime.status}</span>
              {anime.year && <><span>•</span><span>{anime.year}</span></>}
              {seasons.length > 1 && <><span>•</span><span>{seasons.length} Seasons</span></>}
            </div>

            {anime.genres.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {anime.genres.map(g => (
                  <span key={g.mal_id} className="px-2 py-0.5 bg-white/5 border border-white/10 rounded-full text-xs text-gray-300">
                    {g.name}
                  </span>
                ))}
              </div>
            )}

            {anime.synopsis && (
              <p className="text-gray-400 text-sm mt-4 line-clamp-4">{anime.synopsis}</p>
            )}

            <div className="mt-5">
              <FluidButton onClick={handleWatch} variant="primary" size="lg">
                <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                {isMovie ? 'Watch Movie' : 'Watch Now'}
              </FluidButton>
            </div>
          </div>
        </div>
      </div>

      {/* Season Selector */}
      {!isMovie && seasons.length > 1 && (
        <div className="px-4 md:px-8 pb-6">
          <div className="max-w-6xl mx-auto">
            <div className="flex gap-2 overflow-x-auto pb-2">
              {seasons.map((season, i) => (
                <button
                  key={season.malId}
                  onClick={() => setSelectedSeasonIdx(i)}
                  className={`flex-shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    selectedSeasonIdx === i
                      ? 'bg-fuchsia-600 text-white'
                      : 'bg-white/5 text-gray-300 hover:bg-white/10'
                  }`}
                >
                  {season.titleEnglish || season.title}
                  {season.episodes != null && <span className="ml-2 text-xs opacity-60">{season.episodes} eps</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Episodes Grid */}
      {!isMovie && episodes.length > 0 && (
        <section className="px-4 md:px-8 pb-20">
          <div className="max-w-6xl mx-auto">
            <GlassPanel>
              <div className="p-4 md:p-6">
                <h2 className="text-lg font-bold text-white mb-4">
                  {currentSeason?.titleEnglish || currentSeason?.title || anime.title} — Episodes
                </h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                  {episodes.map(epNum => (
                    <motion.button
                      key={epNum}
                      whileHover={{ scale: 1.03 }}
                      onClick={() => router.push(`/anime/${currentSeason?.malId || anime.mal_id}/watch?episode=${epNum}`)}
                      className="relative aspect-video bg-white/5 hover:bg-fuchsia-600/20 border border-white/10 hover:border-fuchsia-500/40 rounded-lg overflow-hidden group transition-colors"
                    >
                      <img src={anime.image} alt="" className="absolute inset-0 w-full h-full object-cover opacity-30" />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="text-white font-bold text-lg">{epNum}</span>
                      </div>
                      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                        <div className="w-10 h-10 rounded-full bg-fuchsia-600/70 flex items-center justify-center">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
                        </div>
                      </div>
                    </motion.button>
                  ))}
                </div>
              </div>
            </GlassPanel>
          </div>
        </section>
      )}
    </div>
  );
}
