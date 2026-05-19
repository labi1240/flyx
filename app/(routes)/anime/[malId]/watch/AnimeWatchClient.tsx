'use client';

import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { useEffect, useState, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useIsMobile } from '@/hooks/useIsMobile';
import { getProviderSettings, saveProviderSettings } from '@/lib/sync';
import { getFlixerStreamProxyUrl, getAnimeKaiProxyUrl, getHiAnimeStreamProxyUrl } from '@/app/lib/proxy-config';
import { malService } from '@/lib/services/mal';
import type { MALAnime } from '@/lib/services/mal';
import { sourceMatchesAudioPreference, type AnimeAudioPreference } from '@/lib/utils/player-preferences';
import styles from '../../../watch/[id]/WatchPage.module.css';

// Proxy source URLs for mobile player — mirrors applyStreamProxy in VideoPlayer.tsx
function proxySourceUrl(sourceUrl: string, providerName: string, requiresProxy?: boolean): string {
  if (!sourceUrl) return sourceUrl;
  if (sourceUrl.includes('/flixer/stream') || sourceUrl.includes('/animekai') ||
      sourceUrl.includes('/hianime/') || sourceUrl.includes('/hianime?') ||
      sourceUrl.includes('/vidsrc/') || sourceUrl.includes('/api/stream-proxy') ||
      sourceUrl.includes('/stream/')) {
    return sourceUrl;
  }
  const needsProxy = requiresProxy ||
    sourceUrl.includes('.workers.dev') ||
    sourceUrl.includes('frostcomet') ||
    sourceUrl.includes('thunderleaf') ||
    sourceUrl.includes('skyember') ||
    sourceUrl.includes('nightbreeze') ||
    sourceUrl.includes('wind.');
  if (!needsProxy) return sourceUrl;

  if (providerName === 'flixer') return getFlixerStreamProxyUrl(sourceUrl);
  if (providerName === 'hianime') return getHiAnimeStreamProxyUrl(sourceUrl);
  if (providerName === 'animekai') return getAnimeKaiProxyUrl(sourceUrl);
  return sourceUrl;
}

// Desktop video player
const DesktopVideoPlayer = dynamic(
  () => import('@/components/player/VideoPlayer'),
  {
    ssr: false,
    loading: () => (
      <div className={styles.loading}>
        <div className={styles.spinner} />
        <p>Loading player...</p>
      </div>
    )
  }
);

// Mobile-optimized video player
const MobileVideoPlayer = dynamic(
  () => import('@/components/player/MobileVideoPlayer'),
  {
    ssr: false,
    loading: () => (
      <div className={styles.loading}>
        <div className={styles.spinner} />
        <p>Loading player...</p>
      </div>
    )
  }
);

interface NextEpisodeInfo {
  season: number;
  episode: number;
  title?: string;
  isLastEpisode?: boolean;
}

