'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { PageTransition } from '@/components/layout/PageTransition';

interface AnimeItem {
  mal_id: number;
  title: string;
  title_english: string | null;
  image: string;
  score: number | null;
  year: number | null;
  episodes: number | null;
  type: string;
}

interface Category {
  title: string;
  items: AnimeItem[];
}

const JIKAN = 'https://api.jikan.moe/v4';

function mapItem(a: any): AnimeItem | null {
  if (!a?.mal_id) return null;
  return {
    mal_id: a.mal_id,
    title: a.title || 'Unknown',
    title_english: a.title_english || null,
    image: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || '',
    score: a.score ?? null,
    year: a.year ?? null,
    episodes: a.episodes ?? null,
    type: a.type || 'TV',
  };
}

async function fetchJikan(endpoint: string): Promise<AnimeItem[]> {
  try {
    const res = await fetch(`${JIKAN}${endpoint}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.data || []).map(mapItem).filter((i: AnimeItem | null): i is AnimeItem => i !== null);
  } catch {
    return [];
  }
}

const GENRES: Record<string, number> = {
  Action: 1,
  Adventure: 2,
  Comedy: 4,
  Drama: 8,
  Fantasy: 10,
  Horror: 14,
  Romance: 22,
  'Sci-Fi': 24,
  Thriller: 41,
  Sports: 30,
};

const CATEGORY_DEFS = [
  { title: 'Currently Airing', endpoint: '/seasons/now?limit=25' },
  { title: 'Popular', endpoint: '/top/anime?limit=25&filter=bypopularity' },
  { title: 'Top Rated', endpoint: '/top/anime?limit=25' },
  { title: 'Most Favorited', endpoint: '/top/anime?limit=25&filter=favorite' },
  { title: 'Upcoming', endpoint: '/seasons/upcoming?limit=25' },
  { title: 'Movies', endpoint: '/top/anime?limit=25&type=movie' },
  ...Object.entries(GENRES).map(([name, id]) => ({
    title: name,
    endpoint: `/anime?genres=${id}&order_by=popularity&sort=desc&limit=25`,
  })),
];

export default function AnimePageClient() {
  const router = useRouter();
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const results = await Promise.all(
        CATEGORY_DEFS.map(d => fetchJikan(d.endpoint))
      );
      if (cancelled) return;
      setCategories(
        CATEGORY_DEFS
          .map((d, i) => ({ title: d.title, items: results[i] }))
          .filter(c => c.items.length > 0)
      );
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0812] flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-fuchsia-500/30 border-t-fuchsia-400 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <PageTransition>
      <div className="min-h-screen bg-[#0a0812]">
        <section className="pt-20 pb-12 text-center">
          <h1 className="text-5xl md:text-7xl font-black bg-gradient-to-r from-pink-300 via-fuchsia-400 to-purple-400 bg-clip-text text-transparent">
            Anime
          </h1>
          <p className="text-gray-400 mt-3">From shonen epics to slice-of-life gems</p>
        </section>

        <main className="pb-20 space-y-8">
          {categories.map(cat => (
            <CategoryRow
              key={cat.title}
              title={cat.title}
              items={cat.items}
              onItemClick={(item) => router.push(`/anime/${item.mal_id}`)}
            />
          ))}
        </main>
      </div>
    </PageTransition>
  );
}

function CategoryRow({ title, items, onItemClick }: {
  title: string;
  items: AnimeItem[];
  onItemClick: (item: AnimeItem) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const scroll = (dir: 'left' | 'right') => {
    if (scrollRef.current) {
      scrollRef.current.scrollBy({ left: dir === 'left' ? -800 : 800, behavior: 'smooth' });
    }
  };

  return (
    <section className="px-4 md:px-6">
      <div className="max-w-[1400px] mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h2 className="text-xl md:text-2xl font-bold text-white">{title}</h2>
            <span className="text-xs text-gray-500">({items.length}+)</span>
          </div>
          <div className="hidden md:flex gap-2">
            <button onClick={() => scroll('left')} className="w-8 h-8 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full text-white font-bold">
              ‹
            </button>
            <button onClick={() => scroll('right')} className="w-8 h-8 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full text-white font-bold">
              ›
            </button>
          </div>
        </div>
        <div
          ref={scrollRef}
          className="flex gap-3 overflow-x-auto pb-4"
          style={{ scrollbarWidth: 'none' }}
        >
          {items.map((item) => (
            <motion.div
              key={item.mal_id}
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              onClick={() => onItemClick(item)}
              className="flex-shrink-0 w-[140px] sm:w-40 md:w-48 cursor-pointer group"
            >
              <div className="relative rounded-lg overflow-hidden bg-gray-900 shadow-lg group-hover:scale-105 group-hover:shadow-xl group-hover:shadow-fuchsia-500/20 transition-all duration-300">
                <img
                  src={item.image || '/placeholder-poster.jpg'}
                  alt={item.title}
                  className="w-full aspect-[2/3] object-cover group-hover:scale-110 transition-transform duration-300"
                  loading="lazy"
                />

                {/* Type badge */}
                <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 bg-black/70 rounded text-[9px] font-medium text-gray-300 uppercase">
                  {item.type}
                </div>

                {/* Hover play overlay */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center">
                  <div className="w-12 h-12 rounded-full bg-fuchsia-600/60 backdrop-blur-sm flex items-center justify-center border border-white/20 scale-0 group-hover:scale-100 transition-transform duration-300">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
                  </div>
                </div>

                {/* Score */}
                {item.score && (
                  <div className="absolute top-1.5 right-1.5 px-1.5 py-0.5 bg-black/70 rounded text-[10px] font-semibold text-yellow-400 flex items-center gap-0.5">
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                    {item.score.toFixed(1)}
                  </div>
                )}
              </div>

              <div className="mt-2 px-0.5">
                <h3 className="text-white font-medium text-xs sm:text-sm line-clamp-2 group-hover:text-fuchsia-300 transition-colors leading-tight">
                  {item.title_english || item.title}
                </h3>
                <div className="flex items-center gap-2 mt-1 text-[10px] text-gray-500">
                  {item.year && <span>{item.year}</span>}
                  {item.episodes && <span>{item.episodes} eps</span>}
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
