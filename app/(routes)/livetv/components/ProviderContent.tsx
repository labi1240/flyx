/**
 * Provider Content Component
 * Renders content for DLHD and CDN Live providers
 */

import { memo, useState, useEffect, useRef } from 'react';
import { Provider } from './ProviderTabs';
import { LiveEvent, DLHDChannel } from '../hooks/useLiveTVData';
import { EventCard } from './EventCard';
import styles from '../LiveTV.module.css';

interface ProviderContentProps {
  provider: Provider;
  events: LiveEvent[];
  channels: DLHDChannel[];
  categories: Array<{ id: string; name: string; icon: string; count: number }>;
  onPlayEvent: (event: LiveEvent) => void;
  onPlayChannel: (channel: DLHDChannel) => void;
  loading: boolean;
  error: string | null;
}

type ViewMode = 'events' | 'channels';

const ITEMS_PER_PAGE = 24;

const PROVIDER_TITLES: Record<Provider, string> = {
  dlhd: 'DaddyLive HD',
  cdnlive: 'CDN Live TV',
  ppv: 'PPV.to Live Events',
  ufreetv: 'uFreeTV',
  globetv: 'GlobeTV',
};

export const ProviderContent = memo(function ProviderContent({
  provider,
  events,
  channels,
  categories,
  onPlayEvent,
  onPlayChannel,
  loading,
  error,
}: ProviderContentProps) {
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [showLiveOnly, setShowLiveOnly] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('events');
  const [displayCount, setDisplayCount] = useState(ITEMS_PER_PAGE);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // Reset state when provider changes
  useEffect(() => {
    setSelectedCategory('all');
    setShowLiveOnly(false);
    setDisplayCount(ITEMS_PER_PAGE);
    setViewMode('events');
  }, [provider]);

  // Filter events
  const filteredEvents = events.filter(event => {
    if (selectedCategory !== 'all') {
      const eventCategory = event.sport?.toLowerCase() || '';
      if (eventCategory !== selectedCategory) return false;
    }
    if (showLiveOnly && !event.isLive) return false;
    return true;
  });

  // Filter channels
  const filteredChannels = channels.filter(channel => {
    if (selectedCategory !== 'all') {
      if (channel.category !== selectedCategory) return false;
    }
    return true;
  });

  // Reset display count when filters change
  useEffect(() => {
    setDisplayCount(ITEMS_PER_PAGE);
  }, [selectedCategory, showLiveOnly, viewMode]);

  // Infinite scroll
  useEffect(() => {
    const loadMoreEl = loadMoreRef.current;
    if (!loadMoreEl) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setDisplayCount(prev => {
            const total = viewMode === 'channels' ? filteredChannels.length : filteredEvents.length;
            if (prev >= total) return prev;
            return Math.min(prev + ITEMS_PER_PAGE, total);
          });
        }
      },
      { threshold: 0.1, rootMargin: '200px' }
    );

    observer.observe(loadMoreEl);
    return () => observer.disconnect();
  }, [filteredEvents.length, filteredChannels.length, viewMode]);

  const displayedEvents = filteredEvents.slice(0, displayCount);
  const displayedChannels = filteredChannels.slice(0, displayCount);
  const hasMore = viewMode === 'channels' 
    ? displayCount < filteredChannels.length 
    : displayCount < filteredEvents.length;

  const hasChannels = provider === 'dlhd' && channels.length > 0;

  return (
    <div className={styles.providerContent}>
      {/* Provider Header */}
      <div className={styles.providerHeader}>
        <h2 className={styles.providerTitle}>{PROVIDER_TITLES[provider]}</h2>
        
        {/* View Mode Toggle (only for DLHD) */}
        {hasChannels && (
          <div className={styles.viewToggle}>
            <button
              onClick={() => setViewMode('events')}
              className={`${styles.viewToggleBtn} ${viewMode === 'events' ? styles.active : ''}`}
            >
              🏟️ Events ({events.length})
            </button>
            <button
              onClick={() => setViewMode('channels')}
              className={`${styles.viewToggleBtn} ${viewMode === 'channels' ? styles.active : ''}`}
            >
              📺 Channels ({channels.length})
            </button>
          </div>
        )}
      </div>

      {/* Category Filters */}
      <div className={styles.filterBar}>
        {viewMode === 'events' && (
          <button
            onClick={() => setShowLiveOnly(!showLiveOnly)}
            className={`${styles.filterPill} ${showLiveOnly ? styles.active : ''}`}
          >
            <span className={styles.liveDot} />
            Live Only
          </button>
        )}

        <button
          onClick={() => setSelectedCategory('all')}
          className={`${styles.filterPill} ${selectedCategory === 'all' ? styles.active : ''}`}
        >
          🏆 All
        </button>

        {categories.slice(0, 10).map((cat) => (
          <button
            key={cat.id}
            onClick={() => setSelectedCategory(cat.id === selectedCategory ? 'all' : cat.id)}
            className={`${styles.filterPill} ${selectedCategory === cat.id ? styles.active : ''}`}
          >
            {cat.icon} {cat.name} ({cat.count})
          </button>
        ))}
      </div>

      {/* Content */}
      <div className={styles.contentContainer}>
        {/* Loading */}
        {loading && (
          <div className={styles.gridPlaceholder}>
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className={styles.cardSkeleton} />
            ))}
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className={styles.messageBox}>
            <span className={styles.messageIcon}>⚠️</span>
            <p>{error}</p>
          </div>
        )}

        {/* Events View */}
        {!loading && !error && viewMode === 'events' && (
          <>
            {filteredEvents.length === 0 ? (
              <div className={styles.messageBox}>
                <span className={styles.messageIcon}>📺</span>
                <p>No events found. Try adjusting your filters.</p>
              </div>
            ) : (
              <>
                <div className={styles.contentHeader}>
                  <span className={styles.contentCount}>
                    {filteredEvents.length} events
                    {showLiveOnly && ` (${filteredEvents.filter(e => e.isLive).length} live)`}
                  </span>
                </div>
                <div className={styles.simpleGrid}>
                  {displayedEvents.map((event) => (
                    <EventCard key={event.id} event={event} onPlay={onPlayEvent} />
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {/* Channels View */}
        {!loading && !error && viewMode === 'channels' && (
          <>
            {filteredChannels.length === 0 ? (
              <div className={styles.messageBox}>
                <span className={styles.messageIcon}>📺</span>
                <p>No channels found. Try adjusting your filters.</p>
              </div>
            ) : (
              <>
                <div className={styles.contentHeader}>
                  <span className={styles.contentCount}>{filteredChannels.length} channels</span>
                </div>
                <div className={styles.channelGrid}>
                  {displayedChannels.map((channel) => (
                    <div
                      key={channel.id}
                      className={styles.channelItem}
                      onClick={() => onPlayChannel(channel)}
                    >
                      <div className={styles.channelFlag}>
                        📺
                      </div>
                      <div className={styles.channelDetails}>
                        <span className={styles.channelTitle}>{channel.name}</span>
                        <span className={styles.channelSub}>
                          {channel.category}
                        </span>
                      </div>
                      <div className={styles.channelPlayIcon}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M8 5v14l11-7z"/>
                        </svg>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {/* Load More */}
        {hasMore && (
          <div ref={loadMoreRef} className={styles.loadMoreTrigger}>
            <div className={styles.loadingSpinner} />
            <p>Loading more...</p>
          </div>
        )}
      </div>
    </div>
  );
});
