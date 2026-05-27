'use client';

import { useState, useEffect, useCallback, createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { MediaItem } from '@/types/media';
import { queueImmediateSync, SYNC_DATA_CHANGED_EVENT, useSyncContext } from '@/lib/sync';

export interface WatchlistItem {
  id: number | string;
  title: string;
  posterPath: string;
  backdropPath?: string;
  mediaType: 'movie' | 'tv';
  releaseDate?: string;
  rating?: number;
  overview?: string;
  genres?: { id: number; name: string }[];
  addedAt: number;
}

interface WatchlistContextType {
  items: WatchlistItem[];
  addToWatchlist: (item: MediaItem) => void;
  removeFromWatchlist: (id: number | string, mediaType?: 'movie' | 'tv') => void;
  isInWatchlist: (id: number | string, mediaType?: 'movie' | 'tv') => boolean;
  clearWatchlist: () => void;
}

const WatchlistContext = createContext<WatchlistContextType | null>(null);

const STORAGE_KEY = 'flyx_watchlist';

export function WatchlistProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  
  // Sync context — always call the hook unconditionally.
  // SyncContext has a default value, so useContext never throws
  // even when SyncProvider is not in the tree.
  const syncContext = useSyncContext();

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        setItems(Array.isArray(parsed) ? parsed : []);
      }
    } catch (err) {
      console.error('[Watchlist] Error loading from localStorage:', err);
    }
    setIsLoaded(true);
  }, []);

  // Helper to check if watchlist data actually changed
  const reloadIfChanged = useCallback(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        const newItems = Array.isArray(parsed) ? parsed : [];
        
        // Only update if the data actually changed (compare IDs)
        setItems(prev => {
          const prevIds = prev.map(i => i.id).sort().join(',');
          const newIds = newItems.map((i: WatchlistItem) => i.id).sort().join(',');
          
          if (prevIds !== newIds) {
            console.log('[Watchlist] Data changed, updating items');
            return newItems;
          }
          return prev; // No change, keep same reference
        });
      }
    } catch (err) {
      console.error('[Watchlist] Error reloading from localStorage:', err);
    }
  }, []);

  // Reload when initial sync completes (only once)
  useEffect(() => {
    if (syncContext?.isInitialSyncComplete) {
      console.log('[Watchlist] Initial sync completed, checking for changes');
      reloadIfChanged();
    }
  }, [syncContext?.isInitialSyncComplete, reloadIfChanged]);

  // Listen for sync data changes and reload watchlist only if data changed
  useEffect(() => {
    const handleSyncDataChanged = () => {
      console.log('[Watchlist] Sync data changed event, checking for changes');
      reloadIfChanged();
    };
    
    window.addEventListener(SYNC_DATA_CHANGED_EVENT, handleSyncDataChanged);
    return () => window.removeEventListener(SYNC_DATA_CHANGED_EVENT, handleSyncDataChanged);
  }, [reloadIfChanged]);

  // Save to localStorage when items change and trigger sync
  useEffect(() => {
    if (isLoaded) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
        // Queue immediate sync to server when watchlist changes
        queueImmediateSync();
      } catch (err) {
        console.error('[Watchlist] Error saving to localStorage:', err);
      }
    }
  }, [items, isLoaded]);

  const addToWatchlist = useCallback((item: MediaItem) => {
    const posterUrl = item.posterPath || (item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '');
    const backdropUrl = item.backdropPath || (item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : '');
    const mediaTypeValue = (item.mediaType || item.media_type || 'movie') as 'movie' | 'tv';
    
    const watchlistItem: WatchlistItem = {
      id: item.id,
      title: item.title || item.name || 'Unknown',
      posterPath: posterUrl,
      backdropPath: backdropUrl,
      mediaType: mediaTypeValue,
      releaseDate: item.releaseDate || item.release_date || item.first_air_date,
      rating: item.rating || item.vote_average,
      overview: item.overview,
      genres: item.genres,
      addedAt: Date.now(),
    };

    setItems(prev => {
      if (prev.some(i => i.id === item.id && i.mediaType === mediaTypeValue)) return prev;
      return [watchlistItem, ...prev];
    });
  }, []);

  const removeFromWatchlist = useCallback((id: number | string, mediaType?: 'movie' | 'tv') => {
    setItems(prev => prev.filter(item => {
      if (mediaType) {
        return !(item.id === id && item.mediaType === mediaType);
      }
      return item.id !== id;
    }));
  }, []);

  const isInWatchlist = useCallback((id: number | string, mediaType?: 'movie' | 'tv') => {
    if (mediaType) {
      return items.some(item => item.id === id && item.mediaType === mediaType);
    }
    return items.some(item => item.id === id);
  }, [items]);

  const clearWatchlist = useCallback(() => {
    setItems([]);
  }, []);

  return (
    <WatchlistContext.Provider value={{ items, addToWatchlist, removeFromWatchlist, isInWatchlist, clearWatchlist }}>
      {children}
    </WatchlistContext.Provider>
  );
}

export function useWatchlist() {
  const context = useContext(WatchlistContext);
  if (!context) {
    throw new Error('useWatchlist must be used within a WatchlistProvider');
  }
  return context;
}
