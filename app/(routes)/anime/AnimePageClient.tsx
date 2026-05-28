'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { PageTransition } from '@/components/layout/PageTransition';
import {
  jikanList,
  jikanSearch,
  GENRES,
  type AnimeCard as Anime,
} from '@/lib/anime/jikan-client';

// ─── Static category definitions ────────────────────────────────────────────

interface CategoryDef {
  id: string;
  title: string;
  endpoint: string;
}

const FEATURED_DEFS: CategoryDef[] = [
  { id: 'airing', title: 'Currently Airing', endpoint: '/seasons/now?limit=25' },
  { id: 'popular', title: 'Most Popular', endpoint: '/top/anime?limit=25&filter=bypopularity' },
  { id: 'top-rated', title: 'Top Rated', endpoint: '/top/anime?limit=25' },
  { id: 'favorites', title: 'All-Time Favorites', endpoint: '/top/anime?limit=25&filter=favorite' },
  { id: 'upcoming', title: 'Upcoming', endpoint: '/seasons/upcoming?limit=25' },
  { id: 'movies', title: 'Anime Movies', endpoint: '/top/anime?limit=25&type=movie' },
];

const ALL_TAB = 'all';

// ─── Component ──────────────────────────────────────────────────────────────

export default function AnimePageClient() {
  const router = useRouter();

  // Active tab: 'all' | genre id (string)
  const [activeTab, setActiveTab] = useState<string>(ALL_TAB);

  // Per-section data
  const [hero, setHero] = useState<Anime | null>(null);
  const [featured, setFeatured] = useState<Record<string, Anime[]>>({});
  const [genreData, setGenreData] = useState<Record<string, Anime[]>>({});

  const [loadingFeatured, setLoadingFeatured] = useState(true);
  const [loadingGenre, setLoadingGenre] = useState(false);

  // Search
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Anime[] | null>(null);
  const [searching, setSearching] = useState(false);

  // ─── Initial featured load ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Kick off all featured rows. The shared rate-limited queue inside
      // jikan-client serializes the actual HTTP calls; using Promise here just
      // lets each row's setState fire as soon as its data lands.
      FEATURED_DEFS.forEach((def, i) => {
        jikanList(def.endpoint).then((items) => {
          if (cancelled) return;
          if (i === 0 && items.length > 0) {
            setHero(items[Math.floor(Math.random() * Math.min(8, items.length))]);
          }
          setFeatured((prev) => ({ ...prev, [def.id]: items }));
        });
      });

      // Best-effort overall "loaded" flag — the first batch is enough.
      await jikanList(FEATURED_DEFS[FEATURED_DEFS.length - 1].endpoint);
      if (!cancelled) setLoadingFeatured(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // ─── Lazy genre load ──────────────────────────────────────────────────────
  useEffect(() => {
    if (activeTab === ALL_TAB) return;
    const genre = GENRES.find((g) => String(g.id) === activeTab);
    if (!genre) return;
    if (genreData[activeTab]?.length) return;

    let cancelled = false;
    setLoadingGenre(true);
    (async () => {
      const items = await jikanList(
        `/anime?genres=${genre.id}&order_by=popularity&sort=desc&limit=30&sfw=true`,
      );
      if (cancelled) return;
      setGenreData((prev) => ({ ...prev, [activeTab]: items }));
      setLoadingGenre(false);
    })();
    return () => { cancelled = true; };
  }, [activeTab, genreData]);

  // ─── Debounced search ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!query.trim()) { setSearchResults(null); return; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      const items = await jikanSearch(query);
      if (cancelled) return;
      setSearchResults(items);
      setSearching(false);
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  const openAnime = useCallback(
    (item: Anime) => router.push(`/anime/${item.mal_id}`),
    [router],
  );

  const heroPlay = useCallback(() => {
    if (hero) router.push(`/anime/${hero.mal_id}`);
  }, [router, hero]);

  // ─── Render ───────────────────────────────────────────────────────────────

  const showSearch = searchResults !== null;
  const showGenre = activeTab !== ALL_TAB && !showSearch;
  const showFeatured = activeTab === ALL_TAB && !showSearch;

  return (
    <PageTransition>
      <div className="min-h-screen bg-[#0a0812] text-white">
        {/* Hero */}
        <Hero anime={hero} onPlay={heroPlay} loading={!hero && loadingFeatured} />

        {/* Sticky controls: search + genre tabs */}
        <StickyControls
          query={query}
          onQuery={setQuery}
          activeTab={activeTab}
          onTab={setActiveTab}
          disabled={showSearch}
        />

        {/* Body */}
        <main className="pb-24">
          {showSearch && (
            <SearchResults
              query={query}
              results={searchResults}
              loading={searching}
              onOpen={openAnime}
            />
          )}

          {showGenre && (
            <GenreView
              genreId={activeTab}
              items={genreData[activeTab] || []}
              loading={loadingGenre}
              onOpen={openAnime}
            />
          )}

          {showFeatured && (
            <div className="space-y-10 pt-2">
              {FEATURED_DEFS.map((def) => {
                const items = featured[def.id];
                if (items === undefined) {
                  return <CategoryRowSkeleton key={def.id} title={def.title} />;
                }
                if (items.length === 0) return null;
                return (
                  <CategoryRow
                    key={def.id}
                    title={def.title}
                    items={items}
                    onItemClick={openAnime}
                  />
                );
              })}
            </div>
          )}
        </main>
      </div>
    </PageTransition>
  );
}

// ─── Hero ───────────────────────────────────────────────────────────────────

function Hero({ anime, onPlay, loading }: { anime: Anime | null; onPlay: () => void; loading: boolean }) {
  if (loading) {
    return (
      <section className="relative h-[60vh] min-h-[420px] max-h-[640px] flex items-end px-4 md:px-12 pb-12 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-fuchsia-950/40 via-[#0a0812] to-[#0a0812] animate-pulse" />
        <div className="relative max-w-3xl w-full space-y-4">
          <div className="h-12 w-2/3 bg-white/5 rounded-lg" />
          <div className="h-4 w-1/3 bg-white/5 rounded" />
          <div className="h-20 w-full bg-white/5 rounded" />
        </div>
      </section>
    );
  }
  if (!anime) {
    return (
      <section className="relative pt-24 pb-12 text-center">
        <h1 className="text-5xl md:text-7xl font-black bg-gradient-to-r from-pink-300 via-fuchsia-400 to-purple-400 bg-clip-text text-transparent">
          Anime
        </h1>
        <p className="text-gray-400 mt-3">From shonen epics to slice-of-life gems</p>
      </section>
    );
  }

  return (
    <section className="relative h-[60vh] min-h-[460px] max-h-[680px] flex items-end overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0">
        <img
          src={anime.image}
          alt=""
          aria-hidden
          className="w-full h-full object-cover scale-110 blur-md opacity-50"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0a0812] via-[#0a0812]/85 to-[#0a0812]/40" />
        <div className="absolute inset-0 bg-gradient-to-r from-[#0a0812] via-transparent to-transparent" />
      </div>

      {/* Content */}
      <div className="relative w-full px-4 md:px-12 pb-12 md:pb-16">
        <div className="max-w-3xl">
          <div className="flex items-center gap-2 mb-3">
            <span className="px-2.5 py-1 bg-fuchsia-600/20 border border-fuchsia-500/40 rounded-full text-[11px] uppercase tracking-wider font-semibold text-fuchsia-300">
              Featured · Airing Now
            </span>
            {anime.score != null && (
              <span className="px-2.5 py-1 bg-black/40 border border-white/10 rounded-full text-xs text-yellow-300 flex items-center gap-1">
                <Star className="w-3 h-3" />
                {anime.score.toFixed(2)}
              </span>
            )}
          </div>
          <h1 className="text-4xl md:text-6xl font-black leading-tight text-white drop-shadow-lg line-clamp-2">
            {anime.title_english || anime.title}
          </h1>
          {anime.title_english && anime.title !== anime.title_english && (
            <p className="text-gray-400 text-sm md:text-base mt-1">{anime.title}</p>
          )}
          <div className="flex flex-wrap gap-3 mt-4 text-sm text-gray-300">
            <span>{anime.type}</span>
            {anime.year && <><span>•</span><span>{anime.year}</span></>}
            {anime.episodes && <><span>•</span><span>{anime.episodes} eps</span></>}
          </div>

          <div className="mt-6 flex gap-3">
            <button
              onClick={onPlay}
              className="group relative inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-fuchsia-500 to-pink-500 hover:from-fuchsia-400 hover:to-pink-400 text-white font-semibold shadow-lg shadow-fuchsia-900/40 transition-all"
            >
              <PlayIcon className="w-5 h-5" />
              View Details
              <div className="absolute inset-0 rounded-xl ring-1 ring-white/20 pointer-events-none group-hover:ring-white/40 transition" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Sticky controls ────────────────────────────────────────────────────────

function StickyControls({
  query, onQuery, activeTab, onTab, disabled,
}: {
  query: string;
  onQuery: (q: string) => void;
  activeTab: string;
  onTab: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="sticky top-20 z-30 bg-[#0a0812]/85 backdrop-blur-md border-b border-white/5">
      <div className="max-w-[1400px] mx-auto px-4 md:px-6 py-3 space-y-3">
        {/* Search */}
        <div className="relative max-w-xl">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search anime…"
            className="w-full pl-9 pr-9 py-2 bg-white/5 border border-white/10 focus:border-fuchsia-500/60 focus:bg-white/10 rounded-lg text-sm text-white placeholder:text-gray-500 outline-none transition-colors"
          />
          {query && (
            <button
              onClick={() => onQuery('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full hover:bg-white/10 text-gray-400 hover:text-white text-xs flex items-center justify-center transition-colors"
            >
              ✕
            </button>
          )}
        </div>

        {/* Tabs */}
        <div className={`flex gap-1.5 overflow-x-auto pb-1 ${disabled ? 'opacity-40 pointer-events-none' : ''}`} style={{ scrollbarWidth: 'none' }}>
          <TabButton active={activeTab === ALL_TAB} onClick={() => onTab(ALL_TAB)}>
            All
          </TabButton>
          {GENRES.map((g) => (
            <TabButton
              key={g.id}
              active={activeTab === String(g.id)}
              onClick={() => onTab(String(g.id))}
            >
              {g.name}
            </TabButton>
          ))}
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-shrink-0 px-3.5 py-1.5 rounded-full text-xs font-medium border transition-colors whitespace-nowrap ${
        active
          ? 'bg-fuchsia-600 border-fuchsia-500 text-white'
          : 'bg-white/5 border-white/10 text-gray-300 hover:bg-white/10 hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

// ─── Search results ─────────────────────────────────────────────────────────

function SearchResults({
  query, results, loading, onOpen,
}: {
  query: string;
  results: Anime[] | null;
  loading: boolean;
  onOpen: (a: Anime) => void;
}) {
  return (
    <section className="px-4 md:px-6 pt-6">
      <div className="max-w-[1400px] mx-auto">
        <h2 className="text-lg font-semibold text-white mb-4">
          {loading ? 'Searching…' : `Results for "${query}"`}
          {!loading && results && <span className="ml-2 text-sm text-gray-500">({results.length})</span>}
        </h2>
        {loading && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {Array.from({ length: 12 }).map((_, i) => <CardSkeleton key={i} />)}
          </div>
        )}
        {!loading && results && results.length === 0 && (
          <div className="py-16 text-center text-gray-500">No anime found.</div>
        )}
        {!loading && results && results.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {results.map((item) => (
              <PosterCard key={item.mal_id} item={item} onClick={() => onOpen(item)} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Genre view ─────────────────────────────────────────────────────────────

function GenreView({
  genreId, items, loading, onOpen,
}: { genreId: string; items: Anime[]; loading: boolean; onOpen: (a: Anime) => void }) {
  const genre = GENRES.find((g) => String(g.id) === genreId);
  return (
    <section className="px-4 md:px-6 pt-6">
      <div className="max-w-[1400px] mx-auto">
        <h2 className="text-2xl font-bold text-white mb-4">{genre?.name ?? 'Genre'}</h2>
        {loading && items.length === 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {Array.from({ length: 18 }).map((_, i) => <CardSkeleton key={i} />)}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {items.map((item) => (
              <PosterCard key={item.mal_id} item={item} onClick={() => onOpen(item)} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Category row (horizontal scroller) ─────────────────────────────────────

function CategoryRow({
  title, items, onItemClick,
}: { title: string; items: Anime[]; onItemClick: (item: Anime) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scroll = (dir: 'left' | 'right') => {
    if (scrollRef.current) {
      scrollRef.current.scrollBy({ left: dir === 'left' ? -800 : 800, behavior: 'smooth' });
    }
  };

  return (
    <section className="px-4 md:px-6">
      <div className="max-w-[1400px] mx-auto">
        <div className="flex items-end justify-between mb-3">
          <div>
            <h2 className="text-xl md:text-2xl font-bold text-white">{title}</h2>
          </div>
          <div className="hidden md:flex gap-2">
            <ScrollerButton dir="left" onClick={() => scroll('left')} />
            <ScrollerButton dir="right" onClick={() => scroll('right')} />
          </div>
        </div>
        <div ref={scrollRef} className="flex gap-3 overflow-x-auto pb-2" style={{ scrollbarWidth: 'none' }}>
          {items.map((item) => (
            <div key={item.mal_id} className="flex-shrink-0 w-[140px] sm:w-40 md:w-44">
              <PosterCard item={item} onClick={() => onItemClick(item)} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ScrollerButton({ dir, onClick }: { dir: 'left' | 'right'; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={dir === 'left' ? 'Scroll left' : 'Scroll right'}
      className="w-8 h-8 bg-white/5 hover:bg-fuchsia-600/30 hover:border-fuchsia-500/60 border border-white/10 rounded-full text-white text-lg leading-none transition-colors"
    >
      {dir === 'left' ? '‹' : '›'}
    </button>
  );
}

function CategoryRowSkeleton({ title }: { title: string }) {
  return (
    <section className="px-4 md:px-6">
      <div className="max-w-[1400px] mx-auto">
        <h2 className="text-xl md:text-2xl font-bold text-white/60 mb-3">{title}</h2>
        <div className="flex gap-3 overflow-hidden pb-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex-shrink-0 w-[140px] sm:w-40 md:w-44">
              <CardSkeleton />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Cards ──────────────────────────────────────────────────────────────────

function PosterCard({ item, onClick }: { item: Anime; onClick: () => void }) {
  return (
    <motion.button
      onClick={onClick}
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true, margin: '0px 0px -10% 0px' }}
      className="group block w-full text-left"
    >
      <div className="relative rounded-lg overflow-hidden bg-gray-900 shadow-lg group-hover:shadow-fuchsia-500/20 group-hover:shadow-xl transition-all duration-300">
        <img
          src={item.image || '/placeholder-poster.jpg'}
          alt={item.title}
          loading="lazy"
          className="w-full aspect-[2/3] object-cover group-hover:scale-105 transition-transform duration-300"
        />

        <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 bg-black/70 rounded text-[9px] font-medium text-gray-200 uppercase tracking-wide">
          {item.type}
        </div>

        {item.score != null && (
          <div className="absolute top-1.5 right-1.5 px-1.5 py-0.5 bg-black/70 rounded text-[10px] font-semibold text-yellow-300 flex items-center gap-0.5">
            <Star className="w-2 h-2" />
            {item.score.toFixed(1)}
          </div>
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-end p-2">
          <div className="w-9 h-9 rounded-full bg-fuchsia-600 backdrop-blur-sm flex items-center justify-center border border-white/20 scale-90 group-hover:scale-100 transition-transform">
            <PlayIcon className="w-4 h-4" />
          </div>
        </div>
      </div>

      <div className="mt-2">
        <h3 className="text-white font-medium text-xs sm:text-sm line-clamp-2 group-hover:text-fuchsia-300 transition-colors leading-tight">
          {item.title_english || item.title}
        </h3>
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-gray-500">
          {item.year && <span>{item.year}</span>}
          {item.episodes && <span>{item.episodes} eps</span>}
        </div>
      </div>
    </motion.button>
  );
}

function CardSkeleton() {
  return (
    <div className="w-full">
      <div className="w-full aspect-[2/3] rounded-lg bg-white/5 animate-pulse" />
      <div className="h-3 mt-2 bg-white/5 rounded animate-pulse" />
      <div className="h-2 mt-1.5 w-1/2 bg-white/5 rounded animate-pulse" />
    </div>
  );
}

// ─── Icons ──────────────────────────────────────────────────────────────────

function PlayIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
function Star({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
  );
}
function SearchIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path strokeLinecap="round" d="m21 21-4.3-4.3" />
    </svg>
  );
}
