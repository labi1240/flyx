'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { ExtensionGate } from '@/components/ExtensionGate';
import {
  jikanFull,
  jikanEpisodes,
  jikanCharacters,
  jikanRecommendations,
  type JikanAnime,
  type JikanEpisode,
  type JikanCharacter,
  type AnimeCard,
} from '@/lib/anime/jikan-client';

type Tab = 'episodes' | 'characters' | 'related' | 'info';

// ─── Main Component ─────────────────────────────────────────────────────────

export default function AnimeDetailsClient({ malId }: { malId: number }) {
  return (
    <ExtensionGate type="anime">
      <AnimeDetailsClientInner malId={malId} />
    </ExtensionGate>
  );
}

function AnimeDetailsClientInner({ malId }: { malId: number }) {
  const router = useRouter();
  const [anime, setAnime] = useState<JikanAnime | null>(null);
  const [episodes, setEpisodes] = useState<JikanEpisode[]>([]);
  const [characters, setCharacters] = useState<JikanCharacter[]>([]);
  const [recommendations, setRecommendations] = useState<AnimeCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<Tab>('episodes');
  const [synopsisExpanded, setSynopsisExpanded] = useState(false);
  const [trailerOpen, setTrailerOpen] = useState(false);

  useEffect(() => {
    if (!malId) { setError(true); setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const data = await jikanFull(malId);
      if (cancelled) return;
      if (!data) { setError(true); setLoading(false); return; }
      setAnime(data);
      setLoading(false);
      const [eps, chars, recs] = await Promise.all([
        jikanEpisodes(data.mal_id),
        jikanCharacters(data.mal_id),
        jikanRecommendations(data.mal_id),
      ]);
      if (cancelled) return;
      setEpisodes(eps);
      setCharacters(chars);
      setRecommendations(recs);
    })();
    return () => { cancelled = true; };
  }, [malId]);

  const isMovie = anime?.type === 'Movie';
  const mainChars = useMemo(() => characters.filter((c) => c.role === 'Main').slice(0, 18), [characters]);
  const supportingChars = useMemo(() => characters.filter((c) => c.role === 'Supporting').slice(0, 12), [characters]);
  const trailerId = anime?.trailer?.youtube_id || null;
  const epCount = episodes.length > 0 ? episodes.length : (anime?.episodes ?? 0);

  const playEp = useCallback((epNum: number) => {
    if (isMovie) router.push(`/anime/${malId}/watch`);
    else router.push(`/anime/${malId}/watch?episode=${epNum}`);
  }, [isMovie, malId, router]);

  const poster =
    anime?.images?.webp?.large_image_url ||
    anime?.images?.jpg?.large_image_url ||
    anime?.images?.jpg?.image_url || '';

  // ─── Loading ───────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-[#07060a] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 rounded-full border-2 border-fuchsia-500/20 border-t-fuchsia-400 animate-spin" />
          <p className="text-gray-500 text-sm">Loading anime details...</p>
        </div>
      </div>
    );
  }

  // ─── Error ─────────────────────────────────────────────────────────────
  if (error || !anime) {
    return (
      <div className="min-h-screen bg-[#07060a] flex items-center justify-center">
        <div className="text-center">
          <div className="text-6xl mb-4">😞</div>
          <p className="text-white text-xl font-semibold mb-2">Failed to load anime</p>
          <p className="text-gray-500 text-sm mb-6">The anime data couldn&apos;t be retrieved right now.</p>
          <button onClick={() => router.push('/anime')}
            className="px-6 py-2.5 rounded-xl bg-fuchsia-600 hover:bg-fuchsia-500 text-white font-semibold transition-colors">
            Back to Browse
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#07060a] text-white selection:bg-fuchsia-500/30">
      {/* Back button */}
      <button onClick={() => router.push('/anime')}
        className="fixed top-4 left-4 z-50 flex items-center gap-2 px-3.5 py-2 bg-black/60 backdrop-blur-xl border border-white/10 hover:border-fuchsia-500/50 rounded-xl text-sm font-medium text-white transition-all hover:bg-black/80">
        <ArrowLeft className="w-4 h-4" /> Back
      </button>

      {/* Hero banner */}
      <HeroBanner anime={anime} poster={poster} isMovie={isMovie} epCount={epCount}
        synopsisExpanded={synopsisExpanded} onToggleSynopsis={() => setSynopsisExpanded((v) => !v)}
        trailerId={trailerId} onTrailer={() => setTrailerOpen(true)}
        onWatch={() => playEp(1)} />

      {/* Tab bar */}
      <div className="sticky top-0 z-30 bg-[#07060a]/85 backdrop-blur-xl border-b border-white/5">
        <div className="max-w-7xl mx-auto px-4 md:px-8">
          <div className="flex gap-1">
            {([
              { id: 'episodes' as Tab, label: !isMovie ? 'Episodes' : 'Movie', count: !isMovie ? epCount : undefined },
              { id: 'characters' as Tab, label: 'Characters', count: characters.length || undefined },
              { id: 'related' as Tab, label: 'Related', count: recommendations.length || undefined },
              { id: 'info' as Tab, label: 'Details' },
            ]).map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`relative px-5 py-3 text-sm font-semibold transition-colors ${
                  tab === t.id ? 'text-white' : 'text-gray-500 hover:text-gray-300'
                }`}>
                <span className="flex items-center gap-2">
                  {t.label}
                  {t.count != null && t.count > 0 && (
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                      tab === t.id ? 'bg-fuchsia-500/20 text-fuchsia-300' : 'bg-white/5 text-gray-500'
                    }`}>{t.count}</span>
                  )}
                </span>
                {tab === t.id && (
                  <motion.div layoutId="detail-tab" className="absolute left-3 right-3 -bottom-px h-0.5 bg-fuchsia-500 rounded-full" />
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Tab content */}
      <div className="max-w-7xl mx-auto px-4 md:px-8 pb-24 pt-8">
        <AnimatePresence mode="wait">
          {tab === 'episodes' && (
            <motion.div key="ep" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <EpisodesTab episodes={episodes} fallbackCount={epCount} isMovie={isMovie} poster={poster}
                onPlay={playEp} onWatchMovie={() => playEp(1)} />
            </motion.div>
          )}
          {tab === 'characters' && (
            <motion.div key="ch" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <CharactersTab main={mainChars} supporting={supportingChars} />
            </motion.div>
          )}
          {tab === 'related' && (
            <motion.div key="rel" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <RelatedTab items={recommendations} onOpen={(a) => router.push(`/anime/${a.mal_id}`)} />
            </motion.div>
          )}
          {tab === 'info' && (
            <motion.div key="inf" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <InfoTab anime={anime} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Trailer modal */}
      {trailerOpen && trailerId && <TrailerModal youtubeId={trailerId} onClose={() => setTrailerOpen(false)} />}
    </div>
  );
}

// ─── Hero Banner ────────────────────────────────────────────────────────────

function HeroBanner({ anime, poster, isMovie, epCount, synopsisExpanded, onToggleSynopsis, trailerId, onTrailer, onWatch }: {
  anime: JikanAnime; poster: string; isMovie: boolean; epCount: number;
  synopsisExpanded: boolean; onToggleSynopsis: () => void;
  trailerId: string | null; onTrailer: () => void; onWatch: () => void;
}) {
  return (
    <div className="relative pt-20 pb-12 md:pb-16 px-4 md:px-8 overflow-hidden">
      {/* BG layers */}
      <div className="absolute inset-0">
        <img src={poster} alt="" aria-hidden className="w-full h-full object-cover blur-3xl opacity-20 scale-125 saturate-150" />
        <div className="absolute inset-0 bg-gradient-to-b from-[#07060a]/30 via-[#07060a]/70 to-[#07060a]" />
        {/* Subtle radial glow behind poster */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-fuchsia-500/5 rounded-full blur-[120px]" />
      </div>

      <div className="relative max-w-6xl mx-auto flex flex-col md:flex-row gap-8 md:gap-12">
        {/* Poster */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
          className="flex-shrink-0 w-44 md:w-52 lg:w-60 mx-auto md:mx-0">
          <div className="relative rounded-2xl overflow-hidden shadow-2xl shadow-black/60 border border-white/10 group">
            <img src={poster} alt={anime.title} className="w-full aspect-[2/3] object-cover" />
            <div className="absolute inset-0 ring-1 ring-white/5 rounded-2xl pointer-events-none" />
          </div>
          {/* Quick stats below poster on mobile */}
          <div className="mt-4 md:hidden flex items-center justify-center gap-3 text-xs">
            {anime.score != null && (
              <span className="inline-flex items-center gap-1 px-3 py-1.5 bg-yellow-500/10 border border-yellow-500/20 rounded-xl text-yellow-300 font-bold">
                <Star className="w-3.5 h-3.5" /> {anime.score.toFixed(2)}
              </span>
            )}
            <span className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-xl text-gray-300 font-medium">{anime.type}</span>
          </div>
        </motion.div>

        {/* Info */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.1 }}
          className="flex-1 min-w-0">
          {/* Title */}
          <h1 className="text-3xl md:text-4xl lg:text-5xl font-black text-white leading-[1.1] tracking-tight">
            {anime.title_english || anime.title}
          </h1>
          {anime.title_english && anime.title_english !== anime.title && (
            <p className="text-gray-400 mt-1.5 text-sm md:text-base font-medium">{anime.title}</p>
          )}

          {/* Stat pills — desktop */}
          <div className="hidden md:flex flex-wrap items-center gap-2 mt-4">
            {anime.score != null && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-yellow-500/10 border border-yellow-500/20 rounded-xl text-sm text-yellow-300 font-bold">
                <Star className="w-4 h-4" /> {anime.score.toFixed(2)}
                {anime.scored_by != null && <span className="text-yellow-500/60 font-normal text-xs ml-0.5">({(anime.scored_by / 1000).toFixed(0)}k)</span>}
              </span>
            )}
            <span className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-xl text-xs text-gray-300 font-semibold uppercase tracking-wide">{anime.type}</span>
            <span className={`px-3 py-1.5 border rounded-xl text-xs font-semibold uppercase tracking-wide ${
              anime.status === 'Currently Airing' ? 'bg-green-500/10 border-green-500/20 text-green-400' : 'bg-white/5 border-white/10 text-gray-300'
            }`}>
              {anime.status === 'Currently Airing' && <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 mr-1.5 animate-pulse align-middle" />}
              {anime.status}
            </span>
            {anime.year && <span className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-xl text-xs text-gray-300 font-medium">{anime.year}</span>}
            {!isMovie && epCount > 0 && <span className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-xl text-xs text-gray-300 font-medium">{epCount} episodes</span>}
            {anime.duration && <span className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-xl text-xs text-gray-300 font-medium">{anime.duration}</span>}
            {anime.rating && <span className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-xl text-xs text-yellow-500/80 font-medium">{anime.rating}</span>}
          </div>

          {/* Genres */}
          {anime.genres.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-4">
              {anime.genres.map((g) => (
                <span key={g.mal_id} className="px-3 py-1 bg-fuchsia-500/8 border border-fuchsia-400/15 hover:bg-fuchsia-500/15 rounded-full text-[11px] text-fuchsia-300/90 font-medium transition-colors cursor-default">
                  {g.name}
                </span>
              ))}
            </div>
          )}

          {/* Synopsis */}
          {anime.synopsis && (
            <div className="mt-5">
              <p className={`text-gray-400 text-sm leading-relaxed ${synopsisExpanded ? '' : 'line-clamp-3 md:line-clamp-4'}`}>
                {anime.synopsis}
              </p>
              {anime.synopsis.length > 300 && (
                <button onClick={onToggleSynopsis}
                  className="text-fuchsia-400 hover:text-fuchsia-300 text-xs font-semibold mt-1.5 transition-colors">
                  {synopsisExpanded ? 'Show less' : 'Read full synopsis'}
                </button>
              )}
            </div>
          )}

          {/* CTA */}
          <div className="mt-6 flex flex-wrap gap-3">
            <button onClick={onWatch}
              className="inline-flex items-center gap-2.5 px-7 py-3 rounded-2xl bg-gradient-to-r from-fuchsia-500 to-purple-500 hover:from-fuchsia-400 hover:to-purple-400 text-white font-bold text-sm shadow-2xl shadow-fuchsia-500/25 transition-all hover:scale-[1.02] active:scale-[0.98]">
              <PlayIcon className="w-5 h-5" />
              {isMovie ? 'Watch Movie' : 'Watch Now'}
            </button>
            {trailerId && (
              <button onClick={onTrailer}
                className="inline-flex items-center gap-2 px-5 py-3 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-white text-sm font-semibold transition-all">
                <FilmIcon className="w-4 h-4" /> Trailer
              </button>
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

// ─── Episodes Tab ───────────────────────────────────────────────────────────

function EpisodesTab({ episodes, fallbackCount, isMovie, poster, onPlay, onWatchMovie }: {
  episodes: JikanEpisode[]; fallbackCount: number; isMovie: boolean;
  poster: string; onPlay: (ep: number) => void; onWatchMovie: () => void;
}) {
  if (isMovie) {
    return (
      <div className="rounded-2xl bg-white/[0.03] border border-white/5 p-8 flex flex-col sm:flex-row items-center gap-6 text-center sm:text-left">
        <div className="w-16 h-16 rounded-2xl bg-fuchsia-500/10 border border-fuchsia-500/20 flex items-center justify-center flex-shrink-0">
          <FilmIcon className="w-8 h-8 text-fuchsia-400" />
        </div>
        <div>
          <h3 className="text-xl font-bold text-white">Feature Presentation</h3>
          <p className="text-gray-400 text-sm mt-1">This is a movie — no episodes, just press play.</p>
        </div>
        <button onClick={onWatchMovie}
          className="sm:ml-auto flex-shrink-0 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-fuchsia-600 hover:bg-fuchsia-500 text-white font-semibold text-sm transition-colors">
          <PlayIcon className="w-4 h-4" /> Watch
        </button>
      </div>
    );
  }

  // Real episode data
  if (episodes.length > 0) {
    return (
      <div>
        <h2 className="text-lg font-bold text-white mb-4">
          Episodes <span className="text-gray-500 font-normal text-sm ml-1">({episodes.length})</span>
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {episodes.map((ep, i) => {
            const epNum = ep.mal_id || i + 1;
            return (
              <motion.button key={epNum} whileHover={{ y: -2 }} onClick={() => onPlay(epNum)}
                className="flex text-left bg-white/[0.03] hover:bg-white/[0.06] hover:border-fuchsia-500/30 border border-white/5 rounded-xl overflow-hidden group transition-all">
                <div className="relative w-28 sm:w-32 flex-shrink-0 aspect-video bg-black/40 overflow-hidden">
                  <img src={poster} alt="" aria-hidden className="absolute inset-0 w-full h-full object-cover opacity-40 group-hover:opacity-60 group-hover:scale-105 transition-all duration-300" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-9 h-9 rounded-full bg-fuchsia-600/80 backdrop-blur-sm border border-white/20 flex items-center justify-center scale-90 group-hover:scale-100 transition-transform">
                      <PlayIcon className="w-3.5 h-3.5" />
                    </div>
                  </div>
                  <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 bg-black/70 backdrop-blur-sm rounded-md text-[10px] font-bold text-white border border-white/10">
                    EP {epNum}
                  </div>
                </div>
                <div className="flex-1 p-3 min-w-0">
                  <div className="font-semibold text-white text-xs leading-snug line-clamp-2">{ep.title || `Episode ${epNum}`}</div>
                  <div className="flex items-center gap-2 mt-1.5 text-[11px] text-gray-500">
                    {ep.aired && <span>{new Date(ep.aired).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>}
                    {ep.filler && <span className="text-orange-400 font-semibold">Filler</span>}
                    {ep.recap && <span className="text-blue-400 font-semibold">Recap</span>}
                  </div>
                </div>
              </motion.button>
            );
          })}
        </div>
      </div>
    );
  }

  // Fallback numbered grid
  if (fallbackCount > 0) {
    return (
      <div>
        <h2 className="text-lg font-bold text-white mb-4">
          Episodes <span className="text-gray-500 font-normal text-sm ml-1">({fallbackCount})</span>
        </h2>
        <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2.5">
          {Array.from({ length: fallbackCount }, (_, i) => i + 1).map((epNum) => (
            <motion.button key={epNum} whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.97 }} onClick={() => onPlay(epNum)}
              className="relative aspect-[4/3] bg-white/[0.03] hover:bg-fuchsia-600/15 border border-white/5 hover:border-fuchsia-500/40 rounded-xl overflow-hidden group transition-all">
              <img src={poster} alt="" aria-hidden className="absolute inset-0 w-full h-full object-cover opacity-15 group-hover:opacity-25 transition-opacity" />
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-white font-bold text-xl drop-shadow-lg">{epNum}</span>
              </div>
              <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/30">
                <PlayIcon className="w-5 h-5" />
              </div>
            </motion.button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="py-16 text-center">
      <div className="text-5xl mb-3">📺</div>
      <p className="text-gray-400 font-medium">No episode data available yet</p>
      <p className="text-gray-600 text-xs mt-1">Check back later or try watching directly</p>
    </div>
  );
}

// ─── Characters Tab ─────────────────────────────────────────────────────────

function CharactersTab({ main, supporting }: { main: JikanCharacter[]; supporting: JikanCharacter[] }) {
  if (main.length === 0 && supporting.length === 0) {
    return (
      <div className="py-16 text-center">
        <div className="text-5xl mb-3">👥</div>
        <p className="text-gray-400 font-medium">No character data available</p>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      {main.length > 0 && (
        <div>
          <h2 className="text-lg font-bold text-white mb-4">
            Main Characters <span className="text-gray-500 font-normal text-sm ml-1">({main.length})</span>
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
            {main.map((c) => <CharacterCard key={c.character.mal_id} c={c} />)}
          </div>
        </div>
      )}
      {supporting.length > 0 && (
        <div>
          <h2 className="text-lg font-bold text-white mb-4">
            Supporting <span className="text-gray-500 font-normal text-sm ml-1">({supporting.length})</span>
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
            {supporting.map((c) => <CharacterCard key={c.character.mal_id} c={c} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function CharacterCard({ c }: { c: JikanCharacter }) {
  const jp = c.voice_actors?.find((v) => v.language === 'Japanese');
  const img = c.character.images?.webp?.image_url || c.character.images?.jpg?.image_url || '';

  return (
    <div className="flex gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/5 hover:bg-white/[0.06] hover:border-fuchsia-500/20 transition-all group">
      <div className="relative flex-shrink-0">
        <img src={img} alt={c.character.name} loading="lazy"
          className="w-16 h-16 rounded-xl object-cover bg-gray-900 border border-white/5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-white truncate group-hover:text-fuchsia-300 transition-colors">{c.character.name}</div>
        <div className="text-[11px] text-fuchsia-400/80 font-medium mt-0.5">{c.role}</div>
        {jp && (
          <div className="text-[11px] text-gray-500 mt-1 truncate flex items-center gap-1">
            <MicIcon className="w-2.5 h-2.5 flex-shrink-0" />
            {jp.person.name}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Related Tab ────────────────────────────────────────────────────────────

function RelatedTab({ items, onOpen }: { items: AnimeCard[]; onOpen: (a: AnimeCard) => void }) {
  if (items.length === 0) {
    return (
      <div className="py-16 text-center">
        <div className="text-5xl mb-3">🔗</div>
        <p className="text-gray-400 font-medium">No recommendations yet</p>
        <p className="text-gray-600 text-xs mt-1">Recommendations appear as the anime gains popularity</p>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-lg font-bold text-white mb-4">
        You Might Also Like <span className="text-gray-500 font-normal text-sm ml-1">({items.length})</span>
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
        {items.slice(0, 30).map((item, i) => (
          <motion.button key={item.mal_id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i * 0.02, 0.3) }}
            whileHover={{ y: -3 }} onClick={() => onOpen(item)}
            className="group block text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-500 rounded-xl">
            <div className="relative rounded-xl overflow-hidden bg-gray-900 shadow-lg group-hover:shadow-xl group-hover:shadow-fuchsia-500/10 transition-all duration-300">
              <img src={item.image || '/placeholder-poster.jpg'} alt={item.title} loading="lazy"
                className="w-full aspect-[2/3] object-cover group-hover:scale-105 transition-transform duration-500" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/0 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-end p-3">
                <div className="w-8 h-8 rounded-full bg-fuchsia-600/90 flex items-center justify-center border-2 border-white/20">
                  <PlayIcon className="w-3.5 h-3.5" />
                </div>
              </div>
              {item.score != null && (
                <div className="absolute top-2 right-2 px-1.5 py-0.5 bg-black/70 backdrop-blur-sm rounded-md text-[10px] font-bold text-yellow-300 flex items-center gap-1">
                  <Star className="w-2.5 h-2.5" /> {item.score.toFixed(1)}
                </div>
              )}
            </div>
            <div className="mt-2 px-0.5">
              <h3 className="text-white font-semibold text-xs leading-snug line-clamp-2 group-hover:text-fuchsia-300 transition-colors">
                {item.title_english || item.title}
              </h3>
              <div className="flex items-center gap-2 mt-1 text-[10px] text-gray-500 font-medium">
                {item.year && <span>{item.year}</span>}
                {item.type && <span className="uppercase">{item.type}</span>}
                {item.episodes && <span>{item.episodes} eps</span>}
              </div>
            </div>
          </motion.button>
        ))}
      </div>
    </div>
  );
}

// ─── Info Tab ───────────────────────────────────────────────────────────────

function InfoTab({ anime }: { anime: JikanAnime }) {
  const rows = ([
    ['Format', anime.type],
    ['Status', anime.status],
    ['Episodes', anime.episodes?.toString()],
    ['Duration', anime.duration],
    ['Rating', anime.rating],
    ['Season', anime.season ? `${anime.season} ${anime.year || ''}` : undefined],
    ['Aired', anime.aired?.string],
    ['Source', anime.source],
    ['Studios', anime.studios?.map((s) => s.name).join(', ')],
    ['Producers', anime.themes?.length ? anime.themes.map((t: any) => t.name || t).filter(Boolean).slice(0, 5).join(', ') : undefined],
    ['Genres', anime.genres?.map((g) => g.name).join(', ')],
    ['Themes', anime.demographics?.map((d: any) => d.name).join(', ')],
  ] as [string, string | undefined][]).filter(([, v]) => v != null && v !== '' && v !== 'undefined' && v !== 'Not available') as [string, string][];

  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-bold text-white mb-6">Anime Details</h2>
      <div className="rounded-2xl bg-white/[0.03] border border-white/5 overflow-hidden divide-y divide-white/5">
        {rows.map(([label, value], i) => (
          <div key={i} className="flex items-start gap-4 px-5 py-3.5">
            <dt className="text-xs font-semibold text-gray-500 uppercase tracking-wider w-28 flex-shrink-0 pt-0.5">{label}</dt>
            <dd className="text-sm text-gray-200 font-medium">{value}</dd>
          </div>
        ))}
      </div>

      {/* Background */}
      {anime.background && (
        <div className="mt-8">
          <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">Background</h3>
          <p className="text-gray-500 text-sm leading-relaxed">{anime.background}</p>
        </div>
      )}

      {/* Theme songs */}
      {anime.theme?.openings && anime.theme.openings.length > 0 && (
        <div className="mt-8">
          <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">Opening Themes</h3>
          <ul className="space-y-1.5">
            {anime.theme.openings.map((op, i) => (
              <li key={i} className="text-gray-500 text-sm flex items-start gap-2">
                <span className="text-fuchsia-500 font-bold flex-shrink-0">{i + 1}.</span>
                <span>{op.replace(/"/g, '')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {anime.theme?.endings && anime.theme.endings.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">Ending Themes</h3>
          <ul className="space-y-1.5">
            {anime.theme.endings.map((ed, i) => (
              <li key={i} className="text-gray-500 text-sm flex items-start gap-2">
                <span className="text-purple-400 font-bold flex-shrink-0">{i + 1}.</span>
                <span>{ed.replace(/"/g, '')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Trailer Modal ──────────────────────────────────────────────────────────

function TrailerModal({ youtubeId, onClose }: { youtubeId: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-md flex items-center justify-center p-4" onClick={onClose}>
      <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }}
        className="relative w-full max-w-5xl aspect-video" onClick={(e) => e.stopPropagation()}>
        <iframe src={`https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=1&rel=0`} title="Trailer"
          allow="autoplay; encrypted-media; fullscreen" className="w-full h-full rounded-2xl shadow-2xl border border-white/5" />
        <button onClick={onClose} aria-label="Close" className="absolute -top-4 -right-4 w-10 h-10 rounded-full bg-white text-black font-bold shadow-xl flex items-center justify-center hover:scale-105 transition-transform">✕</button>
      </motion.div>
    </motion.div>
  );
}

// ─── Icons ──────────────────────────────────────────────────────────────────

function PlayIcon({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>;
}
function Star({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>;
}
function FilmIcon({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16M17 4v16M3 8h4M3 12h4M3 16h4M17 8h4M17 12h4M17 16h4" /></svg>;
}
function ArrowLeft({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 12H5M12 19l-7-7 7-7" /></svg>;
}
function MicIcon({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><rect x="8" y="1" width="8" height="12" rx="4" /><path d="M4 11a8 8 0 0 0 16 0M12 17v6M9 23h6" /></svg>;
}
