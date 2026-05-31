/**
 * LiveTV Data Hook — DLHD only
 */

import { useState, useEffect, useCallback, useMemo } from 'react';

// ============================================================================
// TYPES
// ============================================================================

export type Provider = 'dlhd';
export type ProviderFilter = 'dlhd';

export interface LiveEvent {
  id: string;
  title: string;
  sport?: string;
  league?: string;
  teams?: { home: string; away: string };
  time: string;
  isoTime?: string;
  isLive: boolean;
  source: Provider;
  poster?: string;
  viewers?: string;
  channels: Array<{
    name: string;
    channelId: string;
    href: string;
  }>;
  startsAt?: number;
  endsAt?: number;
  startsIn?: string;
}

export interface TVChannel {
  id: string;
  name: string;
  category: string;
  country: string;
  countryName?: string;
  logo?: string;
  viewers?: number;
  source: Provider;
  channelId: string;
}

export interface Category {
  id: string;
  name: string;
  icon: string;
  count: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const SPORT_ICONS: Record<string, string> = {
  'soccer': '⚽', 'football': '⚽', 'basketball': '🏀', 'tennis': '🎾',
  'cricket': '🏏', 'hockey': '🏒', 'baseball': '⚾', 'golf': '⛳',
  'rugby': '🏉', 'motorsport': '🏎️', 'f1': '🏎️', 'boxing': '🥊',
  'mma': '🥊', 'ufc': '🥊', 'wwe': '🤼', 'volleyball': '🏐',
  'am. football': '🏈', 'american-football': '🏈', 'nfl': '🏈',
  'nba': '🏀', 'nhl': '🏒', 'ice-hockey': '🏒',
  'formula-1': '🏎️', 'moto-gp': '🏍️', 'nascar': '🏎️',
  'darts': '🎯', 'snooker': '🎱', 'cycling': '🚴', 'handball': '🤾',
  'aussie-rules': '🏉', 'other': '📺', 'others': '📺',
};

const CATEGORY_ICONS: Record<string, string> = {
  sports: '⚽', entertainment: '🎬', news: '📰', movies: '🎥',
  kids: '🧸', documentary: '🌍', music: '🎵', general: '📺',
};

// ============================================================================
// HELPERS
// ============================================================================

function getSportIcon(sport: string): string {
  const lower = sport.toLowerCase();
  for (const [key, icon] of Object.entries(SPORT_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return '📺';
}

function getCategoryIcon(category: string): string {
  return CATEGORY_ICONS[category.toLowerCase()] || '📺';
}

function formatLocalTime(isoTime?: string, fallbackTime?: string): string {
  if (isoTime) {
    try {
      const date = new Date(isoTime);
      if (!isNaN(date.getTime())) {
        return date.toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit', hour12: true,
        });
      }
    } catch {}
  }
  return fallbackTime || '';
}

// ============================================================================
// HOOK
// ============================================================================

export function useLiveTVData() {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCountry, setSelectedCountry] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'timeline'>('grid');

  // DLHD State
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [channels, setChannels] = useState<TVChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDLHD = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [eventsResult, channelsResult] = await Promise.allSettled([
        fetch('/api/livetv/schedule').then(r => r.json()),
        fetch('/api/livetv/dlhd-channels').then(r => r.json()),
      ]);

      // Parse events
      const parsedEvents: LiveEvent[] = [];
      if (eventsResult.status === 'fulfilled') {
        const eventsJson = eventsResult.value;
        if (eventsJson.success && eventsJson.schedule?.categories) {
          for (const category of eventsJson.schedule.categories) {
            for (const event of category.events || []) {
              parsedEvents.push({
                id: `dlhd-${event.id}`,
                title: event.title,
                sport: event.sport,
                league: event.league,
                teams: event.teams,
                time: formatLocalTime(event.isoTime, event.time),
                isoTime: event.isoTime,
                isLive: event.isLive,
                source: 'dlhd',
                channels: event.channels || [],
              });
            }
          }
        }
      } else {
        console.error('[LiveTV] Schedule fetch failed:', eventsResult.reason);
      }

      // Parse channels
      const parsedChannels: TVChannel[] = [];
      if (channelsResult.status === 'fulfilled') {
        const channelsJson = channelsResult.value;
        if (channelsJson.success && channelsJson.channels) {
          for (const ch of channelsJson.channels) {
            parsedChannels.push({
              id: ch.id,
              name: ch.name,
              category: ch.category || 'general',
              country: ch.country || '',
              countryName: ch.countryInfo?.name,
              source: 'dlhd',
              channelId: ch.id,
            });
          }
        }
      } else {
        console.error('[LiveTV] Channels fetch failed:', channelsResult.reason);
      }

