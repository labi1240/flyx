/**
 * LiveTV Page — Unified browsing experience
 *
 * Single unified view with:
 * - Hero carousel for currently live/featured events
 * - Provider filter chips for quick source switching
 * - Category sidebar (desktop) / horizontal pills (mobile)
 * - Responsive content grid with infinite scroll
 * - Timeline/EPG view toggle for upcoming events
 */

'use client';

import { useState, useCallback, useMemo } from 'react';
import { useLiveTVData, LiveEvent, TVChannel, ProviderFilter } from './hooks/useLiveTVData';
import { VideoPlayer } from './components/VideoPlayer';
import { LiveHero } from './components/LiveHero';
import { ProviderChips } from './components/ProviderChips';
import { CategorySidebar } from './components/CategorySidebar';
import { ContentGrid } from './components/ContentGrid';
import { TimelineView } from './components/TimelineView';
import styles from './LiveTV.module.css';

export default function LiveTVRefactored() {
  const {
    selectedProvider,
    setSelectedProvider,
    events,
    channels,
    currentlyLive,
    upcoming,
    sportCategories,
    channelCategories,
    loading,
    error,
    searchQuery,
    setSearchQuery,
    stats,
    totalLive,
    totalEvents,
    totalChannels,
    viewMode,
    setViewMode,
    refresh,
  } = useLiveTVData();

  // Player state
  const [selectedEvent, setSelectedEvent] = useState<LiveEvent | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<TVChannel | null>(null);
  const [isPlayerOpen, setIsPlayerOpen] = useState(false);

  // Local filters
  const [showLiveOnly, setShowLiveOnly] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  // Apply local filters to events
  const displayedEvents = useMemo(() => {
    let filtered = events;
    if (showLiveOnly) {
      filtered = filtered.filter(e => e.isLive);
    }
    if (selectedCategory !== 'all') {
      filtered = filtered.filter(e => e.sport?.toLowerCase() === selectedCategory);
    }
    return filtered;
  }, [events, showLiveOnly, selectedCategory]);

  // Apply local filters to channels
  const displayedChannels = useMemo(() => {
    if (selectedCategory === 'all') return channels;
    return channels.filter(c => c.category === selectedCategory);
  }, [channels, selectedCategory]);

  // Determine what types of content we have
  const hasEvents = useMemo(() => {
    if (selectedProvider === 'ufreetv' || selectedProvider === 'globetv') {
      return false;
    }
    return true;
  }, [selectedProvider]);

  const hasChannels = useMemo(() => {
    if (selectedProvider === 'ppv') return false;
    return true;
  }, [selectedProvider]);

  // Handlers
  const handlePlayEvent = useCallback((event: LiveEvent) => {
    setSelectedEvent(event);
    setSelectedChannel(null);
    setIsPlayerOpen(true);
  }, []);

  const handlePlayChannel = useCallback((channel: TVChannel) => {
    setSelectedChannel(channel);
    setSelectedEvent(null);
    setIsPlayerOpen(true);
  }, []);

  const handleClosePlayer = useCallback(() => {
    setIsPlayerOpen(false);
    setSelectedEvent(null);
    setSelectedChannel(null);
  }, []);

  const handleProviderChange = (provider: ProviderFilter) => {
    setSelectedProvider(provider);
    setSelectedCategory('all');
    setShowLiveOnly(false);
  };

  const handleCategoryChange = (category: string) => {
    setSelectedCategory(category);
    setShowLiveOnly(false);
  };

  const handleLiveToggle = () => {
    setShowLiveOnly(!showLiveOnly);
    if (!showLiveOnly) setSelectedCategory('all');
  };

  // Show timeline only for event providers
  const showTimelineToggle = useMemo(() => {
    return selectedProvider === 'all' || selectedProvider === 'dlhd' || selectedProvider === 'ntv' || selectedProvider === 'ppv' || selectedProvider === 'cdnlive';
  }, [selectedProvider]);

  return (
    <div className={styles.liveTVPage}>
      <main className={styles.mainContent}>
        {/* ── Header ── */}
        <header className={styles.header}>
          <div className={styles.headerContent}>
            <div className={styles.titleSection}>
              <h1 className={styles.title}>Live TV</h1>
              <p className={styles.subtitle}>
                <span className={styles.liveCount}>
                  <span className={styles.liveDotMini} />
                  {totalLive} live
                </span>
                <span className={styles.subtitleSep}>·</span>
                <span>{totalEvents} events</span>
                <span className={styles.subtitleSep}>·</span>
                <span>{totalChannels} channels</span>
              </p>
            </div>

            <div className={styles.headerActions}>
              <div className={styles.searchInputWrapper}>
                <svg className={styles.searchIcon} viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
                </svg>
                <input
                  type="text"
                  placeholder="Search events & channels..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={styles.searchInput}
                />
                {searchQuery && (
                  <button onClick={() => setSearchQuery('')} className={styles.clearSearch}>✕</button>
                )}
              </div>

              {showTimelineToggle && (
                <div className={styles.viewToggle}>
                  <button
                    onClick={() => setViewMode('grid')}
                    className={`${styles.viewToggleBtn} ${viewMode === 'grid' ? styles.active : ''}`}
                    title="Grid view"
                  >
                    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M3 3h6v6H3V3zm8 0h6v6h-6V3zM3 11h6v6H3v-6zm8 0h6v6h-6v-6z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => setViewMode('timeline')}
                    className={`${styles.viewToggleBtn} ${viewMode === 'timeline' ? styles.active : ''}`}
                    title="Timeline view"
                  >
                    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
                    </svg>
                  </button>
                </div>
              )}

              <button
                onClick={refresh}
                className={styles.refreshButton}
                disabled={loading}
                title="Refresh"
              >
                <svg className={loading ? styles.spinning : ''} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
                </svg>
              </button>
            </div>
          </div>
        </header>

        {/* ── Hero Carousel ── */}
        <LiveHero
          liveEvents={currentlyLive}
          upcomingEvents={upcoming}
          onPlay={handlePlayEvent}
          loading={loading && events.length === 0}
        />

        {/* ── Provider Chips ── */}
        <ProviderChips
          selectedProvider={selectedProvider}
          onProviderChange={handleProviderChange}
          stats={stats}
          loading={loading}
        />

        {/* ── Main Content Area ── */}
        <div className={styles.contentArea}>
          {/* Desktop Category Sidebar */}
          <CategorySidebar
            categories={sportCategories}
            selectedCategory={selectedCategory}
            onCategoryChange={handleCategoryChange}
            showLiveOnly={showLiveOnly}
            onLiveToggle={handleLiveToggle}
            liveCount={totalLive}
            channelCategories={channelCategories}
            showChannels={selectedProvider === 'all'}
          />

          {/* Content */}
          <div className={styles.contentMain}>
            {viewMode === 'timeline' && showTimelineToggle ? (
              <TimelineView
                liveEvents={currentlyLive}
                upcomingEvents={upcoming}
                onPlay={handlePlayEvent}
              />
            ) : (
              <ContentGrid
                events={displayedEvents}
                channels={displayedChannels}
                onPlayEvent={handlePlayEvent}
                onPlayChannel={handlePlayChannel}
                loading={loading}
                error={error}
                hasEvents={hasEvents}
                hasChannels={hasChannels}
              />
            )}
          </div>
        </div>
      </main>

      {/* ── Video Player Modal ── */}
      <VideoPlayer
        event={selectedEvent}
        channel={selectedChannel}
        isOpen={isPlayerOpen}
        onClose={handleClosePlayer}
      />
    </div>
  );
}
