'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { ExtensionGate } from '@/components/ExtensionGate';
import {
  jikanList,
  jikanSearch,
  GENRES,
  type AnimeCard as Anime,
} from '@/lib/anime/jikan-client';

// ─── Category definitions ──────────────────────────────────────────────────

interface CategoryDef {
  id: string;
  title: string;
  subtitle: string;
  endpoint: string;
}

const FEATURED_DEFS: CategoryDef[] = [
  { id: 'airing',   title: 'Currently Airing', subtitle: 'Fresh episodes this season', endpoint: '/seasons/now?limit=30' },
  { id: 'popular',  title: 'Most Popular',     subtitle: 'All-time fan favorites',   endpoint: '/top/anime?limit=30&filter=bypopularity' },
  { id: 'top-rated',title: 'Top Rated',         subtitle: 'Highest scored by the community', endpoint: '/top/anime?limit=30' },
  { id: 'upcoming', title: 'Upcoming',          subtitle: 'Coming next season',      endpoint: '/seasons/upcoming?limit=30' },
  { id: 'movies',   title: 'Anime Movies',      subtitle: 'Feature-length gems',     endpoint: '/top/anime?limit=30&type=movie' },
];

const ALL_TAB = 'all';

// ─── Main Component ─────────────────────────────────────────────────────────

export default function AnimePageClient() {
  return (
    <ExtensionGate type="anime">
      <AnimePageClientInner />
    </ExtensionGate>
  );
}

