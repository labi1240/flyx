'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import type { MALAnime, MALSeason } from '@/lib/services/mal';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { FluidButton } from '@/components/ui/FluidButton';

interface Props {
  malId?: number;
  anime?: MALAnime | null;
  allSeasons?: MALSeason[];
}

export default function AnimeDetailsClient({ malId, anime: ssrAnime, allSeasons: ssrSeasons }: Props) {
  const router = useRouter();
  const [anime, setAnime] = useState<MALAnime | null>(ssrAnime || null);
  const [allSeasons] = useState<MALSeason[]>(ssrSeasons || []);
  const [loading, setLoading] = useState(!ssrAnime && !!malId);
  const [error, setError] = useState(false);
  const [selectedSeasonIdx, setSelectedSeasonIdx] = useState(0);

  useEffect(() => {
    if (ssrAnime || !malId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/anilist/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: `query($malId:Int){Media(idMal:$malId,type:ANIME){idMal title{romaji english} description(asHtml:false) coverImage{extraLarge large} bannerImage averageScore format status episodes seasonYear genres studios(isMain:true){nodes{name}} startDate{year month day}}}`,
            variables: { malId },
          }),
        });
        if (cancelled) return;
        const json = await res.json();
        const m = json?.data?.Media;
        if (m?.idMal) {
          setAnime({
            mal_id: m.idMal,
            title: m.title?.romaji || m.title?.english || 'Unknown',
            title_english: m.title?.english || null,
            title_japanese: null,
            type: m.format || 'TV',
            episodes: m.episodes || null,
            status: m.status || 'Unknown',
            score: m.averageScore != null ? Math.round(m.averageScore) / 10 : null,
            scored_by: null,
            rank: null,
            popularity: null,
            members: null,
            synopsis: m.description || null,
            season: null,
            year: m.seasonYear || m.startDate?.year || null,
            images: {
              jpg: {
                image_url: m.coverImage?.large || '',
                large_image_url: m.coverImage?.extraLarge || m.coverImage?.large || '',
              },
              webp: {
                image_url: m.coverImage?.large || '',
                large_image_url: m.coverImage?.extraLarge || m.coverImage?.large || '',
              },
            },
            aired: { from: null, to: null, string: '' },
            genres: (m.genres || []).map((g: string, i: number) => ({ mal_id: i, name: g })),
            studios: (m.studios?.nodes || []).map((s: any) => ({ mal_id: 0, name: s.name })),
          });
        } else {
          setError(true);
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ssrAnime, malId]);

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

  const currentSeason = allSeasons[selectedSeasonIdx] || null;
  const isMovie = anime.type === 'Movie';

  const handleWatch = () => {
    if (isMovie) {
      router.push(`/anime/${anime.mal_id}/watch`);
    } else if (currentSeason) {
      router.push(`/anime/${currentSeason.malId}/watch?episode=1`);
    }
  };

  const posterUrl = anime.images?.jpg?.large_image_url || '';

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
          <img src={posterUrl} alt="" className="w-full h-full object-cover blur-3xl opacity-20 scale-110" />
          <div className="absolute inset-0 bg-gradient-to-b from-[#0a0812]/50 to-[#0a0812]" />
        </div>

        <div className="relative max-w-6xl mx-auto flex flex-col md:flex-row gap-8">
          <div className="flex-shrink-0 w-48 md:w-56 mx-auto md:mx-0">
            <img src={posterUrl} alt={anime.title} className="w-full rounded-lg shadow-2xl" />
          </div>
          <div className="flex-1">
            <h1 className="text-3xl md:text-4xl font-bold text-white">{anime.title}</h1>
            {anime.title_english && anime.title_english !== anime.title && (
              <p className="text-gray-400 mt-1">{anime.title_english}</p>
            )}

            <div className="flex flex-wrap gap-2 mt-3 text-sm text-gray-300">
              <span>⭐ {anime.score?.toFixed(2) || 'N/A'}</span>
              <span>•</span>
              <span>{anime.type}</span>
              <span>•</span>
              <span>{anime.status}</span>
              {allSeasons.length > 1 && (
                <>
                  <span>•</span>
                  <span>{allSeasons.length} Seasons</span>
                </>
              )}
            </div>

            {anime.genres && anime.genres.length > 0 && (
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
      {!isMovie && allSeasons.length > 1 && (
        <div className="px-4 md:px-8 pb-6">
          <div className="max-w-6xl mx-auto">
            <div className="flex gap-2 overflow-x-auto pb-2">
              {allSeasons.map((season, i) => (
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
                  {season.episodes && <span className="ml-2 text-xs opacity-60">{season.episodes} eps</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Episodes Grid */}
      {!isMovie && currentSeason && currentSeason.episodes && (
        <section className="px-4 md:px-8 pb-20">
          <div className="max-w-6xl mx-auto">
            <GlassPanel>
              <div className="p-4 md:p-6">
                <h2 className="text-lg font-bold text-white mb-4">
                  {currentSeason.titleEnglish || currentSeason.title} — Episodes
                </h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                  {Array.from({ length: currentSeason.episodes }, (_, i) => i + 1).map(epNum => (
                    <motion.button
                      key={epNum}
                      whileHover={{ scale: 1.03 }}
                      onClick={() => router.push(`/anime/${currentSeason.malId}/watch?episode=${epNum}`)}
                      className="relative aspect-video bg-white/5 hover:bg-fuchsia-600/20 border border-white/10 hover:border-fuchsia-500/40 rounded-lg overflow-hidden group transition-colors"
                    >
                      <img src={posterUrl} alt="" className="absolute inset-0 w-full h-full object-cover opacity-30" />
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