      setEvents(parsedEvents);
      setChannels(parsedChannels);

      if (eventsResult.status === 'rejected' && channelsResult.status === 'rejected') {
        setError('Failed to load DLHD data');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load DLHD');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial Load
  useEffect(() => { fetchDLHD(); }, [fetchDLHD]);

  // Filtered Events
  const filteredEvents = useMemo(() => {
    if (!searchQuery) return events;
    const query = searchQuery.toLowerCase();
    return events.filter(event =>
      event.title.toLowerCase().includes(query) ||
      event.sport?.toLowerCase().includes(query) ||
      event.league?.toLowerCase().includes(query) ||
      event.teams?.home.toLowerCase().includes(query) ||
      event.teams?.away.toLowerCase().includes(query)
    );
  }, [events, searchQuery]);

  // Filtered Channels
  const filteredChannels = useMemo(() => {
    let result = channels;
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(ch =>
        ch.name.toLowerCase().includes(query) ||
        ch.category.toLowerCase().includes(query) ||
        ch.country.toLowerCase().includes(query) ||
        ch.countryName?.toLowerCase().includes(query)
      );
    }
    if (selectedCountry !== 'all') {
      result = result.filter(c => c.country === selectedCountry);
    }
    return result;
  }, [channels, searchQuery, selectedCountry]);

  // Currently live events (for hero strip)
  const currentlyLive = useMemo(() => {
    return events.filter(e => e.isLive).sort((a, b) => {
      if (a.startsAt && b.startsAt) return a.startsAt - b.startsAt;
      return 0;
    });
  }, [events]);

  // Upcoming events sorted by start time
  const upcoming = useMemo(() => {
    return events
      .filter(e => !e.isLive && e.startsAt)
      .sort((a, b) => (a.startsAt || 0) - (b.startsAt || 0));
  }, [events]);

  // Sport categories
  const sportCategories = useMemo(() => {
    const sportMap = new Map<string, number>();
    events.forEach(event => {
      if (event.sport) {
        const sport = event.sport.toLowerCase();
        sportMap.set(sport, (sportMap.get(sport) || 0) + 1);
      }
    });
    return Array.from(sportMap.entries())
      .map(([sport, count]) => ({
        id: sport,
        name: sport.charAt(0).toUpperCase() + sport.slice(1).replace(/-/g, ' '),
        icon: getSportIcon(sport),
        count,
      }))
      .sort((a, b) => b.count - a.count);
  }, [events]);

  // Channel categories
  const channelCategories = useMemo(() => {
    const categoryMap = new Map<string, number>();
    channels.forEach(channel => {
      categoryMap.set(channel.category, (categoryMap.get(channel.category) || 0) + 1);
    });
    return Array.from(categoryMap.entries())
      .map(([category, count]) => ({
        id: category,
        name: category.charAt(0).toUpperCase() + category.slice(1),
        icon: getCategoryIcon(category),
        count,
      }))
      .sort((a, b) => b.count - a.count);
  }, [channels]);

  // Available countries
  const availableCountries = useMemo(() => {
    const countryMap = new Map<string, { name: string; count: number }>();
    channels.forEach(channel => {
      if (channel.country) {
        const existing = countryMap.get(channel.country);
        if (existing) {
          existing.count++;
        } else {
          countryMap.set(channel.country, {
            name: channel.countryName || channel.country.toUpperCase(),
            count: 1,
          });
        }
      }
    });
    return Array.from(countryMap.entries())
      .map(([code, info]) => ({ code, ...info }))
      .sort((a, b) => b.count - a.count);
  }, [channels]);

  // Counts
  const totalLive = events.filter(e => e.isLive).length;
  const totalEvents = events.length;
  const totalChannels = channels.length;

  return {
    // Data
    events: filteredEvents,
    channels: filteredChannels,
    allEvents: events,
    allChannels: channels,
    currentlyLive,
    upcoming,
    sportCategories,
    channelCategories,

    // Country filter
    selectedCountry,
    setSelectedCountry,
    availableCountries,

    // View mode
    viewMode,
    setViewMode,

    // State
    loading,
    error,

    // Search
    searchQuery,
    setSearchQuery,

    // Stats
    stats: { dlhd: { events: events.length, channels: channels.length, live: totalLive } },
    totalLive,
    totalEvents,
    totalChannels,

    // DLHD-specific
    dlhdEvents: events,
    dlhdChannels: channels,

    // Actions
    refresh: fetchDLHD,
  };
}

// Re-export for backwards compatibility
export type DLHDChannel = TVChannel;
