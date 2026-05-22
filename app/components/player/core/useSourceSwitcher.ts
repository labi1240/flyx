/**
 * useSourceSwitcher — Source switching with HLS teardown/reinit
 * 
 * Handles switching between stream sources (different servers, providers,
 * sub/dub variants) while preserving playback position. Manages HLS
 * instance teardown and reinitialization on source change.
 * 
 * Requirements: 6.1, 6.5
 */
'use client';

import { useCallback } from 'react';
import { getAnimeKaiProxyUrl, getHiAnimeStreamProxyUrl } from '@/app/lib/proxy-config';
import type { PlayerSource } from './types';

export interface UseSourceSwitcherOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  pendingSeekTimeRef: React.MutableRefObject<number | null>;
  sourceConfirmedWorkingRef: React.MutableRefObject<boolean>;
  currentSourceIndex: number;
  setCurrentSourceIndex: (index: number) => void;
  setStreamUrl: (url: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  availableSources: PlayerSource[];
  setAvailableSources: React.Dispatch<React.SetStateAction<PlayerSource[]>>;
  provider: string;
}

export interface UseSourceSwitcherReturn {
  switchSource: (sourceIndex: number) => void;
  tryNextSource: () => boolean;
  applyProxy: (source: PlayerSource) => string;
}

export function useSourceSwitcher(options: UseSourceSwitcherOptions): UseSourceSwitcherReturn {
  const {
    videoRef,
    pendingSeekTimeRef,
    sourceConfirmedWorkingRef,
    currentSourceIndex,
    setCurrentSourceIndex,
    setStreamUrl,
    setLoading,
    setError,
    availableSources,
    setAvailableSources,
  } = options;

  const applyProxy = useCallback((source: PlayerSource): string => {
    let finalUrl = source.url;
    if (source.requiresSegmentProxy) {
      const isAlreadyProxied =
        finalUrl.includes('/api/stream-proxy') ||
        finalUrl.includes('/stream/?url=') ||
        finalUrl.includes('/stream?url=') ||
        finalUrl.includes('/animekai?url=') ||
        finalUrl.includes('/animekai/?url=') ||
        finalUrl.includes('/flixer/stream?url=');

      if (!isAlreadyProxied) {
        const targetUrl = source.directUrl || source.url;
        // Route through provider-specific proxy
        const isFlixerSource = source.title?.toLowerCase().includes('flixer') ||
                               options.provider === 'flixer';
        const isHiAnimeSource = source.title?.toLowerCase().includes('hianime') ||
                                options.provider === 'hianime';
        if (isFlixerSource) {
          // Flixer CDN blocks all proxy IPs — return raw, let the SW handle it
          finalUrl = targetUrl;
        } else if (isHiAnimeSource) {
          finalUrl = getHiAnimeStreamProxyUrl(targetUrl);
        } else {
          finalUrl = getAnimeKaiProxyUrl(targetUrl);
        }
      }
    }
    return finalUrl;
  }, [options.provider]);

  const switchSource = useCallback((sourceIndex: number) => {
    const source = availableSources[sourceIndex];
    if (!source?.url) return;

    // Save current position for restoration
    if (videoRef.current && videoRef.current.currentTime > 0) {
      pendingSeekTimeRef.current = videoRef.current.currentTime;
    }

    sourceConfirmedWorkingRef.current = false;
    setCurrentSourceIndex(sourceIndex);
    setLoading(true);
    setError(null);

    const finalUrl = applyProxy(source);
    setStreamUrl(finalUrl);
  }, [
    availableSources,
    videoRef,
    pendingSeekTimeRef,
    sourceConfirmedWorkingRef,
    setCurrentSourceIndex,
    setLoading,
    setError,
    setStreamUrl,
    applyProxy,
  ]);

  const tryNextSource = useCallback((): boolean => {
    // Mark current source as down if it was never confirmed working
    if (!sourceConfirmedWorkingRef.current) {
      setAvailableSources(prev => {
        const updated = [...prev];
        if (updated[currentSourceIndex]) {
          updated[currentSourceIndex] = { ...updated[currentSourceIndex], status: 'down' };
        }
        return updated;
      });
    }

    // Find next available source
    for (let i = currentSourceIndex + 1; i < availableSources.length; i++) {
      const nextSource = availableSources[i];
      if (!nextSource?.url) continue;

      // Save current position
      if (videoRef.current && videoRef.current.currentTime > 0 && pendingSeekTimeRef.current === null) {
        pendingSeekTimeRef.current = videoRef.current.currentTime;
      }

      sourceConfirmedWorkingRef.current = false;
      setCurrentSourceIndex(i);
      const finalUrl = applyProxy(nextSource);
      setStreamUrl(finalUrl);
      return true;
    }

    return false;
  }, [
    currentSourceIndex,
    availableSources,
    videoRef,
    pendingSeekTimeRef,
    sourceConfirmedWorkingRef,
    setCurrentSourceIndex,
    setStreamUrl,
    setAvailableSources,
    applyProxy,
  ]);

  return {
    switchSource,
    tryNextSource,
    applyProxy,
  };
}