function AnimePageClientInner() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<string>(ALL_TAB);
  const [hero, setHero] = useState<{ item: Anime; idx: number } | null>(null);
  const [featured, setFeatured] = useState<Record<string, Anime[]>>({});
  const [genreData, setGenreData] = useState<Record<string, Anime[]>>({});
  const [loadingFeatured, setLoadingFeatured] = useState(true);
  const [loadingGenre, setLoadingGenre] = useState(false);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Anime[] | null>(null);
  const [searching, setSearching] = useState(false);
  const heroTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Initial load ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      FEATURED_DEFS.forEach((def) => {
        jikanList(def.endpoint).then((items) => {
          if (cancelled) return;
          setFeatured((prev) => ({ ...prev, [def.id]: items }));
        });
      });
      await jikanList(FEATURED_DEFS[FEATURED_DEFS.length - 1].endpoint);
      if (!cancelled) setLoadingFeatured(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // ─── Hero rotation ───────────────────────────────────────────────────────
  useEffect(() => {
    const candidates = (featured.popular || featured.airing || []);
    if (candidates.length === 0) return;
    const top = candidates.slice(0, 8);
    setHero({ item: top[0], idx: 0 });
    if (top.length <= 1) return;
    heroTimer.current = setInterval(() => {
      setHero((prev) => {
        const next = ((prev?.idx ?? 0) + 1) % top.length;
        return { item: top[next], idx: next };
      });
    }, 6000);
    return () => { if (heroTimer.current) clearInterval(heroTimer.current); };
  }, [featured.popular, featured.airing]);

  // ─── Genre lazy load ─────────────────────────────────────────────────────
  useEffect(() => {
    if (activeTab === ALL_TAB) return;
    const genre = GENRES.find((g) => String(g.id) === activeTab);
    if (!genre || genreData[activeTab]?.length) return;
    let cancelled = false;
    setLoadingGenre(true);
    (async () => {
      const items = await jikanList(
        `/anime?genres=${genre.id}&order_by=popularity&sort=desc&limit=40&sfw=true`,
      );
      if (cancelled) return;
      setGenreData((prev) => ({ ...prev, [activeTab]: items }));
      setLoadingGenre(false);
    })();
    return () => { cancelled = true; };
  }, [activeTab, genreData]);

  // ─── Debounced search ────────────────────────────────────────────────────
  useEffect(() => {
    if (!query.trim()) { setSearchResults(null); return; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      const items = await jikanSearch(query);
      if (cancelled) return;
      setSearchResults(items);
      setSearching(false);
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  const openAnime = useCallback((item: Anime) => router.push(`/anime/${item.mal_id}`), [router]);
  const selectHero = useCallback((idx: number) => {
    const candidates = (featured.popular || featured.airing || []).slice(0, 8);
    if (candidates[idx]) { setHero({ item: candidates[idx], idx }); }
    if (heroTimer.current) clearInterval(heroTimer.current);
    heroTimer.current = setInterval(() => {
      setHero((prev) => {
        const next = ((prev?.idx ?? 0) + 1) % candidates.length;
        return { item: candidates[next], idx: next };
      });
    }, 6000);
  }, [featured.popular, featured.airing]);

  const showSearch = searchResults !== null;
  const showGenre = activeTab !== ALL_TAB && !showSearch;
  const showFeatured = activeTab === ALL_TAB && !showSearch;

  return (
    <div className="min-h-screen bg-[#07060a] text-white selection:bg-fuchsia-500/30">
      {/* Hero */}
      <HeroSection hero={hero} featured={featured} onSelectIdx={selectHero} onPlay={openAnime} loading={loadingFeatured} />

      {/* Controls */}
      <StickyBar query={query} onQuery={setQuery} activeTab={activeTab} onTab={setActiveTab} disabled={showSearch} />

      {/* Body */}
      <main className="pb-24">
        <AnimatePresence mode="wait">
          {showSearch && (
            <motion.div key="search" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <SearchResults query={query} results={searchResults} loading={searching} onOpen={openAnime} />
            </motion.div>
          )}
          {showGenre && (
            <motion.div key="genre" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <GenreView genreId={activeTab} items={genreData[activeTab] || []} loading={loadingGenre} onOpen={openAnime} />
            </motion.div>
          )}
          {showFeatured && (
            <motion.div key="featured" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-12 pt-4">
              {FEATURED_DEFS.map((def) => {
                const items = featured[def.id];
                if (items === undefined) return <RowSkeleton key={def.id} title={def.title} subtitle={def.subtitle} />;
                if (items.length === 0) return null;
                return <CategoryRow key={def.id} title={def.title} subtitle={def.subtitle} items={items} onItemClick={openAnime} />;
              })}
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

// ─── Hero ───────────────────────────────────────────────────────────────────

function HeroSection({ hero, featured, onSelectIdx, onPlay, loading }: {
  hero: { item: Anime; idx: number } | null;
  featured: Record<string, Anime[]>;
  onSelectIdx: (i: number) => void;
  onPlay: (item: Anime) => void;
  loading: boolean;
}) {
  const candidates = (featured.popular || featured.airing || []).slice(0, 8);
  const current = hero?.item;

  if (loading || !current) {
    return (
      <section className="relative h-[55vh] min-h-[380px] max-h-[600px] flex items-center justify-center bg-gradient-to-b from-fuchsia-950/20 via-[#07060a] to-[#07060a]">
        <div className="w-10 h-10 rounded-full border-2 border-fuchsia-500/20 border-t-fuchsia-400 animate-spin" />
      </section>
    );
  }

  return (
    <section className="relative h-[65vh] min-h-[480px] max-h-[720px] overflow-hidden">
      {/* BG image with parallax-ish scale */}
      <motion.div
        key={current.mal_id}
        initial={{ opacity: 0, scale: 1.05 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.8 }}
        className="absolute inset-0"
      >
        <img src={current.image} alt="" aria-hidden className="w-full h-full object-cover scale-110" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#07060a] via-[#07060a]/70 to-[#07060a]/30" />
        <div className="absolute inset-0 bg-gradient-to-r from-[#07060a]/80 via-[#07060a]/40 to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 h-48 bg-gradient-to-t from-[#07060a] to-transparent" />
      </motion.div>

      {/* Content */}
      <div className="relative h-full max-w-[1440px] mx-auto px-6 md:px-12 flex items-end pb-12 md:pb-20">
        <motion.div
          key={current.mal_id}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.15 }}
          className="max-w-2xl"
        >
          {/* Badges */}
          <div className="flex items-center gap-2 mb-4">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-fuchsia-500/15 border border-fuchsia-400/30 rounded-full text-[11px] font-semibold text-fuchsia-300 uppercase tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              Featured
            </span>
            {current.score != null && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-yellow-500/10 border border-yellow-500/20 rounded-full text-xs text-yellow-300 font-semibold">
                <Star className="w-3 h-3" /> {current.score.toFixed(2)}
              </span>
            )}
            <span className="px-2.5 py-1 bg-white/5 border border-white/10 rounded-full text-[10px] text-gray-400 uppercase tracking-wider">
              {current.type}
            </span>
          </div>

          {/* Title */}
          <h1 className="text-4xl md:text-6xl lg:text-7xl font-black leading-[1.05] text-white drop-shadow-2xl line-clamp-2">
            {current.title_english || current.title}
          </h1>
          {current.title_english && current.title !== current.title_english && (
            <p className="text-gray-400 text-sm md:text-base mt-2 font-medium">{current.title}</p>
          )}

          {/* Meta */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-sm text-gray-400 font-medium">
            {current.year && <span>{current.year}</span>}
            {current.episodes && <span>{current.episodes} episodes</span>}
          </div>

          {/* CTA */}
          <div className="mt-6 flex gap-3">
            <button
              onClick={() => onPlay(current)}
              className="inline-flex items-center gap-2.5 px-7 py-3.5 rounded-2xl bg-gradient-to-r from-fuchsia-500 to-purple-500 hover:from-fuchsia-400 hover:to-purple-400 text-white font-bold text-sm shadow-2xl shadow-fuchsia-500/25 transition-all hover:scale-[1.02] active:scale-[0.98]"
            >
              <PlayIcon className="w-5 h-5" />
              View Details
            </button>
          </div>

          {/* Dots */}
          {candidates.length > 1 && (
            <div className="flex gap-2 mt-6">
              {candidates.map((_, i) => (
                <button
                  key={i}
                  onClick={() => onSelectIdx(i)}
                  className={`h-1 rounded-full transition-all duration-300 ${
                    i === hero?.idx ? 'w-7 bg-fuchsia-400' : 'w-4 bg-white/20 hover:bg-white/40'
                  }`}
                />
              ))}
            </div>
          )}
        </motion.div>
      </div>
    </section>
  );
}

// ─── Sticky bar ─────────────────────────────────────────────────────────────

function StickyBar({ query, onQuery, activeTab, onTab, disabled }: {
  query: string; onQuery: (q: string) => void; activeTab: string; onTab: (id: string) => void; disabled: boolean;
}) {
  return (
    <div className="sticky top-0 z-40 bg-[#07060a]/80 backdrop-blur-xl border-b border-white/5">
      <div className="max-w-[1440px] mx-auto px-4 md:px-6 py-3 space-y-3">
        <div className="relative max-w-md">
          <SearchIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="search" value={query} onChange={(e) => onQuery(e.target.value)}
            placeholder="Search anime by title…"
            className="w-full pl-10 pr-10 py-2.5 bg-white/5 border border-white/10 focus:border-fuchsia-500/50 focus:bg-white/8 rounded-xl text-sm text-white placeholder:text-gray-500 outline-none transition-all"
          />
          {query && (
            <button onClick={() => onQuery('')} aria-label="Clear"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full hover:bg-white/10 text-gray-500 hover:text-white text-xs flex items-center justify-center transition">
              ✕
            </button>
          )}
        </div>
        <div className={`flex gap-1.5 overflow-x-auto pb-1 ${disabled ? 'opacity-40 pointer-events-none' : ''}`} style={{ scrollbarWidth: 'none' }}>
          <Pill active={activeTab === ALL_TAB} onClick={() => onTab(ALL_TAB)}>✦ All</Pill>
          {GENRES.map((g) => (
            <Pill key={g.id} active={activeTab === String(g.id)} onClick={() => onTab(String(g.id))}>{g.name}</Pill>
          ))}
        </div>
      </div>
    </div>
  );
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`flex-shrink-0 px-4 py-2 rounded-full text-xs font-semibold border transition-all duration-200 whitespace-nowrap ${
      active ? 'bg-fuchsia-600/80 border-fuchsia-500 text-white shadow-lg shadow-fuchsia-500/20' : 'bg-white/5 border-white/8 text-gray-400 hover:bg-white/10 hover:text-white hover:border-white/15'
    }`}>{children}</button>
  );
}

// ─── Category row (horizontal scroller) ─────────────────────────────────────

function CategoryRow({ title, subtitle, items, onItemClick }: {
  title: string; subtitle: string; items: Anime[]; onItemClick: (item: Anime) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollL, setCanScrollL] = useState(false);
  const [canScrollR, setCanScrollR] = useState(true);

  const checkScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollL(el.scrollLeft > 4);
    setCanScrollR(el.scrollLeft < el.scrollWidth - el.clientWidth - 4);
  };

  const scroll = (dir: 'left' | 'right') => {
    scrollRef.current?.scrollBy({ left: dir === 'left' ? -600 : 600, behavior: 'smooth' });
  };

  return (
    <section className="px-4 md:px-6">
      <div className="max-w-[1440px] mx-auto">
        <div className="flex items-end justify-between mb-4">
          <div>
            <h2 className="text-xl md:text-2xl font-bold text-white tracking-tight">{title}</h2>
            <p className="text-gray-500 text-xs mt-0.5">{subtitle}</p>
          </div>
          <div className="hidden sm:flex gap-1.5">
            <ArrowBtn dir="left" onClick={() => scroll('left')} disabled={!canScrollL} />
            <ArrowBtn dir="right" onClick={() => scroll('right')} disabled={!canScrollR} />
          </div>
        </div>
        <div className="relative">
          {canScrollL && <div className="absolute left-0 top-0 bottom-0 w-12 bg-gradient-to-r from-[#07060a] to-transparent z-10 pointer-events-none" />}
          <div ref={scrollRef} onScroll={checkScroll}
            className="flex gap-3 overflow-x-auto pb-2 scroll-smooth" style={{ scrollbarWidth: 'none' }}>
            {items.map((item, i) => (
              <motion.div key={item.mal_id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i * 0.03, 0.4) }}
                className="flex-shrink-0 w-[155px] sm:w-[170px] md:w-[185px]">
                <PosterCard item={item} onClick={() => onItemClick(item)} rank={i < 10 ? i + 1 : undefined} />
              </motion.div>
            ))}
          </div>
          {canScrollR && <div className="absolute right-0 top-0 bottom-0 w-12 bg-gradient-to-l from-[#07060a] to-transparent z-10 pointer-events-none" />}
        </div>
      </div>
    </section>
  );
}

