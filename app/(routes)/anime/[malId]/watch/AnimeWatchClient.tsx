'use client';

import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { useEffect, useState, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useIsMobile } from '@/hooks/useIsMobile';
import { getProviderSettings, saveProviderSettings } from '@/lib/sync';
import { malService } from '@/lib/services/mal';
import type { MALAnime } from '@/lib/services/mal';
import { sourceMatchesAudioPreference, type AnimeAudioPreference } from '@/lib/utils/player-preferences';
import styles from '../../../watch/[id]/WatchPage.module.css';

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

  // Shared stream state (used by both desktop and mobile paths)
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [streamSources, setStreamSources] = useState<Array<{ title: string; url: string; quality?: string; provider?: string; requiresSegmentProxy?: boolean; skipIntro?: [number, number]; skipOutro?: [number, number] }>>([]);
  const [streamSourceIndex, setStreamSourceIndex] = useState(0);
  const [streamLoading, setStreamLoading] = useState(true);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamResumeTime, setStreamResumeTime] = useState(0);

  // Provider state
  const [currentProvider, setCurrentProvider] = useState<string>('hianime');
  const [availableProviders, setAvailableProviders] = useState<Array<string>>([]);

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

  // Fetch stream — shared by both desktop and mobile paths
  const fetchStream = useCallback(async (audioPreference?: AnimeAudioPreference, provider?: string) => {
    if (!malId || !anime) return;

    setStreamLoading(true);
    setStreamError(null);

    const currentAudioPref = audioPreference || audioPref;
    const useProvider = provider || 'hianime';
    const animeTitle = anime.title_english || anime.title;
    const targetEp = anime.type === 'Movie' ? undefined : episode;

    // Build fallback order: try requested provider first, then the other anime providers
    const allAnimeProviders: Array<string> = useProvider === 'miruro'
      ? ['miruro', 'hianime', 'animekai']
      : useProvider === 'animekai'
      ? ['animekai', 'hianime', 'miruro']
      : ['hianime', 'miruro', 'animekai'];

    let sources: Array<{ title: string; url: string; quality?: string; provider: string; requiresSegmentProxy?: boolean; skipIntro?: [number, number]; skipOutro?: [number, number] }> = [];
    let activeProvider: string = useProvider;

    try {
      for (const fbProvider of allAnimeProviders) {
        try {
          if (fbProvider === 'hianime') {
            const { extractHiAnimeClient } = await import('@/app/lib/services/hianime-client-extractor');
            const hiSources = await extractHiAnimeClient(malId, animeTitle, targetEp);
            if (hiSources.length > 0) {
              sources = hiSources.map((s: any) => ({
                title: s.title || 'HiAnime Source',
                url: s.url,
                quality: s.quality,
                provider: 'hianime',
                requiresSegmentProxy: s.requiresSegmentProxy,
                skipIntro: s.skipIntro,
                skipOutro: s.skipOutro,
              }));
              activeProvider = 'hianime';
              break;
            }
          } else if (fbProvider === 'miruro') {
            const { extractMiruroClient } = await import('@/app/lib/services/miruro-client-extractor');
            const miSources = await extractMiruroClient(malId, animeTitle, targetEp, currentAudioPref);
            if (miSources.length > 0) {
              sources = miSources.map((s: any) => ({
                title: s.title || 'Miruro Source',
                url: s.url,
                quality: s.quality,
                provider: 'miruro',
                requiresSegmentProxy: s.requiresSegmentProxy,
              }));
              activeProvider = 'miruro';
              break;
            }
          } else if (fbProvider === 'animekai') {
            const akRes = await fetch(`/api/stream/extract?tmdbId=0&type=${anime.type === 'Movie' ? 'movie' : 'tv'}&provider=animekai&malId=${malId}&malTitle=${encodeURIComponent(animeTitle)}${targetEp ? `&season=1&episode=${targetEp}` : ''}`);
            if (akRes.ok) {
              const akData = await akRes.json();
              if (akData.success && akData.sources?.length > 0) {
                sources = akData.sources.map((s: any) => ({
                  title: s.title || 'AnimeKai Source',
                  url: s.url,
                  quality: s.quality,
                  provider: 'animekai',
                  requiresSegmentProxy: s.requiresSegmentProxy,
                }));
                activeProvider = 'animekai';
                break;
              }
            }
          }
        } catch (e) {
          console.warn(`[AnimeWatch] ${fbProvider} failed:`, e);
        }
      }

      if (sources.length > 0) {
        setStreamSources(sources);
        setCurrentProvider(activeProvider);
        setAvailableProviders(allAnimeProviders.filter(p => sources.some((s: any) => s.provider === p) || p === activeProvider));

        let selectedIndex = 0;
        const matchingIndex = sources.findIndex((s: any) =>
          s.title && sourceMatchesAudioPref(s.title, currentAudioPref)
        );
        if (matchingIndex >= 0) selectedIndex = matchingIndex;

        setStreamUrl(sources[selectedIndex].url);
        setStreamSourceIndex(selectedIndex);
        setStreamLoading(false);
        return;
      }

      setStreamError('No streams available from any anime provider');
      setStreamLoading(false);
    } catch (e) {
      setStreamError('Failed to load video');
      setStreamLoading(false);
    }
  }, [malId, episode, audioPref, sourceMatchesAudioPref, anime]);

  // Fetch stream on mount (both desktop and mobile)
  const lastFetchedRef = useRef<string | null>(null);
  useEffect(() => {
    if (useMobilePlayer === null || !anime) return;
    const key = `${malId}-${episode}`;
    if (lastFetchedRef.current !== key) {
      lastFetchedRef.current = key;
      fetchStream();
    }
  }, [useMobilePlayer, malId, episode, fetchStream, anime]);

  // Handle audio preference change
  const handleAudioPrefChange = useCallback((newPref: AnimeAudioPreference, currentTime: number = 0) => {
    setStreamResumeTime(currentTime);
    setAudioPref(newPref);
    saveProviderSettings({ animeAudioPreference: newPref });
    fetchStream(newPref, currentProvider);
  }, [fetchStream, currentProvider]);

  // Handle provider change
  const handleProviderChange = useCallback(async (_provider: string, currentTime: number = 0) => {
    setStreamResumeTime(currentTime);
    fetchStream(audioPref, _provider);
  }, [fetchStream, audioPref]);

  // Handle source change
  const handleSourceChange = useCallback((index: number, currentTime: number = 0) => {
    if (index >= 0 && index < streamSources.length) {
      setStreamResumeTime(currentTime);
      setStreamSourceIndex(index);
      setStreamUrl(streamSources[index].url);
    }
  }, [streamSources]);

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

  // Loading state (shared)
  if (streamLoading) {
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

  // Error state (shared)
  if (streamError || !streamUrl) {
    return (
      <div className={styles.container}>
        <div className={styles.playerWrapper}>
          <div className={styles.error}>
            <h2>Playback Error</h2>
            <p>{streamError || 'Failed to load video'}</p>
            <button onClick={() => fetchStream()} className={styles.backButton}>
              Try Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Mobile player
  if (useMobilePlayer) {
    return (
      <div className={styles.container}>
        <MobileVideoPlayer
          tmdbId="0"
          mediaType={isMovie ? 'movie' : 'tv'}
          season={isMovie ? undefined : 1}
          episode={isMovie ? undefined : episode}
          title={title}
          streamUrl={streamUrl}
          availableSources={streamSources}
          currentSourceIndex={streamSourceIndex}
          onSourceChange={handleSourceChange}
          onBack={handleBack}
          nextEpisode={nextEpisodeProp}
          onNextEpisode={handleNextEpisode}
          initialTime={streamResumeTime}
          onError={(err) => setStreamError(err)}
          isAnime={true}
          audioPref={audioPref}
          onAudioPrefChange={handleAudioPrefChange}
          availableProviders={availableProviders as any}
          currentProvider={currentProvider as any}
          onProviderChange={handleProviderChange}
          loadingProvider={false}
          skipIntro={streamSources[streamSourceIndex]?.skipIntro}
          skipOutro={streamSources[streamSourceIndex]?.skipOutro}
        />
      </div>
    );
  }

  // Desktop player — pass pre-extracted stream via externalStreamUrl to bypass
  // VideoPlayer's internal provider extraction (which would try movie/TV providers).
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
        externalStreamUrl={streamUrl}
        externalStreamSources={streamSources}
        externalStreamProvider={currentProvider}
        externalStreamSourceIndex={streamSourceIndex}
      />
    </div>
  );
}
