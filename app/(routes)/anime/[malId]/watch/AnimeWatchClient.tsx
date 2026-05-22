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

  // Mobile player state
  const [mobileStreamUrl, setMobileStreamUrl] = useState<string | null>(null);
  const [mobileSources, setMobileSources] = useState<Array<{ title: string; url: string; quality?: string; provider?: string; skipIntro?: [number, number]; skipOutro?: [number, number] }>>([]);
  const [mobileSourceIndex, setMobileSourceIndex] = useState(0);
  const [mobileLoading, setMobileLoading] = useState(true);
  const [mobileError, setMobileError] = useState<string | null>(null);
  const [mobileResumeTime, setMobileResumeTime] = useState(0);
  
  // Provider state
  const [currentProvider, setCurrentProvider] = useState<'hianime' | 'miruro' | 'videasy' | 'bingebox' | 'vidsrc' | 'uflix' | 'hexa' | 'primesrc' | 'moviebox' | 'multi-embed' | undefined>(undefined);
  const [availableProviders, setAvailableProviders] = useState<Array<'hianime' | 'miruro' | 'videasy' | 'bingebox' | 'vidsrc' | 'uflix' | 'hexa' | 'primesrc' | 'moviebox' | 'multi-embed'>>([]);
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
  const fetchMobileStream = useCallback(async (audioPreference?: AnimeAudioPreference, provider?: string) => {
    if (!malId || !anime) return;

    setMobileLoading(true);
    setMobileError(null);

    const currentAudioPref = audioPreference || audioPref;
    const useProvider = provider || 'hianime';
    const animeTitle = anime.title_english || anime.title;
    const targetEp = anime.type === 'Movie' ? undefined : episode;

    // Build fallback order: try requested provider first, then the other anime provider
    const fallbackProviders: Array<'hianime' | 'miruro'> = useProvider === 'miruro'
      ? ['miruro', 'hianime']
      : ['hianime', 'miruro'];

    let sources: Array<{ title: string; url: string; quality?: string; provider: string; skipIntro?: [number, number]; skipOutro?: [number, number] }> = [];
    let activeProvider: string = useProvider;

    try {
      for (const fbProvider of fallbackProviders) {
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
              }));
              activeProvider = 'miruro';
              break;
            }
          }
        } catch (e) {
          console.warn(`[AnimeWatch] ${fbProvider} failed:`, e);
        }
      }

      if (sources.length > 0) {
        setMobileSources(sources);
        setCurrentProvider(activeProvider as any);
        setAvailableProviders(['hianime', 'miruro']);

        let selectedIndex = 0;
        const matchingIndex = sources.findIndex((s: any) =>
          s.title && sourceMatchesAudioPref(s.title, currentAudioPref)
        );
        if (matchingIndex >= 0) selectedIndex = matchingIndex;

        setMobileStreamUrl(sources[selectedIndex].url);
        setMobileSourceIndex(selectedIndex);
        setMobileLoading(false);
        return;
      }

      setMobileError('No streams available from any anime provider');
      setMobileLoading(false);
    } catch (e) {
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
    fetchMobileStream(newPref, currentProvider);
  }, [fetchMobileStream, currentProvider]);

  // Handle provider change - supports hianime and animekai
  const handleProviderChange = useCallback(async (_provider: string, currentTime: number = 0) => {
    if (!malId || !anime) return;
    setMobileResumeTime(currentTime);
    setLoadingProvider(true);

    const animeTitle = anime.title_english || anime.title;
    const targetEp = anime.type === 'Movie' ? undefined : episode;

    // Build fallback order: try requested provider first, then the other anime provider
    const fallbackProviders: Array<'hianime' | 'miruro'> = _provider === 'miruro'
      ? ['miruro', 'hianime']
      : ['hianime', 'miruro'];

    let sources: Array<{ title: string; url: string; quality?: string; provider: string; skipIntro?: [number, number]; skipOutro?: [number, number] }> = [];
    let activeProvider: string = _provider;

    try {
      for (const fbProvider of fallbackProviders) {
        try {
          if (fbProvider === 'hianime') {
            const { extractHiAnimeClient } = await import('@/app/lib/services/hianime-client-extractor');
            const hiSources = await extractHiAnimeClient(malId, animeTitle, targetEp);
            if (hiSources.length > 0) {
              sources = hiSources.map((s: any) => ({ title: s.title || 'HiAnime Source', url: s.url, quality: s.quality, provider: 'hianime', skipIntro: s.skipIntro, skipOutro: s.skipOutro }));
              activeProvider = 'hianime';
              break;
            }
          } else if (fbProvider === 'miruro') {
            const { extractMiruroClient } = await import('@/app/lib/services/miruro-client-extractor');
            const miSources = await extractMiruroClient(malId, animeTitle, targetEp, audioPref);
            if (miSources.length > 0) {
              sources = miSources.map((s: any) => ({ title: s.title || 'Miruro Source', url: s.url, quality: s.quality, provider: 'miruro' }));
              activeProvider = 'miruro';
              break;
            }
          }
        } catch (e) {
          console.warn(`[AnimeWatch] Provider change ${fbProvider} failed:`, e);
        }
      }

      if (sources.length > 0) {
        setMobileSources(sources);
        setCurrentProvider(activeProvider as any);
        const matchingIndex = sources.findIndex((s: any) => s.title && sourceMatchesAudioPref(s.title, audioPref));
        const selectedIndex = matchingIndex >= 0 ? matchingIndex : 0;
        setMobileStreamUrl(sources[selectedIndex].url);
        setMobileSourceIndex(selectedIndex);
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
          skipIntro={mobileSources[mobileSourceIndex]?.skipIntro}
          skipOutro={mobileSources[mobileSourceIndex]?.skipOutro}
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
