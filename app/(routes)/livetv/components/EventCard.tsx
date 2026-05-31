/**
 * Event Card Component
 * Individual event/stream card with play functionality
 */

import { memo } from 'react';
import { LiveEvent } from '../hooks/useLiveTVData';
import styles from '../LiveTV.module.css';

interface EventCardProps {
  event: LiveEvent;
  onPlay: (event: LiveEvent) => void;
  featured?: boolean;
}

export const EventCard = memo(function EventCard({
  event,
  onPlay,
  featured = false,
}: EventCardProps) {
  const handlePlay = () => {
    onPlay(event);
  };

  const formatTeamsDisplay = () => {
    if (event.teams) {
      return `${event.teams.home} vs ${event.teams.away}`;
    }
    return event.title;
  };

  const getSourceBadge = () => {
    if (event.source === 'dlhd') return { label: 'DLHD', color: 'blue' };
    return { label: 'LIVE', color: 'gray' };
  };

  const sourceBadge = getSourceBadge();

  return (
    <div className={`${styles.eventCard} ${featured ? styles.featured : ''}`}>
      {/* Poster/Thumbnail */}
      <div className={styles.eventPoster}>
        {event.poster ? (
          <img 
            src={event.poster} 
            alt={event.title}
            className={styles.posterImage}
            loading="lazy"
          />
        ) : (
          <div className={styles.posterPlaceholder}>
            <span className={styles.sportIcon}>
              {event.sport ? getSportIcon(event.sport) : '📺'}
            </span>
          </div>
        )}
        
        {/* Overlay */}
        <div className={styles.eventOverlay}>
          <button 
            onClick={handlePlay}
            className={styles.playButton}
            aria-label={`Play ${event.title}`}
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
          </button>
        </div>

        {/* Live Indicator */}
        {event.isLive && (
          <div className={styles.liveIndicator}>
            <span className={styles.liveDot}></span>
            LIVE
          </div>
        )}

        {/* Source Badge */}
        <div className={`${styles.sourceBadge} ${styles[sourceBadge.color]}`}>
          {sourceBadge.label}
        </div>
      </div>

      {/* Event Info */}
      <div className={styles.eventInfo}>
        <div className={styles.eventHeader}>
          <h3 className={styles.eventTitle}>
            {formatTeamsDisplay()}
          </h3>
          {event.league && (
            <span className={styles.eventLeague}>{event.league}</span>
          )}
        </div>

        <div className={styles.eventMeta}>
          <div className={styles.eventTime}>
            <svg className={styles.timeIcon} viewBox="0 0 20 20" fill="currentColor">
              <path 
                fillRule="evenodd" 
                d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" 
                clipRule="evenodd" 
              />
            </svg>
            <span>{event.time}</span>
          </div>

          {event.sport && (
            <div className={styles.eventSport}>
              <span className={styles.sportIcon}>
                {getSportIcon(event.sport)}
              </span>
              <span>{event.sport}</span>
            </div>
          )}

          {event.viewers && (
            <div className={styles.eventViewers}>
              <svg className={styles.viewersIcon} viewBox="0 0 20 20" fill="currentColor">
                <path d="M10 12a2 2 0 100-4 2 2 0 000 4z"/>
                <path 
                  fillRule="evenodd" 
                  d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" 
                  clipRule="evenodd" 
                />
              </svg>
              <span>{event.viewers}</span>
            </div>
          )}
        </div>

        {/* Channels */}
        {event.channels.length > 0 && (
          <div className={styles.eventChannels}>
            <span className={styles.channelsLabel}>
              {event.channels.length} channel{event.channels.length !== 1 ? 's' : ''}
            </span>
          </div>
        )}
      </div>
    </div>
  );
});

// Helper function for sport icons (moved from hook to avoid circular dependency)
function getSportIcon(sport: string): string {
  const SPORT_ICONS: Record<string, string> = {
    'soccer': '⚽', 'football': '⚽', 'basketball': '🏀', 'tennis': '🎾',
    'cricket': '🏏', 'hockey': '🏒', 'baseball': '⚾', 'golf': '⛳',
    'rugby': '🏉', 'motorsport': '🏎️', 'f1': '🏎️', 'boxing': '🥊',
    'mma': '🥊', 'ufc': '🥊', 'wwe': '🤼', 'volleyball': '🏐',
    'am. football': '🏈', 'nfl': '🏈', 'darts': '🎯', '24/7': '📺',
  };

  const lower = sport.toLowerCase();
  for (const [key, icon] of Object.entries(SPORT_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return '📺';
}