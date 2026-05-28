'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import {
  jikanFull,
  jikanGet,
  jikanEpisodes,
  jikanCharacters,
  jikanRecommendations,
  type JikanAnime,
  type JikanEpisode,
  type JikanCharacter,
  type AnimeCard,
} from '@/lib/anime/jikan-client';

const SEQUEL_TYPES = new Set([
  'Sequel',
  'Prequel',
  'Side story',
  'Alternative version',
  'Spin-off',
]);

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

type Tab = 'episodes' | 'characters' | 'related';

// ─── Component ──────────────────────────────────────────────────────────────

export default function AnimeDetailsClient({ malId }: { malId: number }) {
  const router = useRouter();
  const [anime, setAnime] = useState<JikanAnime | null>(null);
  const [seasons, setSeasons] = useState<SeasonEntry[]>([]);
  const [selectedSeasonIdx, setSelectedSeasonIdx] = useState(0);
  const [episodes, setEpisodes] = useState<JikanEpisode[]>([]);
  const [characters, setCharacters] = useState<JikanCharacter[]>([]);
  const [recommendations, setRecommendations] = useState<AnimeCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<Tab>('episodes');
  const [synopsisExpanded, setSynopsisExpanded] = useState(false);
  const [trailerOpen, setTrailerOpen] = useState(false);

  // ─── Main load: primary anime + seasons + side data ─────────────────────
  useEffect(() => {
    if (!malId) { setError(true); setLoading(false); return; }
    let cancelled = false;

    (async () => {
      const data = await jikanFull(malId);
      if (cancelled) return;
      if (!data) { setError(true); setLoading(false); return; }
      setAnime(data);

      // Seed seasons list with main entry
      const seasonEntries: SeasonEntry[] = [{
        malId: data.mal_id,
        title: data.title,
        titleEnglish: data.title_english,
        imageUrl:
          data.images?.webp?.large_image_url ||
          data.images?.jpg?.large_image_url ||
          data.images?.jpg?.image_url || '',
        episodes: data.episodes,
        score: data.score,
        type: data.type,
        status: data.status,
        year: data.year,
        seasonOrder: 1,
      }];

      // Resolve related seasons (sequels/prequels/etc.)
      const relations = data.relations || [];
      const relatedIds = relations
        .filter((r) => SEQUEL_TYPES.has(r.relation))
        .flatMap((r) => r.entry)
        .filter((e) => e.type === 'anime' && e.mal_id !== data.mal_id);

      for (const rel of relatedIds) {
        if (cancelled) return;
        if (seasonEntries.some((s) => s.malId === rel.mal_id)) continue;
        const r = await jikanGet(rel.mal_id);
        if (cancelled) return;
        if (!r) continue;
        seasonEntries.push({
          malId: r.mal_id,
          title: r.title,
          titleEnglish: r.title_english,
          imageUrl:
            r.images?.webp?.large_image_url ||
            r.images?.jpg?.large_image_url ||
            r.images?.jpg?.image_url || '',
          episodes: r.episodes,
          score: r.score,
          type: r.type,
          status: r.status,
          year: r.year,
          seasonOrder: 0,
        });
      }

      // Sort by year ascending and renumber
      seasonEntries.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999));
      seasonEntries.forEach((s, i) => { s.seasonOrder = i + 1; });

      if (cancelled) return;
      setSeasons(seasonEntries);

      // Find index of THIS entry within sorted list
      const idx = seasonEntries.findIndex((s) => s.malId === data.mal_id);
      if (idx > 0) setSelectedSeasonIdx(idx);

      setLoading(false);

      // Side data: episodes for current season, characters, recommendations
      const targetId = data.mal_id;
      const [eps, chars, recs] = await Promise.all([
        jikanEpisodes(targetId),
        jikanCharacters(targetId),
        jikanRecommendations(targetId),
      ]);
      if (cancelled) return;
      setEpisodes(eps);
      setCharacters(chars);
      setRecommendations(recs);
    })();

    return () => { cancelled = true; };
  }, [malId]);

  // ─── When selected season changes, refetch episodes/characters ──────────
  const selectedSeason = seasons[selectedSeasonIdx];
  const selectedMalId = selectedSeason?.malId ?? null;
  useEffect(() => {
    if (selectedMalId == null || selectedMalId === malId) return;
    let cancelled = false;
    (async () => {
      setEpisodes([]);
      setCharacters([]);
      const [eps, chars] = await Promise.all([
        jikanEpisodes(selectedMalId),
        jikanCharacters(selectedMalId),
      ]);
      if (cancelled) return;
      setEpisodes(eps);
      setCharacters(chars);
    })();
    return () => { cancelled = true; };
  }, [selectedMalId, malId]);

  // ─── Derived ────────────────────────────────────────────────────────────
  const isMovie = anime?.type === 'Movie';
  const mainCharacters = useMemo(
    () => characters.filter((c) => c.role === 'Main').slice(0, 12),
    [characters],
  );
  const trailerYoutubeId = anime?.trailer?.youtube_id || null;
  const episodeCountKnown =
    episodes.length > 0
      ? episodes.length
      : selectedSeason?.episodes ?? anime?.episodes ?? 0;

  const playable = useCallback((epNum: number) => {
    const target = selectedSeason?.malId ?? anime?.mal_id ?? malId;
    if (isMovie) router.push(`/anime/${target}/watch`);
    else router.push(`/anime/${target}/watch?episode=${epNum}`);
  }, [selectedSeason, anime, isMovie, malId, router]);

  const handleWatchPrimary = useCallback(() => playable(1), [playable]);

  // ─── States ─────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0812] flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-fuchsia-500/30 border-t-fuchsia-400 rounded-full animate-spin" />
      </div>
    );
  }
  if (error || !anime) {
    return (
      <div className="min-h-screen bg-[#0a0812] flex items-center justify-center text-center">
        <div>
          <p className="text-white text-lg mb-3">Failed to load anime</p>
          <button
            onClick={() => router.push('/anime')}
            className="px-4 py-2 bg-fuchsia-600 hover:bg-fuchsia-500 text-white rounded-lg"
          >
            Back to Anime
          </button>
        </div>
      </div>
    );
  }

  const poster =
    anime.images?.webp?.large_image_url ||
    anime.images?.jpg?.large_image_url ||
    anime.images?.jpg?.image_url || '';

  return (
    <div className="min-h-screen bg-[#0a0812] text-white">
      <button
        onClick={() => router.push('/anime')}
        className="fixed top-20 left-4 z-50 px-3.5 py-1.5 bg-black/50 backdrop-blur-md border border-white/10 hover:border-fuchsia-500/50 rounded-lg text-sm text-white transition-colors"
      >
        ← Back
      </button>

      {/* Hero */}
      <Hero
        anime={anime}
        poster={poster}
        seasons={seasons}
        onWatch={handleWatchPrimary}
        onTrailer={() => setTrailerOpen(true)}
        hasTrailer={!!trailerYoutubeId}
        synopsisExpanded={synopsisExpanded}
        onToggleSynopsis={() => setSynopsisExpanded((v) => !v)}
      />

      {/* Season Selector */}
      {!isMovie && seasons.length > 1 && (
        <div className="px-4 md:px-8 py-4 border-b border-white/5">
          <div className="max-w-6xl mx-auto">
            <h3 className="text-xs uppercase tracking-wider text-gray-400 font-semibold mb-2">
              Seasons & Related
            </h3>
            <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
              {seasons.map((s, i) => (
                <button
                  key={s.malId}
                  onClick={() => setSelectedSeasonIdx(i)}
                  className={`flex-shrink-0 px-3.5 py-2 rounded-lg text-sm font-medium transition-colors ${
                    selectedSeasonIdx === i
                      ? 'bg-fuchsia-600 text-white shadow-lg shadow-fuchsia-900/40'
                      : 'bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10'
                  }`}
                >
                  <span className="block">{s.titleEnglish || s.title}</span>
                  <span className="block text-[10px] opacity-60 mt-0.5">
                    {s.year ?? '—'} · {s.episodes ?? '?'} eps
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="px-4 md:px-8 pt-6">
        <div className="max-w-6xl mx-auto">
          <div className="flex gap-1 border-b border-white/5">
            {(['episodes', 'characters', 'related'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`relative px-4 py-2.5 text-sm font-medium capitalize transition-colors ${
                  tab === t ? 'text-white' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {t}
                {tab === t && (
                  <motion.div
                    layoutId="anime-tabs-underline"
                    className="absolute left-2 right-2 -bottom-px h-0.5 bg-fuchsia-500 rounded-full"
                  />
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Tab content */}
      <div className="px-4 md:px-8 pb-20 pt-6">
        <div className="max-w-6xl mx-auto">
          {tab === 'episodes' && (
            <EpisodesGrid
              episodes={episodes}
              fallbackCount={episodeCountKnown}
              poster={poster}
              isMovie={isMovie}
              onPlay={playable}
              onWatchMovie={handleWatchPrimary}
            />
          )}
          {tab === 'characters' && (
            <CharactersGrid characters={mainCharacters} />
          )}
          {tab === 'related' && (
            <RelatedGrid items={recommendations} onOpen={(a) => router.push(`/anime/${a.mal_id}`)} />
          )}
        </div>
      </div>

      {/* Trailer modal */}
      {trailerOpen && trailerYoutubeId && (
        <TrailerModal
          youtubeId={trailerYoutubeId}
          onClose={() => setTrailerOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Hero ───────────────────────────────────────────────────────────────────

function Hero({
  anime, poster, seasons, onWatch, onTrailer, hasTrailer, synopsisExpanded, onToggleSynopsis,
}: {
  anime: JikanAnime;
  poster: string;
  seasons: SeasonEntry[];
  onWatch: () => void;
  onTrailer: () => void;
  hasTrailer: boolean;
  synopsisExpanded: boolean;
  onToggleSynopsis: () => void;
}) {
  return (
    <div className="relative pt-24 pb-10 px-4 md:px-8 overflow-hidden">
      <div className="absolute inset-0">
        <img src={poster} alt="" aria-hidden className="w-full h-full object-cover blur-3xl opacity-25 scale-110" />
        <div className="absolute inset-0 bg-gradient-to-b from-[#0a0812]/40 via-[#0a0812]/80 to-[#0a0812]" />
      </div>

      <div className="relative max-w-6xl mx-auto flex flex-col md:flex-row gap-8">
        <div className="flex-shrink-0 w-48 md:w-56 mx-auto md:mx-0">
          <div className="relative rounded-xl overflow-hidden shadow-2xl border border-white/10">
            <img src={poster} alt={anime.title} className="w-full" />
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <h1 className="text-3xl md:text-5xl font-black text-white leading-tight">
            {anime.title_english || anime.title}
          </h1>
          {anime.title_english && anime.title_english !== anime.title && (
            <p className="text-gray-400 mt-1 text-sm md:text-base">{anime.title}</p>
          )}

          {/* Stat strip */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-3 text-sm text-gray-300">
            {anime.score != null && (
              <span className="inline-flex items-center gap-1 text-yellow-300 font-semibold">
                ★ {anime.score.toFixed(2)}
              </span>
            )}
            {anime.rank && <Pill>#{anime.rank}</Pill>}
            <Pill>{anime.type}</Pill>
            <Pill>{anime.status}</Pill>
            {anime.year && <Pill>{anime.year}</Pill>}
            {seasons.length > 1 && <Pill>{seasons.length} Seasons</Pill>}
            {anime.duration && <Pill>{anime.duration}</Pill>}
            {anime.rating && <Pill>{anime.rating.split(' - ')[0]}</Pill>}
          </div>

          {/* Genres */}
          {anime.genres.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {anime.genres.map((g) => (
                <span
                  key={g.mal_id}
                  className="px-2 py-0.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full text-xs text-gray-300 transition-colors"
                >
                  {g.name}
                </span>
              ))}
            </div>
          )}

          {/* Synopsis */}
          {anime.synopsis && (
            <div className="mt-4">
              <p className={`text-gray-300 text-sm leading-relaxed ${synopsisExpanded ? '' : 'line-clamp-4'}`}>
                {anime.synopsis}
              </p>
              {anime.synopsis.length > 280 && (
                <button
                  onClick={onToggleSynopsis}
                  className="text-fuchsia-400 hover:text-fuchsia-300 text-xs mt-1 font-medium"
                >
                  {synopsisExpanded ? 'Show less' : 'Read more'}
                </button>
              )}
            </div>
          )}

          {/* Studios */}
          {anime.studios && anime.studios.length > 0 && (
            <div className="mt-3 text-xs text-gray-500">
              <span className="text-gray-600">Studio:</span>{' '}
              {anime.studios.map((s) => s.name).join(', ')}
            </div>
          )}

          {/* Action buttons */}
          <div className="mt-5 flex flex-wrap gap-3">
            <button
              onClick={onWatch}
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-gradient-to-r from-fuchsia-500 to-pink-500 hover:from-fuchsia-400 hover:to-pink-400 text-white font-semibold shadow-lg shadow-fuchsia-900/40 transition-all"
            >
              <PlayIcon className="w-4 h-4" />
              {anime.type === 'Movie' ? 'Watch Movie' : 'Watch Now'}
            </button>
            {hasTrailer && (
              <button
                onClick={onTrailer}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white text-sm font-medium transition-colors"
              >
                <FilmIcon className="w-4 h-4" />
                Trailer
              </button>
            )}
          </div>

          {/* Theme songs */}
          {(anime.theme?.openings?.length || anime.theme?.endings?.length) ? (
            <details className="mt-5 group">
              <summary className="text-xs uppercase tracking-wider text-gray-500 cursor-pointer hover:text-gray-300 select-none">
                Theme Songs
              </summary>
              <div className="mt-2 grid sm:grid-cols-2 gap-3 text-xs text-gray-400">
                {anime.theme?.openings && anime.theme.openings.length > 0 && (
                  <div>
                    <div className="text-gray-300 font-semibold mb-1">Openings</div>
                    <ul className="space-y-0.5">
                      {anime.theme.openings.map((t, i) => <li key={i}>{t}</li>)}
                    </ul>
                  </div>
                )}
                {anime.theme?.endings && anime.theme.endings.length > 0 && (
                  <div>
                    <div className="text-gray-300 font-semibold mb-1">Endings</div>
                    <ul className="space-y-0.5">
                      {anime.theme.endings.map((t, i) => <li key={i}>{t}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="px-2 py-0.5 bg-white/5 border border-white/10 rounded text-xs text-gray-300">
      {children}
    </span>
  );
}

// ─── Episodes grid ─────────────────────────────────────────────────────────

function EpisodesGrid({
  episodes, fallbackCount, poster, isMovie, onPlay, onWatchMovie,
}: {
  episodes: JikanEpisode[];
  fallbackCount: number;
  poster: string;
  isMovie: boolean;
  onPlay: (epNum: number) => void;
  onWatchMovie: () => void;
}) {
  if (isMovie) {
    return (
      <div className="rounded-xl bg-white/5 border border-white/10 p-6 flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-gray-500 mb-1">Movie</div>
          <div className="text-lg font-semibold text-white">Single feature presentation</div>
        </div>
        <button
          onClick={onWatchMovie}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 text-white font-medium"
        >
          <PlayIcon className="w-4 h-4" />
          Play
        </button>
      </div>
    );
  }

  // Real titled episodes if Jikan returned them; else fallback to numbered tiles
  if (episodes.length > 0) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {episodes.map((ep, i) => {
          const epNum = ep.mal_id || i + 1;
          return (
            <motion.button
              key={epNum}
              whileHover={{ y: -2 }}
              onClick={() => onPlay(epNum)}
              className="text-left bg-white/5 hover:bg-white/10 hover:border-fuchsia-500/40 border border-white/10 rounded-xl overflow-hidden group transition-colors"
            >
              <div className="flex">
                <div className="relative w-32 flex-shrink-0 aspect-video bg-black">
                  <img src={poster} alt="" aria-hidden className="absolute inset-0 w-full h-full object-cover opacity-50 group-hover:opacity-70 transition-opacity" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-9 h-9 rounded-full bg-fuchsia-600/80 backdrop-blur-sm border border-white/20 flex items-center justify-center scale-90 group-hover:scale-100 transition-transform">
                      <PlayIcon className="w-3.5 h-3.5" />
                    </div>
                  </div>
                  <div className="absolute top-1 left-1 px-1.5 py-0.5 bg-black/70 rounded text-[10px] font-bold text-white">
                    EP {epNum}
                  </div>
                </div>
                <div className="flex-1 p-3 min-w-0">
                  <div className="font-medium text-white text-sm line-clamp-2 leading-tight">
                    {ep.title || `Episode ${epNum}`}
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-[11px] text-gray-500">
                    {ep.aired && <span>{new Date(ep.aired).toLocaleDateString()}</span>}
                    {ep.filler && <span className="text-orange-400">Filler</span>}
                    {ep.recap && <span className="text-blue-400">Recap</span>}
                  </div>
                </div>
              </div>
            </motion.button>
          );
        })}
      </div>
    );
  }

  if (fallbackCount > 0) {
    return (
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 gap-2.5">
        {Array.from({ length: fallbackCount }, (_, i) => i + 1).map((epNum) => (
          <motion.button
            key={epNum}
            whileHover={{ scale: 1.03 }}
            onClick={() => onPlay(epNum)}
            className="relative aspect-video bg-white/5 hover:bg-fuchsia-600/20 border border-white/10 hover:border-fuchsia-500/50 rounded-lg overflow-hidden group transition-colors"
          >
            <img src={poster} alt="" aria-hidden className="absolute inset-0 w-full h-full object-cover opacity-25" />
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-white font-bold text-lg drop-shadow">{epNum}</span>
            </div>
            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/30">
              <div className="w-9 h-9 rounded-full bg-fuchsia-600 flex items-center justify-center">
                <PlayIcon className="w-3.5 h-3.5" />
              </div>
            </div>
          </motion.button>
        ))}
      </div>
    );
  }

  return <div className="py-12 text-center text-gray-500 text-sm">No episode info available.</div>;
}

// ─── Characters grid ───────────────────────────────────────────────────────

function CharactersGrid({ characters }: { characters: JikanCharacter[] }) {
  if (characters.length === 0) {
    return <div className="py-12 text-center text-gray-500 text-sm">No character data available.</div>;
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {characters.map((c) => {
        const jp = c.voice_actors?.find((v) => v.language === 'Japanese');
        const img =
          c.character.images?.webp?.image_url ||
          c.character.images?.jpg?.image_url || '';
        return (
          <div
            key={c.character.mal_id}
            className="flex gap-3 p-2 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
          >
            <img src={img} alt={c.character.name} loading="lazy" className="w-14 h-14 rounded-md object-cover bg-black flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-white truncate">{c.character.name}</div>
              <div className="text-[11px] text-fuchsia-300 mt-0.5">{c.role}</div>
              {jp && (
                <div className="text-[11px] text-gray-500 mt-0.5 truncate">VA: {jp.person.name}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Related/recommendations ────────────────────────────────────────────────

function RelatedGrid({ items, onOpen }: { items: AnimeCard[]; onOpen: (a: AnimeCard) => void }) {
  if (items.length === 0) {
    return <div className="py-12 text-center text-gray-500 text-sm">No recommendations available.</div>;
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
      {items.slice(0, 24).map((item) => (
        <button
          key={item.mal_id}
          onClick={() => onOpen(item)}
          className="group block text-left"
        >
          <div className="relative rounded-lg overflow-hidden bg-gray-900 shadow group-hover:shadow-fuchsia-500/20 group-hover:shadow-lg transition-all">
            <img
              src={item.image || '/placeholder-poster.jpg'}
              alt={item.title}
              loading="lazy"
              className="w-full aspect-[2/3] object-cover group-hover:scale-105 transition-transform"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/0 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          <div className="mt-1.5 text-xs font-medium text-white line-clamp-2 group-hover:text-fuchsia-300 transition-colors leading-tight">
            {item.title_english || item.title}
          </div>
        </button>
      ))}
    </div>
  );
}

// ─── Trailer modal ─────────────────────────────────────────────────────────

function TrailerModal({ youtubeId, onClose }: { youtubeId: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="relative w-full max-w-4xl aspect-video" onClick={(e) => e.stopPropagation()}>
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=1&rel=0`}
          title="Trailer"
          allow="autoplay; encrypted-media; fullscreen"
          className="w-full h-full rounded-xl shadow-2xl"
        />
        <button
          onClick={onClose}
          aria-label="Close trailer"
          className="absolute -top-3 -right-3 w-9 h-9 rounded-full bg-white text-black font-bold shadow-lg"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

// ─── Icons ─────────────────────────────────────────────────────────────────

function PlayIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
function FilmIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 4v16M17 4v16M3 8h4M3 12h4M3 16h4M17 8h4M17 12h4M17 16h4" />
    </svg>
  );
}
