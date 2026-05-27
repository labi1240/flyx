'use client';

import { useCallback, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion } from 'framer-motion';
import type { MediaItem } from '@/types/media';
import { PageTransition } from '@/components/layout/PageTransition';
import { useAnalytics } from '@/components/analytics/AnalyticsProvider';
import { usePresenceContext } from '@/components/analytics/PresenceProvider';

interface BrowsePageClientProps {
  items: MediaItem[];
  total: number;
  currentPage: number;
  totalPages: number;
  title: string;
  type: string;
  filter: string;
  genre: string;
}

export default function BrowsePageClient({
  items,
  total,
  currentPage,
  totalPages,
  title,
  type,
  filter: _filter,
  genre: _genre,
}: BrowsePageClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { trackEvent } = useAnalytics();
  const presenceContext = usePresenceContext();
  
  // Track browsing activity with page context - only when title changes
  useEffect(() => {
    if (presenceContext?.setBrowsingContext) {
      presenceContext.setBrowsingContext(`Browse: ${title}`);
    }
  }, [title]); // eslint-disable-line react-hooks/exhaustive-deps

  const isAnime = type === 'anime' || type === 'anime-movies';

  const handleContentClick = useCallback((item: MediaItem) => {
    trackEvent('content_clicked', { content_id: item.id, source: 'browse' });
    if (isAnime) {
      router.push(`/anime/${item.id}`);
    } else {
      const mediaType = item.mediaType || (type === 'movie' ? 'movie' : 'tv');
      router.push(`/details/${item.id}?type=${mediaType}`);
    }
  }, [router, trackEvent, type, isAnime]);

  const getImageUrl = useCallback((item: MediaItem) => {
    if (item.imageUrl) return item.imageUrl;
    if (item.poster_path) return `https://image.tmdb.org/t/p/w500${item.poster_path}`;
    return '/placeholder-poster.jpg';
  }, []);

  const getYear = useCallback((item: MediaItem) => {
    if (item.year) return String(item.year);
    const date = item.release_date || item.first_air_date;
    return date ? new Date(date).getFullYear() : '';
  }, []);

  const handlePageChange = (newPage: number) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('page', newPage.toString());
    router.push(`/browse?${params.toString()}`);
  };

  // Determine theme colors based on type
  const themeColors = {
    movie: { accent: 'amber', bg: 'from-amber-900/20', text: 'text-amber-400', btn: 'bg-amber-500 hover:bg-amber-600' },
    tv: { accent: 'cyan', bg: 'from-cyan-900/20', text: 'text-cyan-400', btn: 'bg-cyan-500 hover:bg-cyan-600' },
    anime: { accent: 'pink', bg: 'from-pink-900/20', text: 'text-pink-400', btn: 'bg-pink-500 hover:bg-pink-600' },
    'anime-movies': { accent: 'pink', bg: 'from-pink-900/20', text: 'text-pink-400', btn: 'bg-pink-500 hover:bg-pink-600' },
  }[type] || { accent: 'purple', bg: 'from-purple-900/20', text: 'text-purple-400', btn: 'bg-purple-500 hover:bg-purple-600' };

  return (
    <PageTransition>
      <div className="min-h-screen bg-[#0a0a0f]">
        
        {/* Header */}
        <section className={`relative pt-24 pb-8 bg-gradient-to-b ${themeColors.bg} via-transparent to-transparent`}>
          <div className="container mx-auto px-6">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-center justify-between flex-wrap gap-4"
            >
              <div>
                <button
                  onClick={() => router.back()}
                  className="text-gray-400 hover:text-white text-sm mb-2 flex items-center gap-1 transition-colors"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
                  </svg>
                  Back
                </button>
                <h1 className="text-3xl md:text-4xl font-bold text-white">{title}</h1>
                <p className={`${themeColors.text} mt-1`}>
                  {total.toLocaleString()} titles available
                </p>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Content Grid */}
        <main className="container mx-auto px-6 pb-20">
          {items.length === 0 ? (
            <div className="text-center py-20">
              <p className="text-gray-400 text-lg">No content found</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-6">
                {items.map((item, index) => (
                  <motion.div
                    key={`${item.mediaType || 'content'}-${item.id}`}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(index * 0.02, 0.4) }}
                    onClick={() => handleContentClick(item)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleContentClick(item);
                      }
                    }}
                    className="cursor-pointer group"
                    data-tv-focusable="true"
                    data-tv-group="browse-grid"
                    tabIndex={0}
                    role="button"
                    aria-label={`${item.title || item.name}`}
                  >
                    <motion.div
                      whileHover={{ scale: 1.03, y: -4 }}
                      transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                      className="relative rounded-xl overflow-hidden bg-gray-900 shadow-lg"
                    >
                      <img
                        src={getImageUrl(item)}
                        alt={item.title || item.name || ''}
                        className="w-full aspect-[2/3] object-cover"
                        loading="lazy"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-300">
                        <div className={`w-12 h-12 ${themeColors.btn} rounded-full flex items-center justify-center shadow-lg`}>
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        </div>
                      </div>
                      {(item.vote_average ?? 0) > 0 && (
                        <div className={`absolute top-2 right-2 px-1.5 py-0.5 bg-black/70 backdrop-blur-sm rounded text-xs font-semibold ${themeColors.text} flex items-center gap-1`}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
                          </svg>
                          {(item.vote_average ?? 0).toFixed(1)}
                        </div>
                      )}
                    </motion.div>
                    <div className="mt-2.5 px-1">
                      <h3 className="text-white font-medium text-sm line-clamp-2 group-hover:text-white/80 transition-colors">
                        {item.title || item.name}
                      </h3>
                      <p className="text-gray-500 text-xs mt-0.5">
                        {getYear(item)}
                      </p>
                    </div>
                  </motion.div>
                ))}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 mt-12">
                  <button
                    onClick={() => handlePageChange(currentPage - 1)}
                    disabled={currentPage <= 1}
                    className="px-4 py-2 bg-white/5 hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg text-white text-sm transition-colors"
                    data-tv-focusable="true"
                    data-tv-group="pagination"
                  >
                    Previous
                  </button>
                  
                  <div className="flex items-center gap-1">
                    {currentPage > 3 && (
                      <>
                        <button onClick={() => handlePageChange(1)} className="w-10 h-10 rounded-lg text-white hover:bg-white/10 text-sm">1</button>
                        {currentPage > 4 && <span className="text-gray-500 px-2">...</span>}
                      </>
                    )}
                    
                    {Array.from({ length: 5 }, (_, i) => currentPage - 2 + i)
                      .filter(p => p >= 1 && p <= totalPages)
                      .map(p => (
                        <button
                          key={p}
                          onClick={() => handlePageChange(p)}
                          className={`w-10 h-10 rounded-lg text-sm transition-colors ${
                            p === currentPage
                              ? `${themeColors.btn} text-white`
                              : 'text-white hover:bg-white/10'
                          }`}
                        >
                          {p}
                        </button>
                      ))}
                    
                    {currentPage < totalPages - 2 && (
                      <>
                        {currentPage < totalPages - 3 && <span className="text-gray-500 px-2">...</span>}
                        <button onClick={() => handlePageChange(totalPages)} className="w-10 h-10 rounded-lg text-white hover:bg-white/10 text-sm">{totalPages}</button>
                      </>
                    )}
                  </div>

                  <button
                    onClick={() => handlePageChange(currentPage + 1)}
                    disabled={currentPage >= totalPages}
                    className="px-4 py-2 bg-white/5 hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg text-white text-sm transition-colors"
                    data-tv-focusable="true"
                    data-tv-group="pagination"
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </PageTransition>
  );
}
