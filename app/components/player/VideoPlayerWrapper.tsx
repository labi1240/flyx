'use client';

import { useState, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useIsMobile } from '@/hooks/useIsMobile';
import { getAnimeKaiProxyUrl, getFlixerStreamProxyUrl, getHiAnimeStreamProxyUrl } from '@/app/lib/proxy-config';
import { getProviderSettings } from '@/lib/sync';

// Dynamically import players to reduce initial bundle size
const DesktopVideoPlayer = dynamic(
  () => import('./VideoPlayer'),
  { 
    ssr: false,
    loading: () => <PlayerLoadingState message="Loading player..." />
  }
);

const MobileVideoPlayer = dynamic(
  () => import('./MobileVideoPlayer'),
  { 
    ssr: false,
    loading: () => <PlayerLoadingState message="Loading player..." />
  }
);

// Loading state component
function PlayerLoadingState({ message }: { message: string }) {
  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#000',
      color: 'white',
      gap: '1rem',
    }}>
      <div style={{
        width: '48px',
        height: '48px',
        border: '3px solid rgba(255, 255, 255, 0.2)',
        borderTopColor: '#e50914',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
      }} />
      <p style={{ fontSize: '0.9rem', color: 'rgba(255, 255, 255, 0.8)' }}>{message}</p>
      <style jsx>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

interface VideoPlayerWrapperProps {
  tmdbId: string;
  mediaType: 'movie' | 'tv';
  season?: number;
  episode?: number;
  title?: string;
  nextEpisode?: {
    season: number;
    episode: number;
    title?: string;
    isNextSeason?: boolean;
  } | null;
  onNextEpisode?: () => void;
  onBack?: () => void;
  autoplay?: boolean;
  malId?: number;
  malTitle?: string;
  // Force a specific player mode (for testing)
  forceMode?: 'mobile' | 'desktop';
}