export default function AnimeWatchClient() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const mobileInfo = useIsMobile();
  
  const malId = parseInt(params.malId as string);
  // For movies, episode param is ignored
  const episodeParam = searchParams.get('episode');
  const shouldAutoplay = searchParams.get('autoplay') === 'true';
  
  const [anime, setAnime] = useState<MALAnime | null>(null);
  const [loading, setLoading] = useState(true);
  const [nextEpisode, setNextEpisode] = useState<NextEpisodeInfo | null>(null);
  
  // Determine if this is a movie based on anime type
  const isMovie = anime?.type === 'Movie';
  // For movies, episode is always 1 (or ignored); for series, use URL param or default to 1
  const episode = isMovie ? 1 : parseInt(episodeParam || '1');
  
  // Mobile player detection - lock once set
  const [useMobilePlayer, setUseMobilePlayer] = useState<boolean | null>(null);
  const hasSetMobilePlayerRef = useRef(false);
  
  useEffect(() => {
    if (!hasSetMobilePlayerRef.current && mobileInfo.screenWidth > 0) {
      const shouldUseMobile = mobileInfo.isMobile || mobileInfo.screenWidth < 768;
      setUseMobilePlayer(shouldUseMobile);
      hasSetMobilePlayerRef.current = true;
    }
  }, [mobileInfo.isMobile, mobileInfo.screenWidth]);

  // Mobile player state
  const [mobileStreamUrl, setMobileStreamUrl] = useState<string | null>(null);
  const [mobileSources, setMobileSources] = useState<Array<{ title: string; url: string; quality?: string; provider?: string; skipIntro?: [number, number]; skipOutro?: [number, number] }>>([]);
  const [mobileSourceIndex, setMobileSourceIndex] = useState(0);
  const [mobileLoading, setMobileLoading] = useState(true);
  const [mobileError, setMobileError] = useState<string | null>(null);
  const [mobileResumeTime, setMobileResumeTime] = useState(0);
  
  // Provider state
  const [currentProvider, setCurrentProvider] = useState<'animekai' | 'hianime' | 'miruro' | 'vidsrc' | '1movies' | 'flixer' | 'videasy' | 'uflix' | 'hexa' | 'primesrc' | undefined>(undefined);
  const [availableProviders, setAvailableProviders] = useState<Array<'animekai' | 'hianime' | 'miruro' | 'vidsrc' | '1movies' | 'flixer' | 'videasy' | 'uflix' | 'hexa' | 'primesrc'>>([]);
  const [loadingProvider, setLoadingProvider] = useState(false);
  
  // Audio preference for anime
  const [audioPref, setAudioPref] = useState<AnimeAudioPreference>(() => getProviderSettings().animeAudioPreference);

  // Load anime data
  useEffect(() => {
    async function loadAnime() {
      const data = await malService.getById(malId);
      setAnime(data);
      setLoading(false);
      
      // Calculate next episode - only for TV series, not movies
      if (data && data.episodes && data.type !== 'Movie') {
        const currentEp = parseInt(episodeParam || '1');
        if (currentEp < data.episodes) {
          setNextEpisode({
            season: 1,
            episode: currentEp + 1,
            title: `Episode ${currentEp + 1}`,
            isLastEpisode: false,
          });
        } else {
          setNextEpisode({
            season: 1,
            episode: currentEp,
            isLastEpisode: true,
          });
        }
      } else {
        // Movies don't have next episodes
        setNextEpisode(null);
      }
    }
    loadAnime();
  }, [malId, episodeParam]);

  // Use shared audio preference matching (consistent with desktop VideoPlayer)
  const sourceMatchesAudioPref = useCallback((sourceTitle: string, pref: AnimeAudioPreference): boolean => {
    return sourceMatchesAudioPreference(sourceTitle, pref);
  }, []);

  // Fetch stream for mobile player
  const fetchMobileStream = useCallback(async (audioPreference?: AnimeAudioPreference, provider?: 'hianime' | 'animekai') => {
    if (!malId) return;
    
    setMobileLoading(true);
    setMobileError(null);
    
    const currentAudioPref = audioPreference || audioPref;
    const useProvider = provider || 'hianime';
    
    const timeoutId = setTimeout(() => {
      setMobileError('Request timed out. Please try again.');
      setMobileLoading(false);
    }, 30000);
    
    try {
      // Use the dedicated anime stream API
      const params = new URLSearchParams({
        malId: malId.toString(),
        provider: useProvider,
      });
      
      // Only add episode for non-movies
      if (anime && anime.type !== 'Movie') {
        params.set('episode', episode.toString());
      }

      const response = await fetch(`/api/anime/stream?${params}`, { cache: 'no-store' });
      const data = await response.json();

      if (data.success && data.sources && data.sources.length > 0) {
        const validSources = data.sources.filter((s: any) => s.url && s.url.length > 0);
        
        if (validSources.length > 0) {
          const activeProvider = data.provider || useProvider;
          const sources = validSources.map((s: any) => ({
            title: s.title || s.quality || `${activeProvider} Source`,
            url: proxySourceUrl(s.url, activeProvider, s.requiresSegmentProxy),
            quality: s.quality,
            provider: activeProvider,
            skipIntro: s.skipIntro,
            skipOutro: s.skipOutro,
          }));
          
          setMobileSources(sources);
          setCurrentProvider(activeProvider);
          setAvailableProviders(['hianime', 'animekai']);
          
          // Find source matching audio preference
          let selectedIndex = 0;
          const matchingIndex = sources.findIndex((s: any) => 
            s.title && sourceMatchesAudioPref(s.title, currentAudioPref)
          );
          if (matchingIndex >= 0) {
            selectedIndex = matchingIndex;
          }
          
          setMobileStreamUrl(sources[selectedIndex].url);
          setMobileSourceIndex(selectedIndex);
          clearTimeout(timeoutId);
          setMobileLoading(false);
          return;
        }
      }

      clearTimeout(timeoutId);
      setMobileError(data.error || 'No streams available');
      setMobileLoading(false);
    } catch (e) {
      clearTimeout(timeoutId);
      setMobileError('Failed to load video');
      setMobileLoading(false);
    }
  }, [malId, episode, audioPref, sourceMatchesAudioPref, anime]);

  // Fetch mobile stream on mount
  const lastFetchedRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${malId}-${episode}`;
    if (useMobilePlayer && lastFetchedRef.current !== key) {
      lastFetchedRef.current = key;
      fetchMobileStream();
    }
  }, [useMobilePlayer, malId, episode, fetchMobileStream]);

  // Handle audio preference change
  const handleAudioPrefChange = useCallback((newPref: AnimeAudioPreference, currentTime: number = 0) => {
    setMobileResumeTime(currentTime);
    setAudioPref(newPref);
    saveProviderSettings({ animeAudioPreference: newPref });
    fetchMobileStream(newPref, currentProvider as 'hianime' | 'animekai' | undefined);
  }, [fetchMobileStream, currentProvider]);

  // Handle provider change - supports hianime and animekai
  const handleProviderChange = useCallback(async (_provider: 'animekai' | 'hianime' | 'miruro' | 'vidsrc' | '1movies' | 'flixer' | 'videasy' | 'uflix' | 'hexa' | 'primesrc' | 'moviebox', currentTime: number = 0) => {
    setMobileResumeTime(currentTime);
    setLoadingProvider(true);
    
    const provider = _provider as 'hianime' | 'animekai';
    
    const params = new URLSearchParams({
      malId: malId.toString(),
      provider,
    });
    
    // Only add episode for non-movies
    if (anime && anime.type !== 'Movie') {
      params.set('episode', episode.toString());
    }

    try {
      const response = await fetch(`/api/anime/stream?${params}`, { cache: 'no-store' });
      const data = await response.json();

      if (data.success && data.sources && data.sources.length > 0) {
        const validSources = data.sources.filter((s: any) => s.url && s.url.length > 0);
        
        if (validSources.length > 0) {
          const activeProvider = data.provider || provider;
          const sources = validSources.map((s: any) => ({
            title: s.title || s.quality || `${activeProvider} Source`,
            url: proxySourceUrl(s.url, activeProvider, s.requiresSegmentProxy),
            quality: s.quality,
            provider: activeProvider,
            skipIntro: s.skipIntro,
            skipOutro: s.skipOutro,
          }));
          
          setMobileSources(sources);
          setCurrentProvider(activeProvider);
          
          // Find source matching current audio preference
          let selectedIndex = 0;
          const matchingIndex = sources.findIndex((s: any) => 
            s.title && sourceMatchesAudioPref(s.title, audioPref)
          );
          if (matchingIndex >= 0) {
            selectedIndex = matchingIndex;
          }
          
          setMobileStreamUrl(sources[selectedIndex].url);
          setMobileSourceIndex(selectedIndex);
        }
      }
    } catch (e) {
      console.error(`[AnimeWatch] Provider change failed:`, e);
    } finally {
      setLoadingProvider(false);
    }
  }, [malId, episode, anime, audioPref, sourceMatchesAudioPref]);

  // Handle source change
  const handleMobileSourceChange = useCallback((index: number, currentTime: number = 0) => {
    if (index >= 0 && index < mobileSources.length) {
      setMobileResumeTime(currentTime);
      setMobileSourceIndex(index);
      setMobileStreamUrl(mobileSources[index].url);
    }
  }, [mobileSources]);

  const handleBack = () => {
    router.push(`/anime/${malId}`);
  };

  const handleNextEpisode = useCallback(() => {
    if (!nextEpisode || nextEpisode.isLastEpisode || !anime) return;
    
    const navigateToNext = () => {
      router.push(`/anime/${malId}/watch?episode=${nextEpisode.episode}&autoplay=true`);
    };

    if (document.fullscreenElement) {
      document.exitFullscreen().then(navigateToNext).catch(navigateToNext);
    } else {
      navigateToNext();
    }
  }, [malId, nextEpisode, anime, router]);

  // Wait for mobile detection
  if (useMobilePlayer === null) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>
          <div className={styles.spinner} />
          <p>Loading player...</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>
          <div className={styles.spinner} />
          <p>Loading anime...</p>
        </div>
      </div>
    );
  }

  if (!anime) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>
          <h2>Anime Not Found</h2>
          <p>Could not find anime with MAL ID: {malId}</p>
          <button onClick={() => router.push('/anime')} className={styles.backButton}>
            Back to Anime
          </button>
        </div>
      </div>
    );
  }

  const title = anime.title_english || anime.title;
  const nextEpisodeProp = nextEpisode && !nextEpisode.isLastEpisode ? {
    season: 1,
    episode: nextEpisode.episode,
    title: nextEpisode.title,
  } : null;

  // Mobile player
  if (useMobilePlayer) {
    if (mobileLoading) {
      return (
        <div className={styles.container}>
          <div className={styles.playerWrapper}>
            <div className={styles.loading}>
              <div className={styles.spinner} />
              <p>Finding best source...</p>
            </div>
          </div>
        </div>
      );
    }

    if (mobileError || !mobileStreamUrl) {
      return (
        <div className={styles.container}>
          <div className={styles.playerWrapper}>
            <div className={styles.error}>
              <h2>Playback Error</h2>
              <p>{mobileError || 'Failed to load video'}</p>
              <button onClick={() => fetchMobileStream()} className={styles.backButton}>
                Try Again
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className={styles.container}>
        <MobileVideoPlayer
          tmdbId="0"
          mediaType={isMovie ? 'movie' : 'tv'}
          season={isMovie ? undefined : 1}
          episode={isMovie ? undefined : episode}
          title={title}
          streamUrl={mobileStreamUrl}
          availableSources={mobileSources}
          currentSourceIndex={mobileSourceIndex}
          onSourceChange={handleMobileSourceChange}
          onBack={handleBack}
          nextEpisode={nextEpisodeProp}
          onNextEpisode={handleNextEpisode}
          initialTime={mobileResumeTime}
          onError={(err) => setMobileError(err)}
          isAnime={true}
          audioPref={audioPref}
          onAudioPrefChange={handleAudioPrefChange}
          availableProviders={availableProviders}
          currentProvider={currentProvider}
          onProviderChange={handleProviderChange}
          loadingProvider={loadingProvider}
        />
      </div>
    );
  }

  // Desktop player - use the same VideoPlayer as regular watch page
  // IMPORTANT: Pass malId as tmdbId="0" (placeholder) since we're using MAL ID directly
  // The VideoPlayer will use malId for the actual extraction
  return (
    <div className={styles.container}>
      <DesktopVideoPlayer
        tmdbId="0"
        mediaType={isMovie ? 'movie' : 'tv'}
        season={isMovie ? undefined : 1}
        episode={isMovie ? undefined : episode}
        title={title}
        onBack={handleBack}
        nextEpisode={nextEpisodeProp}
        onNextEpisode={handleNextEpisode}
        autoplay={shouldAutoplay}
        malId={malId}
        malTitle={title}
      />
    </div>
  );
}