function ArrowBtn({ dir, onClick, disabled }: { dir: 'left' | 'right'; onClick: () => void; disabled: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} aria-label={dir === 'left' ? 'Scroll left' : 'Scroll right'}
      className="w-9 h-9 rounded-full bg-white/5 hover:bg-fuchsia-600/40 hover:border-fuchsia-500/50 border border-white/8 text-white text-lg flex items-center justify-center transition-all disabled:opacity-30 disabled:cursor-not-allowed">
      {dir === 'left' ? '‹' : '›'}
    </button>
  );
}

// ─── Search results ─────────────────────────────────────────────────────────

function SearchResults({ query, results, loading, onOpen }: {
  query: string; results: Anime[] | null; loading: boolean; onOpen: (a: Anime) => void;
}) {
  return (
    <section className="px-4 md:px-6 pt-8">
      <div className="max-w-[1440px] mx-auto">
        <div className="flex items-baseline gap-3 mb-6">
          <h2 className="text-2xl font-bold text-white">
            {loading ? 'Searching…' : `Results for "${query}"`}
          </h2>
          {!loading && results && <span className="text-sm text-gray-500">({results.length} anime found)</span>}
        </div>
        {loading && <GridSkeleton count={18} />}
        {!loading && results && results.length === 0 && (
          <div className="py-20 text-center">
            <div className="text-5xl mb-4">🔍</div>
            <p className="text-gray-400 text-lg">No anime found for &ldquo;{query}&rdquo;</p>
            <p className="text-gray-600 text-sm mt-1">Try a different title or browse by genre</p>
          </div>
        )}
        {!loading && results && results.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-5">
            {results.map((item) => <PosterCard key={item.mal_id} item={item} onClick={() => onOpen(item)} />)}
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Genre view ─────────────────────────────────────────────────────────────

function GenreView({ genreId, items, loading, onOpen }: {
  genreId: string; items: Anime[]; loading: boolean; onOpen: (a: Anime) => void;
}) {
  const genre = GENRES.find((g) => String(g.id) === genreId);
  return (
    <section className="px-4 md:px-6 pt-8">
      <div className="max-w-[1440px] mx-auto">
        <div className="mb-6">
          <h2 className="text-3xl font-bold text-white tracking-tight">{genre?.name ?? 'Genre'}</h2>
          <p className="text-gray-500 text-sm mt-1">Browse the best {genre?.name?.toLowerCase()} anime</p>
        </div>
        {loading && items.length === 0 ? <GridSkeleton count={24} /> : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-5">
            {items.map((item, i) => (
              <motion.div key={item.mal_id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.02, 0.3) }}>
                <PosterCard item={item} onClick={() => onOpen(item)} />
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Poster card ────────────────────────────────────────────────────────────

function PosterCard({ item, onClick, rank }: { item: Anime; onClick: () => void; rank?: number }) {
  return (
    <motion.button
      onClick={onClick}
      whileHover={{ y: -4, transition: { duration: 0.2 } }}
      className="group block w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-500 rounded-xl"
    >
      <div className="relative rounded-xl overflow-hidden bg-gray-900 shadow-lg group-hover:shadow-2xl group-hover:shadow-fuchsia-500/10 transition-all duration-300">
        {/* Image */}
        <div className="relative aspect-[2/3] overflow-hidden">
          <img src={item.image || '/placeholder-poster.jpg'} alt={item.title} loading="lazy"
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" />

          {/* Rank badge */}
          {rank && (
            <div className="absolute top-2 left-2 w-7 h-7 rounded-lg bg-black/70 backdrop-blur-sm border border-white/10 flex items-center justify-center text-xs font-bold text-white">
              {rank}
            </div>
          )}

          {/* Type badge */}
          {!rank && (
            <div className="absolute top-2 left-2 px-2 py-0.5 bg-black/70 backdrop-blur-sm rounded-md text-[9px] font-semibold text-gray-300 uppercase tracking-wider border border-white/10">
              {item.type}
            </div>
          )}

          {/* Score */}
          {item.score != null && (
            <div className="absolute top-2 right-2 px-2 py-0.5 bg-black/70 backdrop-blur-sm rounded-md text-[10px] font-bold text-yellow-300 flex items-center gap-1 border border-white/10">
              <Star className="w-2.5 h-2.5" /> {item.score.toFixed(1)}
            </div>
          )}

          {/* Hover overlay */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-3">
            <div className="w-10 h-10 rounded-full bg-fuchsia-600/90 flex items-center justify-center border-2 border-white/20 mb-2 scale-90 group-hover:scale-100 transition-transform">
              <PlayIcon className="w-4 h-4" />
            </div>
          </div>

          {/* Episode count */}
          {item.episodes && (
            <div className="absolute bottom-2 left-2 px-1.5 py-0.5 bg-black/70 rounded text-[9px] text-gray-300 font-medium">
              {item.episodes} ep{item.episodes !== 1 ? 's' : ''}
            </div>
          )}
        </div>
      </div>

      {/* Title */}
      <div className="mt-2.5 px-0.5">
        <h3 className="text-white font-semibold text-xs sm:text-sm leading-tight line-clamp-2 group-hover:text-fuchsia-300 transition-colors">
          {item.title_english || item.title}
        </h3>
        <div className="flex items-center gap-2 mt-1 text-[10px] text-gray-500 font-medium">
          {item.year && <span>{item.year}</span>}
          {item.type && !rank && <span className="uppercase">{item.type}</span>}
        </div>
      </div>
    </motion.button>
  );
}

// ─── Skeletons ──────────────────────────────────────────────────────────────

function GridSkeleton({ count }: { count: number }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-5">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i}>
          <div className="aspect-[2/3] rounded-xl bg-white/[0.03] animate-pulse" />
          <div className="h-3.5 mt-2.5 bg-white/[0.04] rounded animate-pulse w-3/4" />
          <div className="h-2.5 mt-1.5 bg-white/[0.03] rounded animate-pulse w-1/2" />
        </div>
      ))}
    </div>
  );
}

function RowSkeleton({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <section className="px-4 md:px-6">
      <div className="max-w-[1440px] mx-auto">
        <h2 className="text-xl md:text-2xl font-bold text-white/50 mb-1">{title}</h2>
        <p className="text-gray-600 text-xs mb-4">{subtitle}</p>
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="flex-shrink-0 w-[155px] sm:w-[170px] md:w-[185px]">
              <div className="aspect-[2/3] rounded-xl bg-white/[0.03] animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Icons ──────────────────────────────────────────────────────────────────

function PlayIcon({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>;
}
function Star({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>;
}
function SearchIcon({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="11" cy="11" r="7" /><path strokeLinecap="round" d="m21 21-4.3-4.3" /></svg>;
}
