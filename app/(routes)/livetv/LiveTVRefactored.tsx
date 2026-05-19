/**
 * LiveTV Page - Refactored
 * Clean separation: Live Events vs TV Channels
 */

'use client';

import { useState, useCallback, useMemo } from 'react';
import { useLiveTVData, LiveEvent, TVChannel, ContentType } from './hooks/useLiveTVData';
import { VideoPlayer } from './components/VideoPlayer';
import styles from './LiveTV.module.css';

// Sport icons helper
const SPORT_ICONS: Record<string, string> = {
  'soccer': '⚽', 'football': '⚽', 'basketball': '🏀', 'tennis': '🎾',
  'cricket': '🏏', 'hockey': '🏒', 'baseball': '⚾', 'golf': '⛳',
  'rugby': '🏉', 'motorsport': '🏎️', 'f1': '🏎️', 'boxing': '🥊',
  'mma': '🥊', 'ufc': '🥊', 'wwe': '🤼', 'volleyball': '🏐',
  'nfl': '🏈', 'darts': '🎯',
};

function getSportIcon(sport: string): string {
  const lower = sport.toLowerCase();
  for (const [key, icon] of Object.entries(SPORT_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return '📺';
}

export default function LiveTVRefactored() {
  const {
    contentType,
    setContentType,
    selectedProvider,
    setSelectedProvider,
    events,
    channels,
    eventCategories,
    channelCategories,
    loading,
    error,
    searchQuery,
    setSearchQuery,
    stats,
    refresh,
  } = useLiveTVData();

  // Player state
  const [selectedEvent, setSelectedEvent] = useState<LiveEvent | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<TVChannel | null>(null);
  const [isPlayerOpen, setIsPlayerOpen] = useState(false);

  // Filters
  const [showLiveOnly, setShowLiveOnly] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  // Filtered data
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

  const displayedChannels = useMemo(() => {
    if (selectedCategory === 'all') return channels;
    return channels.filter(c => c.category === selectedCategory);
  }, [channels, selectedCategory]);

  // Handlers
  const handlePlayEvent = useCallback((event: LiveEvent) => {
    setSelectedEvent(event);
    setSelectedChannel(null);
    setIsPlayerOpen(true);
  }, []);

  const handlePlayChannel = useCallback((channel: TVChannel) => {
    // Convert TVChannel to a format VideoPlayer understands
    setSelectedChannel(channel as any);
    setSelectedEvent(null);
    setIsPlayerOpen(true);
  }, []);

  const handleClosePlayer = useCallback(() => {
    setIsPlayerOpen(false);
    setSelectedEvent(null);
    setSelectedChannel(null);
  }, []);

  const handleContentTypeChange = (type: ContentType) => {
    setContentType(type);
    setSelectedCategory('all');
    setShowLiveOnly(false);
  };

  const handleProviderChange = (provider: typeof selectedProvider) => {
    setSelectedProvider(provider);
    setSelectedCategory('all');
    setShowLiveOnly(false);
  };

  // Total counts
  const totalEvents = stats.dlhd.events + stats.ppv.events;
  const totalLive = stats.dlhd.live + stats.ppv.live;
  const totalChannels = stats.dlhd.channels + stats.cdnlive.channels;

  return (
    <div className={styles.liveTVPage}>
      
      <main className={styles.mainContent}>
        {/* Header */}
        <header className={styles.header}>
          <div className={styles.headerContent}>
            <div className={styles.titleSection}>
              <h1 className={styles.title}>Live TV</h1>
              <p className={styles.subtitle}>
                {totalLive} live • {totalEvents} events • {totalChannels} channels
              </p>
            </div>
            
            <div className={styles.headerActions}>
              <div className={styles.searchInputWrapper}>
                <svg className={styles.searchIcon} viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
                </svg>
                <input
                  type="text"
                  placeholder="Search..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={styles.searchInput}
                />
                {searchQuery && (
                  <button onClick={() => setSearchQuery('')} className={styles.clearSearch}>✕</button>
                )}
              </div>
              
              <button 
                onClick={refresh} 
                className={styles.refreshButton}
                disabled={loading}
              >
                <svg className={loading ? styles.spinning : ''} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
                </svg>
              </button>
            </div>
          </div>
        </header>

        {/* Main Content Type Toggle */}
        <div className={styles.contentTypeToggle}>
          <button
            onClick={() => handleContentTypeChange('events')}
            className={`${styles.contentTypeBtn} ${contentType === 'events' ? styles.active : ''}`}
          >
            <span className={styles.contentTypeIcon}>🏟️</span>
            <span className={styles.contentTypeLabel}>Live Events</span>
            <span className={styles.contentTypeCount}>{totalEvents}</span>
          </button>
          <button
            onClick={() => handleContentTypeChange('channels')}
            className={`${styles.contentTypeBtn} ${contentType === 'channels' ? styles.active : ''}`}
          >
            <span className={styles.contentTypeIcon}>📺</span>
            <span className={styles.contentTypeLabel}>TV Channels</span>
            <span className={styles.contentTypeCount}>{totalChannels}</span>
          </button>
        </div>

        {/* Events View */}
        {contentType === 'events' && (
          <div className={styles.contentSection}>
            {/* Source Tabs */}
            <div className={styles.sourceTabs}>
              <button
                onClick={() => handleProviderChange('dlhd')}
                className={`${styles.sourceTab} ${selectedProvider === 'dlhd' ? styles.active : ''}`}
              >
                <span className={styles.sourceTabIcon}>📡</span>
                <span className={styles.sourceTabLabel}>DLHD</span>
                <span className={styles.sourceTabCount}>{stats.dlhd.events}</span>
              </button>
              <button
                onClick={() => handleProviderChange('ppv')}
                className={`${styles.sourceTab} ${selectedProvider === 'ppv' ? styles.active : ''}`}
              >
                <span className={styles.sourceTabIcon}>🏟️</span>
                <span className={styles.sourceTabLabel}>PPV.to</span>
                <span className={styles.sourceTabCount}>{stats.ppv.events}</span>
              </button>
              <button
                onClick={() => handleProviderChange('ntv')}
                className={`${styles.sourceTab} ${selectedProvider === 'ntv' ? styles.active : ''}`}
              >
                <span className={styles.sourceTabIcon}>🛰️</span>
                <span className={styles.sourceTabLabel}>NTV</span>
                <span className={styles.sourceTabCount}>{stats.ntv.events}</span>
              </button>
            </div>

            {/* Filters */}
            <div className={styles.filterBar}>
              <button
                onClick={() => setShowLiveOnly(!showLiveOnly)}
                className={`${styles.filterPill} ${showLiveOnly ? styles.active : ''}`}
              >
                <span className={styles.liveDot} />
                Live Now ({selectedProvider === 'ppv' ? stats.ppv.live : selectedProvider === 'ntv' ? stats.ntv.live : stats.dlhd.live})
              </button>
              
              <button
                onClick={() => setSelectedCategory('all')}
                className={`${styles.filterPill} ${selectedCategory === 'all' ? styles.active : ''}`}
              >
                🏆 All Sports
              </button>
              
              {eventCategories.slice(0, 8).map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => setSelectedCategory(cat.id === selectedCategory ? 'all' : cat.id)}
                  className={`${styles.filterPill} ${selectedCategory === cat.id ? styles.active : ''}`}
                >
                  {cat.icon} {cat.name} ({cat.count})
                </button>
              ))}
            </div>

            {/* Events Grid */}
            <div className={styles.contentContainer}>
              {loading ? (
                <div className={styles.gridPlaceholder}>
                  {Array.from({ length: 12 }).map((_, i) => (
                    <div key={i} className={styles.cardSkeleton} />
                  ))}
                </div>
              ) : error ? (
                <div className={styles.messageBox}>
                  <span className={styles.messageIcon}>⚠️</span>
                  <p>{error}</p>
                  <button onClick={refresh} className={styles.actionButton}>Retry</button>
                </div>
              ) : displayedEvents.length === 0 ? (
                <div className={styles.messageBox}>
                  <span className={styles.messageIcon}>📺</span>
                  <p>No events found. Try adjusting your filters.</p>
                </div>
              ) : (
                <>
                  <div className={styles.contentHeader}>
                    <span className={styles.contentCount}>
                      {displayedEvents.length} events
                      {showLiveOnly && ` • ${displayedEvents.filter(e => e.isLive).length} live`}
                    </span>
                  </div>
                  <div className={styles.simpleGrid}>
                    {displayedEvents.map((event) => (
                      <EventCard key={event.id} event={event} onPlay={handlePlayEvent} />
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Channels View */}
        {contentType === 'channels' && (
          <div className={styles.contentSection}>
            {/* Source Tabs */}
            <div className={styles.sourceTabs}>
              <button
                onClick={() => setSelectedProvider('dlhd')}
                className={`${styles.sourceTab} ${selectedProvider === 'dlhd' ? styles.active : ''}`}
              >
                <span className={styles.sourceTabIcon}>📡</span>
                <span className={styles.sourceTabLabel}>DLHD</span>
                <span className={styles.sourceTabCount}>{stats.dlhd.channels}</span>
              </button>
              <button
                onClick={() => setSelectedProvider('cdnlive')}
                className={`${styles.sourceTab} ${selectedProvider === 'cdnlive' ? styles.active : ''}`}
              >
                <span className={styles.sourceTabIcon}>🌐</span>
                <span className={styles.sourceTabLabel}>CDN Live</span>
                <span className={styles.sourceTabCount}>{stats.cdnlive.channels}</span>
              </button>
              <button
                onClick={() => setSelectedProvider('ntv')}
                className={`${styles.sourceTab} ${selectedProvider === 'ntv' ? styles.active : ''}`}
              >
                <span className={styles.sourceTabIcon}>🛰️</span>
                <span className={styles.sourceTabLabel}>NTV</span>
                <span className={styles.sourceTabCount}>{stats.ntv.channels}</span>
              </button>
            </div>

            {/* Category Filters */}
            <div className={styles.filterBar}>
              <button
                onClick={() => setSelectedCategory('all')}
                className={`${styles.filterPill} ${selectedCategory === 'all' ? styles.active : ''}`}
              >
                📺 All Channels
              </button>
              
              {channelCategories.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => setSelectedCategory(cat.id === selectedCategory ? 'all' : cat.id)}
                  className={`${styles.filterPill} ${selectedCategory === cat.id ? styles.active : ''}`}
                >
                  {cat.icon} {cat.name} ({cat.count})
                </button>
              ))}
            </div>

            {/* Channels Grid */}
            <div className={styles.contentContainer}>
              {loading ? (
                <div className={styles.channelGridPlaceholder}>
                  {Array.from({ length: 18 }).map((_, i) => (
                    <div key={i} className={styles.channelSkeleton} />
                  ))}
                </div>
              ) : error ? (
                <div className={styles.messageBox}>
                  <span className={styles.messageIcon}>⚠️</span>
                  <p>{error}</p>
                  <button onClick={refresh} className={styles.actionButton}>Retry</button>
                </div>
              ) : displayedChannels.length === 0 ? (
                <div className={styles.messageBox}>
                  <span className={styles.messageIcon}>📺</span>
                  <p>No channels found. Try adjusting your filters.</p>
                </div>
              ) : (
                <>
                  <div className={styles.contentHeader}>
                    <span className={styles.contentCount}>{displayedChannels.length} channels</span>
                  </div>
                  <div className={styles.channelGrid}>
                    {displayedChannels.map((channel) => (
                      <ChannelCard key={channel.id} channel={channel} onPlay={handlePlayChannel} />
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </main>

      <VideoPlayer
        event={selectedEvent}
        channel={selectedChannel as any}
        isOpen={isPlayerOpen}
        onClose={handleClosePlayer}
      />
    </div>
  );
}

// ============================================================================
// EVENT CARD COMPONENT
// ============================================================================

interface EventCardProps {
  event: LiveEvent;
  onPlay: (event: LiveEvent) => void;
}

function EventCard({ event, onPlay }: EventCardProps) {
  const formatTeamsDisplay = () => {
    if (event.teams) {
      return `${event.teams.home} vs ${event.teams.away}`;
    }
    return event.title;
  };

  const getSourceBadge = () => {
    switch (event.source) {
      case 'dlhd': return { label: 'DLHD', color: 'blue' };
      case 'cdnlive': return { label: 'CDN', color: 'green' };
      case 'ppv': return { label: 'PPV', color: 'purple' };
      case 'ntv': return { label: 'NTV', color: 'orange' };
      default: return { label: 'LIVE', color: 'gray' };
    }
  };

  const sourceBadge = getSourceBadge();

  return (
    <div className={styles.eventCard} onClick={() => onPlay(event)}>
      <div className={styles.eventPoster}>
        {event.poster ? (
          <img src={event.poster} alt={event.title} className={styles.posterImage} loading="lazy" />
        ) : (
          <div className={styles.posterPlaceholder}>
            <span className={styles.sportIconLarge}>{event.sport ? getSportIcon(event.sport) : '📺'}</span>
          </div>
        )}
        
        <div className={styles.eventOverlay}>
          <button className={styles.playButton} aria-label={`Play ${event.title}`}>
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
          </button>
        </div>

        {event.isLive && (
          <div className={styles.liveIndicator}>
            <span className={styles.liveDot}></span>
            LIVE
          </div>
        )}

        {!event.isLive && event.startsIn && (
          <div className={styles.upcomingIndicator}>
            in {event.startsIn}
          </div>
        )}

        <div className={`${styles.sourceBadge} ${styles[sourceBadge.color]}`}>
          {sourceBadge.label}
        </div>
      </div>

      <div className={styles.eventInfo}>
        <h3 className={styles.eventTitle}>{formatTeamsDisplay()}</h3>
        {event.league && <span className={styles.eventLeague}>{event.league}</span>}
        
        <div className={styles.eventMeta}>
          <span className={styles.eventTime}>
            <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
            </svg>
            {event.time}
          </span>
          {event.sport && (
            <span className={styles.eventSport}>
              {getSportIcon(event.sport)} {event.sport}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// CHANNEL CARD COMPONENT
// ============================================================================

interface ChannelCardProps {
  channel: TVChannel;
  onPlay: (channel: TVChannel) => void;
}

function ChannelCard({ channel, onPlay }: ChannelCardProps) {
  const getSourceColor = () => {
    return channel.source === 'cdnlive' ? styles.cdnSource : styles.dlhdSource;
  };

  return (
    <div className={`${styles.channelCard} ${getSourceColor()}`} onClick={() => onPlay(channel)}>
      <div className={styles.channelLogo}>
        {channel.logo ? (
          <img src={channel.logo} alt={channel.name} loading="lazy" />
        ) : (
          <span className={styles.channelLogoPlaceholder}>📺</span>
        )}
      </div>
      
      <div className={styles.channelInfo}>
        <h4 className={styles.channelName}>{channel.name}</h4>
        <div className={styles.channelMeta}>
          <span className={styles.channelCategory}>{channel.category}</span>
          {channel.countryName && (
            <span className={styles.channelCountry}>{channel.countryName}</span>
          )}
        </div>
      </div>
      
      <div className={styles.channelActions}>
        {channel.viewers !== undefined && channel.viewers > 0 && (
          <span className={styles.channelViewers}>
            <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor">
              <path d="M10 12a2 2 0 100-4 2 2 0 000 4z"/>
              <path fillRule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
            </svg>
            {channel.viewers}
          </span>
        )}
        <span className={styles.channelPlayBtn}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z"/>
          </svg>
        </span>
      </div>
    </div>
  );
}
