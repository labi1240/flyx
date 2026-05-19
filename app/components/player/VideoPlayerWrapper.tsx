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
        primesrc: providersData.providers?.primesrc?.enabled ?? true,
        flixer: providersData.providers?.flixer?.enabled ?? true,
        videasy: providersData.providers?.videasy?.enabled ?? true,
        uflix: providersData.providers?.uflix?.enabled ?? true,
        hexa: providersData.providers?.hexa?.enabled ?? true,
        vidsrc: providersData.providers?.vidsrc?.enabled ?? true,
        '1movies': providersData.providers?.['1movies']?.enabled ?? true,
        animekai: providersData.providers?.animekai?.enabled ?? true,
        hianime: providersData.providers?.hianime?.enabled ?? true,
        miruro: providersData.providers?.miruro?.enabled ?? true,
        moviebox: providersData.providers?.moviebox?.enabled ?? true,
      };

      // Check if anime content
      let isAnime = false;
      try {
        const animeRes = await fetch(`/api/content/check-anime?tmdbId=${tmdbId}&type=${mediaType}`);
        if (animeRes.ok) {
          const animeData = await animeRes.json();
          isAnime = animeData.isAnime === true;
        }
      } catch (e) {
        console.warn('[VideoPlayerWrapper] Anime check failed:', e);
      }

      // Build provider order respecting user's preferred order from settings
      const userSettings = getProviderSettings();
      const userOrder = userSettings.providerOrder || [];
      const disabledProviders = new Set(userSettings.disabledProviders || []);
      const animeOnlyProviders = ['animekai', 'hianime', 'miruro'];

      const providerOrder: string[] = [];

      // For anime: always put anime providers first
      if (isAnime && availability.animekai && !disabledProviders.has('animekai')) {
        providerOrder.push('animekai');
      }
      if (isAnime && availability.hianime && !disabledProviders.has('hianime')) {
        providerOrder.push('hianime');
      }
      if (isAnime && availability.miruro && !disabledProviders.has('miruro')) {
        providerOrder.push('miruro');
      }

      // Add providers from user's preferred order
      for (const p of userOrder) {
        if (providerOrder.includes(p)) continue;
        if (disabledProviders.has(p)) continue;
        if (!isAnime && animeOnlyProviders.includes(p)) continue;
        if (p !== 'uflix' && !availability[p as keyof typeof availability]) continue;
        providerOrder.push(p);
      }

      // Add any remaining available providers as fallback
      const allProviders = isAnime
        ? ['hianime', 'animekai', 'miruro', 'videasy', 'primesrc', 'flixer', 'uflix', 'hexa', 'vidsrc', '1movies', 'moviebox']
        : ['videasy', 'primesrc', 'flixer', 'uflix', 'hexa', 'vidsrc', '1movies', 'moviebox'];
      for (const p of allProviders) {
        if (providerOrder.includes(p)) continue;
        if (disabledProviders.has(p)) continue;
        if (!availability[p as keyof typeof availability] && p !== 'uflix') continue;
        providerOrder.push(p);
      }

      // Try each provider
      for (const provider of providerOrder) {
        try {
          // FLIXER: Use browser-direct extraction via CF Worker (same as VideoPlayer.tsx)
          // The server-side /api/stream/extract route can't call hexa.su directly
          // because hexa.su blocks datacenter IPs. The CF Worker /flixer/extract-all
          // handles everything server-side (WASM keygen, API call, decrypt).
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

          // ANIME PROVIDERS: Use dedicated /api/anime/stream when malId is available
          if (malId && (provider === 'animekai' || provider === 'hianime' || provider === 'miruro')) {
            const animeParams = new URLSearchParams({
              malId: malId.toString(),
              provider,
            });
            if (mediaType === 'tv' && episode) {
              animeParams.append('episode', episode.toString());
            }
            
            const response = await fetch(`/api/anime/stream?${animeParams}`, {
              cache: 'no-store',
            });
            const data = await response.json();

            if (data.success && data.sources && data.sources.length > 0) {
              const sources = data.sources;
              const actualProvider = data.provider || provider;
              
              let sourceUrl = sources[0].url;
              
              if (sources[0].requiresSegmentProxy) {
                const isAlreadyProxied = sourceUrl.includes('/api/stream-proxy') || 
                  sourceUrl.includes('/stream/') ||
                  sourceUrl.includes('/animekai') ||
                  sourceUrl.includes('/hianime') ||
                  sourceUrl.includes('/flixer/stream');
                
                if (!isAlreadyProxied) {
                  const targetUrl = sources[0].directUrl || sourceUrl;
                  if (actualProvider === 'hianime') {
                    sourceUrl = getHiAnimeStreamProxyUrl(targetUrl);
                  } else if (actualProvider === 'animekai') {
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
        sourceUrl.includes('/animekai') ||
        sourceUrl.includes('/flixer/stream');
      
      if (!isAlreadyProxied) {
        if (streamData.provider === 'flixer') {
          sourceUrl = getFlixerStreamProxyUrl(sourceUrl);
        } else if (streamData.provider === 'hianime') {
          sourceUrl = getHiAnimeStreamProxyUrl(sourceUrl);
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