export default function VideoPlayerWrapper(props: VideoPlayerWrapperProps) {
  const mobileInfo = useIsMobile();
  const [streamData, setStreamData] = useState<{
    url: string;
    sources: Array<{ title: string; url: string; quality?: string; requiresSegmentProxy?: boolean }>;
    currentIndex: number;
    provider: string;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { tmdbId, mediaType, season, episode, forceMode, malId, malTitle, title: contentTitle } = props;

  // Determine if we should use mobile player
  const useMobilePlayer = forceMode === 'mobile' || 
    (forceMode !== 'desktop' && mobileInfo.isMobile && mobileInfo.screenWidth < 1024);

  // Fetch stream sources
  const fetchSources = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Check provider availability first
      const providersRes = await fetch('/api/providers');
      const providersData = await providersRes.json();
      
      const availability = {
        videasy: providersData.providers?.videasy?.enabled ?? true,
        flixer: providersData.providers?.flixer?.enabled ?? true,
        bingebox: providersData.providers?.bingebox?.enabled ?? true,
        primesrc: providersData.providers?.primesrc?.enabled ?? true,
        vidsrc: providersData.providers?.vidsrc?.enabled ?? true,
        moviebox: providersData.providers?.moviebox?.enabled ?? true,
        hianime: providersData.providers?.hianime?.enabled ?? true,
        miruro: providersData.providers?.miruro?.enabled ?? true,
      };

      // Build provider order respecting user's preferred order from settings
      const userSettings = getProviderSettings();
      const userOrder = userSettings.providerOrder || [];
      const disabledProviders = new Set(userSettings.disabledProviders || []);
      const providerOrder: string[] = [];

      // Add providers from user's preferred order
      for (const p of userOrder) {
        if (providerOrder.includes(p)) continue;
        if (disabledProviders.has(p)) continue;
        if (!availability[p as keyof typeof availability]) continue;
        providerOrder.push(p);
      }

      // Add any remaining available providers as fallback
      const allProviders = ['videasy', 'flixer', 'bingebox', 'hianime', 'miruro', 'primesrc', 'vidsrc', 'moviebox'];
      for (const p of allProviders) {
        if (providerOrder.includes(p)) continue;
        if (disabledProviders.has(p)) continue;
        if (!availability[p as keyof typeof availability]) continue;
        providerOrder.push(p);
      }

      // Try each provider
      for (const provider of providerOrder) {
        try {
          // Flixer: Browser-direct extraction via CF Worker
          // The CF Worker /flixer/extract-all handles everything server-side
          // (WASM keygen, API call, decrypt).
          if (provider === 'flixer') {
            const { extractFlixerClient } = await import('@/app/lib/services/flixer-client-extractor');
            const flixerSources = await extractFlixerClient(tmdbId, mediaType as 'movie' | 'tv', season, episode);
            if (flixerSources.length > 0) {
              const sources = flixerSources;
              let sourceUrl = sources[0].url;
              
              // Apply proxy — Flixer CDN blocks non-whitelisted origins
              if (sources[0].requiresSegmentProxy) {
                const isAlreadyProxied = sourceUrl.includes('/api/stream-proxy') || 
                  sourceUrl.includes('/stream/') ||
                  sourceUrl.includes('/animekai') ||
                  sourceUrl.includes('/flixer/stream');
                
                if (!isAlreadyProxied) {
                  sourceUrl = getFlixerStreamProxyUrl(sourceUrl);
                }
              }

              setStreamData({
                url: sourceUrl,
                sources: sources.map((s: any) => ({
                  title: s.title || s.quality || 'Source',
                  url: s.url,
                  quality: s.quality,
                  requiresSegmentProxy: s.requiresSegmentProxy,
                })),
                currentIndex: 0,
                provider: 'flixer',
              });
              setIsLoading(false);
              return;
            }
            continue;
          }

          // VIDEASY: Backup source — browser-direct extraction via CF Worker
          if (provider === 'videasy') {
            const { extractVideasyClient } = await import('@/app/lib/services/videasy-client-extractor');
            const videasySources = await extractVideasyClient(tmdbId, mediaType as 'movie' | 'tv', contentTitle || '', season, episode);
            if (videasySources.length > 0) {
              const sources = videasySources;
              const sourceUrl = sources[0].url;

              setStreamData({
                url: sourceUrl,
                sources: sources.map((s: any) => ({
                  title: s.title || s.quality || 'Source',
                  url: s.url,
                  quality: s.quality,
                  requiresSegmentProxy: s.requiresSegmentProxy,
                })),
                currentIndex: 0,
                provider: 'videasy',
              });
              setIsLoading(false);
              return;
            }
            continue;
          }

          // BINGEBOX: Browser-direct extraction via CF Worker
          if (provider === 'bingebox') {
            const { extractBingeBoxClient } = await import('@/app/lib/services/bingebox-client-extractor');
            const bbSources = await extractBingeBoxClient(tmdbId, mediaType as 'movie' | 'tv', contentTitle || '', season, episode);
            if (bbSources.length > 0) {
              const sources = bbSources;
              const sourceUrl = sources[0].url;

              setStreamData({
                url: sourceUrl,
                sources: sources.map((s: any) => ({
                  title: s.title || s.quality || 'Source',
                  url: s.url,
                  quality: s.quality,
                  requiresSegmentProxy: s.requiresSegmentProxy,
                })),
                currentIndex: 0,
                provider: 'bingebox',
              });
              setIsLoading(false);
              return;
            }
            continue;
          }

          // HIANIME: Browser-direct via CF Worker /hianime/extract (anime only)
          if (provider === 'hianime') {
            if (!malId || !contentTitle) continue;
            const { extractHiAnimeClient } = await import('@/app/lib/services/hianime-client-extractor');
            const hiSources = await extractHiAnimeClient(malId, contentTitle, episode);
            if (hiSources.length > 0) {
              setStreamData({
                url: hiSources[0].url,
                sources: hiSources.map((s: any) => ({
                  title: s.title || s.quality || 'Source',
                  url: s.url,
                  quality: s.quality,
                  requiresSegmentProxy: s.requiresSegmentProxy,
                })),
                currentIndex: 0,
                provider: 'hianime',
              });
              setIsLoading(false);
              return;
            }
            continue;
          }

          // MIRURO: Browser-direct via CF Worker /miruro/* (anime only)
          if (provider === 'miruro') {
            if (!malId || !contentTitle) continue;
            const { extractMiruroClient } = await import('@/app/lib/services/miruro-client-extractor');
            const miSources = await extractMiruroClient(malId, contentTitle, episode);
            if (miSources.length > 0) {
              setStreamData({
                url: miSources[0].url,
                sources: miSources.map((s: any) => ({
                  title: s.title || s.quality || 'Source',
                  url: s.url,
                  quality: s.quality,
                  requiresSegmentProxy: s.requiresSegmentProxy,
                })),
                currentIndex: 0,
                provider: 'miruro',
              });
              setIsLoading(false);
              return;
            }
            continue;
          }

          // OTHER PROVIDERS: Use the generic extract API
          const params = new URLSearchParams({
            tmdbId,
            type: mediaType,
            provider,
          });

          if (mediaType === 'tv' && season && episode) {
            params.append('season', season.toString());
            params.append('episode', episode.toString());
          }
          
          if (malId) params.append('malId', malId.toString());
          if (malTitle) params.append('malTitle', malTitle);

          const response = await fetch(`/api/stream/extract?${params}`, {
            cache: 'no-store',
          });
          const data = await response.json();

          if (data.sources && data.sources.length > 0) {
            const sources = data.sources;
            const actualProvider = data.provider || provider;
            
            // Get the first source URL
            let sourceUrl = sources[0].url;
            
            // Apply proxy if needed — route through provider-specific proxy
            if (sources[0].requiresSegmentProxy) {
              const isAlreadyProxied = sourceUrl.includes('/api/stream-proxy') || 
                sourceUrl.includes('/stream/') ||
                sourceUrl.includes('/animekai') ||
                sourceUrl.includes('/flixer/stream');
              
              if (!isAlreadyProxied) {
                const targetUrl = sources[0].directUrl || sourceUrl;
                if (actualProvider === 'flixer') {
                  sourceUrl = getFlixerStreamProxyUrl(targetUrl);
                } else if (actualProvider === 'hianime') {
                  sourceUrl = getHiAnimeStreamProxyUrl(targetUrl);
                } else {
                  sourceUrl = getAnimeKaiProxyUrl(targetUrl);
                }
              }
            }

            setStreamData({
              url: sourceUrl,
              sources: sources.map((s: any) => ({
                title: s.title || s.quality || 'Source',
                url: s.url,
                quality: s.quality,
                requiresSegmentProxy: s.requiresSegmentProxy,
              })),
              currentIndex: 0,
              provider: actualProvider,
            });
            setIsLoading(false);
            return;
          }
        } catch (e) {
          console.warn(`[VideoPlayerWrapper] ${provider} failed:`, e);
        }
      }

      // All providers failed
      setError('No streams available. Please try again later.');
      setIsLoading(false);
    } catch (e) {
      console.error('[VideoPlayerWrapper] Error fetching sources:', e);
      setError('Failed to load video. Please try again.');
      setIsLoading(false);
    }
  }, [tmdbId, mediaType, season, episode, malId, malTitle]);

  // Fetch sources on mount
  useEffect(() => {
    fetchSources();
  }, [fetchSources]);

  // Handle source change
  const handleSourceChange = useCallback((index: number, currentTime?: number) => {
    if (!streamData || index >= streamData.sources.length) return;

    const source = streamData.sources[index];
    let sourceUrl = source.url;

    // Apply proxy if needed — route through provider-specific proxy
    if (source.requiresSegmentProxy) {
      const isAlreadyProxied = sourceUrl.includes('/api/stream-proxy') ||
        sourceUrl.includes('/stream/') ||
        sourceUrl.includes('/flixer/stream');

      if (!isAlreadyProxied) {
        if (streamData.provider === 'flixer') {
          sourceUrl = getFlixerStreamProxyUrl(sourceUrl);
        } else {
          sourceUrl = getAnimeKaiProxyUrl(sourceUrl);
        }
      }
    }

    setStreamData(prev => prev ? {
      ...prev,
      url: sourceUrl,
      currentIndex: index,
    } : null);
    
    // Note: currentTime is passed but not used here since the player handles position restoration
    console.log('[VideoPlayerWrapper] Source changed to index:', index, 'currentTime:', currentTime);
  }, [streamData]);

  // Handle errors from player
  const handlePlayerError = useCallback((errorMsg: string) => {
    console.error('[VideoPlayerWrapper] Player error:', errorMsg);
    
    // Try next source if available
    if (streamData && streamData.currentIndex < streamData.sources.length - 1) {
      handleSourceChange(streamData.currentIndex + 1);
    } else {
      setError(errorMsg);
    }
  }, [streamData, handleSourceChange]);

  // Loading state
  if (isLoading) {
    return <PlayerLoadingState message="Finding best source..." />;
  }

  // Error state
  if (error || !streamData) {
    return (
      <div style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#000',
        color: 'white',
        gap: '1rem',
        padding: '2rem',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: '3rem' }}>⚠️</div>
        <h3 style={{ margin: 0, fontSize: '1.25rem' }}>Playback Error</h3>
        <p style={{ margin: 0, color: 'rgba(255, 255, 255, 0.7)', maxWidth: '300px' }}>
          {error || 'Failed to load video'}
        </p>
        <button
          onClick={fetchSources}
          style={{
            padding: '0.75rem 2rem',
            background: '#e50914',
            border: 'none',
            borderRadius: '8px',
            color: 'white',
            fontSize: '1rem',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  // Render appropriate player
  if (useMobilePlayer) {
    return (
      <MobileVideoPlayer
        tmdbId={props.tmdbId}
        mediaType={props.mediaType}
        season={props.season}
        episode={props.episode}
        title={props.title}
        streamUrl={streamData.url}
        onBack={props.onBack}
        onError={handlePlayerError}
        onSourceChange={handleSourceChange}
        availableSources={streamData.sources}
        currentSourceIndex={streamData.currentIndex}
        nextEpisode={props.nextEpisode}
        onNextEpisode={props.onNextEpisode}
      />
    );
  }

  // Desktop player - pass all original props
  return (
    <DesktopVideoPlayer
      tmdbId={props.tmdbId}
      mediaType={props.mediaType}
      season={props.season}
      episode={props.episode}
      title={props.title}
      nextEpisode={props.nextEpisode}
      onNextEpisode={props.onNextEpisode}
      onBack={props.onBack}
      autoplay={props.autoplay}
      malId={props.malId}
      malTitle={props.malTitle}
    />
  );
}
