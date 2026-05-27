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

function mapJikanItem(a: any): AnimeItem | null {
  if (!a?.mal_id) return null;
  return {
    mal_id: a.mal_id,
    title: a.title || 'Unknown',
    title_english: a.title_english || a.title || null,
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
    return (json.data || []).map(mapJikanItem).filter((i: AnimeItem | null): i is AnimeItem => i !== null);
  } catch {
    return [];
  }
}

export default function AnimePageClient() {
  const router = useRouter();
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [airing, popular, topRated, movies] = await Promise.all([
        fetchJikan('/seasons/now?limit=25'),
        fetchJikan('/top/anime?limit=25&filter=bypopularity'),
        fetchJikan('/top/anime?limit=25'),
        fetchJikan('/top/anime?limit=25&type=movie'),
      ]);
      if (cancelled) return;
      setCategories([
        { title: 'Currently Airing', items: airing },
        { title: 'Popular', items: popular },
        { title: 'Top Rated', items: topRated },
        { title: 'Movies', items: movies },
      ].filter(c => c.items.length > 0));
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
          <h2 className="text-xl md:text-2xl font-bold text-white">{title}</h2>
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
              className="flex-shrink-0 w-[130px] sm:w-36 md:w-44 cursor-pointer group"
            >
              <div className="relative rounded-lg overflow-hidden bg-gray-900 shadow-lg group-hover:scale-105 group-hover:shadow-xl transition-all duration-300">
                <img
                  src={item.image || '/placeholder-poster.jpg'}
                  alt={item.title}
                  className="w-full aspect-[2/3] object-cover group-hover:scale-110 transition-transform duration-300"
                  loading="lazy"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center">
                  <div className="w-12 h-12 rounded-full bg-fuchsia-600/60 backdrop-blur-sm flex items-center justify-center border border-white/20 scale-0 group-hover:scale-100 transition-transform duration-300">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
                  </div>
                </div>
                {item.score && (
                  <div className="absolute top-1.5 right-1.5 px-1.5 py-0.5 bg-black/70 rounded text-[10px] font-semibold text-yellow-400">
                    ★ {item.score.toFixed(1)}
                  </div>
                )}
              </div>
              <div className="mt-2 px-0.5">
                <h3 className="text-white font-medium text-xs sm:text-sm line-clamp-1 group-hover:text-fuchsia-300 transition-colors">
                  {item.title_english || item.title}
                </h3>
                <p className="text-gray-500 text-[10px] mt-0.5">{item.year || ''}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
