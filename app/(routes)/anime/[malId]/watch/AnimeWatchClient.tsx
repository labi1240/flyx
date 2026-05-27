'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useIsMobile } from '@/hooks/useIsMobile';
import { getProviderSettings, saveProviderSettings } from '@/lib/sync';
import { sourceMatchesAudioPreference, type AnimeAudioPreference } from '@/lib/utils/player-preferences';
import styles from '../../../watch/[id]/WatchPage.module.css';

const DesktopVideoPlayer = dynamic(
  () => import('@/components/player/VideoPlayer'),
  { ssr: false, loading: () => (
    <div className={styles.loading}>
      <div className={styles.spinner} />
      <p>Loading player...</p>
    </div>
  )}
);

const MobileVideoPlayer = dynamic(
  () => import('@/components/player/MobileVideoPlayer'),
  { ssr: false, loading: () => (
    <div className={styles.loading}>
      <div className={styles.spinner} />
      <p>Loading player...</p>
    </div>
  )}
);

interface AnimeData {
  mal_id: number;
  title: string;
  title_english: string | null;
  type: string;
  episodes: number | null;
  synopsis: string | null;
  image: string;
}

export default function AnimeWatchClient({ malId, episode: initialEpisode }: { malId: number; episode: number }) {
  const router = useRouter();
  const mobileInfo = useIsMobile();

  const [anime, setAnime] = useState<AnimeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [animeError, setAnimeError] = useState(false);

  // Mobile detection — lock once
  const [useMobilePlayer, setUseMobilePlayer] = useState<boolean | null>(null);
  const mobileLockedRef = useRef(false);

  useEffect(() => {
    if (!mobileLockedRef.current && mobileInfo.screenWidth > 0) {
      setUseMobilePlayer(mobileInfo.isMobile || mobileInfo.screenWidth < 768);
      mobileLockedRef.current = true;
    }
  }, [mobileInfo.isMobile, mobileInfo.screenWidth]);

  // Stream state
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [streamSources, setStreamSources] = useState<Array<{ title: string; url: string; quality?: string; provider?: string; requiresSegmentProxy?: boolean; skipIntro?: [number, number]; skipOutro?: [number, number] }>>([]);
  const [streamSourceIndex, setStreamSourceIndex] = useState(0);
  const [streamLoading, setStreamLoading] = useState(true);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamResumeTime, setStreamResumeTime] = useState(0);
  const [currentProvider, setCurrentProvider] = useState<string>('miruro');
  const [availableProviders, setAvailableProviders] = useState<string[]>([]);
  const [audioPref, setAudioPref] = useState<AnimeAudioPreference>(() => getProviderSettings().animeAudioPreference);

  // Load anime data from AniList
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/anilist/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: `query($malId:Int){Media(idMal:$malId,type:ANIME){idMal title{romaji english} format episodes description(asHtml:false) coverImage{extraLarge}}}`,
            variables: { malId },
          }),
        });
        if (cancelled) return;
        const json = await res.json();
        const m = json?.data?.Media;
        if (m?.idMal) {
          setAnime({
            mal_id: m.idMal,
            title: m.title?.romaji || m.title?.english || 'Unknown',
            title_english: m.title?.english || null,
            type: m.format || 'TV',
            episodes: m.episodes || null,
            synopsis: m.description || null,
            image: m.coverImage?.extraLarge || '',
          });
        } else {
          setAnimeError(true);
        }
      } catch {
        if (!cancelled) setAnimeError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [malId]);

  const isMovie = anime?.type === 'Movie';
  const episode = isMovie ? 1 : initialEpisode;

  // Fetch stream sources
  const lastFetchedRef = useRef<string | null>(null);
  useEffect(() => {
    if (useMobilePlayer === null || !anime) return;
    const key = `${malId}-${episode}`;
    if (lastFetchedRef.current === key) return;
    lastFetchedRef.current = key;

    let cancelled = false;
    (async () => {
      setStreamLoading(true);
      setStreamError(null);
      const animeTitle = anime.title_english || anime.title;
      const targetEp = isMovie ? undefined : episode;

      const providerOrder = ['miruro', 'animekai'];
      let sources: typeof streamSources = [];
      let activeProvider = 'miruro';

      for (const prov of providerOrder) {
        if (cancelled) return;
        try {
          if (prov === 'miruro') {
            const { extractMiruroClient } = await import('@/app/lib/services/miruro-client-extractor');
            const results = await extractMiruroClient(malId, animeTitle, targetEp, audioPref);
            if (results.length > 0) {
              const cfBase = (process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL || 'https://media-proxy.vynx-3b3.workers.dev/stream').replace(/\/stream\/?$/, '');
              sources = results.map((s: any) => ({
                title: s.title || 'Miruro',
                url: s.url?.includes('/miruro/') ? s.url : `${cfBase}/miruro/stream?url=${encodeURIComponent(s.url)}`,
                quality: s.quality,
                provider: 'miruro',
              }));
              activeProvider = 'miruro';
              break;
            }
          } else if (prov === 'animekai') {
            const { extractAnimeKaiClient } = await import('@/app/lib/services/animekai-client-extractor');
            const results = await extractAnimeKaiClient(malId, animeTitle, targetEp, audioPref);
            if (results.length > 0) {
              sources = results.map((s: any) => ({
                title: s.title || 'AnimeKai',
                url: s.url,
                quality: s.quality,
                provider: 'animekai',
                requiresSegmentProxy: s.requiresSegmentProxy,
                skipIntro: s.skipIntro,
                skipOutro: s.skipOutro,
              }));
              activeProvider = 'animekai';
              break;
            }
          }
        } catch (e) {
          console.warn(`[AnimeWatch] ${prov} failed:`, e);
        }
      }

      if (cancelled) return;

      if (sources.length > 0) {
        // Pick best source matching audio preference
        let idx = 0;
        const matchIdx = sources.findIndex(s =>
          s.title && sourceMatchesAudioPreference(s.title, audioPref)
        );
        if (matchIdx >= 0) idx = matchIdx;

        setStreamSources(sources);
        setStreamSourceIndex(idx);
        setStreamUrl(sources[idx].url);
        setCurrentProvider(activeProvider);
        setAvailableProviders(providerOrder.filter(p => sources.some(s => s.provider === p)));
      } else {
        setStreamError('No streams available');
      }
      setStreamLoading(false);
    })();
    return () => { cancelled = true; };
  }, [useMobilePlayer, malId, episode, audioPref, anime, isMovie]);

  // Document title
  const title = anime ? (anime.title_english || anime.title) : '';
  useEffect(() => {
    if (!title) return;
    document.title = `${isMovie ? '' : `E${episode} - `}${title} | Flyx`;
  }, [title, episode, isMovie]);

  // Handlers
  const handleAudioPrefChange = useCallback((newPref: AnimeAudioPreference, currentTime: number = 0) => {
    setStreamResumeTime(currentTime);
    setAudioPref(newPref);
    saveProviderSettings({ animeAudioPreference: newPref });
    lastFetchedRef.current = ''; // force refetch
  }, []);

  const handleProviderChange = useCallback((_provider: string, currentTime: number = 0) => {
    setStreamResumeTime(currentTime);
    lastFetchedRef.current = '';
  }, []);

  const handleSourceChange = useCallback((index: number, currentTime: number = 0) => {
    if (index >= 0 && index < streamSources.length) {
      setStreamResumeTime(currentTime);
      setStreamSourceIndex(index);
      setStreamUrl(streamSources[index].url);
    }
  }, [streamSources]);

  // Loading state — wait for mobile detection
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

  // Anime data loading
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

  // Anime not found
  if (animeError || !anime) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>
          <h2>Anime Not Found</h2>
          <button onClick={() => router.push('/anime')} className={styles.backButton}>Back to Anime</button>
        </div>
      </div>
    );
  }

  // Stream loading
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

  // Stream error
  if (streamError || !streamUrl) {
    return (
      <div className={styles.container}>
        <div className={styles.playerWrapper}>
          <div className={styles.error}>
            <h2>Playback Error</h2>
            <p>{streamError || 'Failed to load video'}</p>
            <button onClick={() => { lastFetchedRef.current = ''; setStreamLoading(true); }} className={styles.backButton}>
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
          onBack={() => router.push(`/anime/${malId}`)}
          initialTime={streamResumeTime}
          onError={(err) => setStreamError(err)}
          isAnime={true}
          audioPref={audioPref}
          onAudioPrefChange={handleAudioPrefChange}
          availableProviders={availableProviders as any}
          currentProvider={currentProvider as any}
          onProviderChange={handleProviderChange}
          loadingProvider={false}
          skipIntro={streamSources[streamSourceIndex]?.skipIntro ?? null}
          skipOutro={streamSources[streamSourceIndex]?.skipOutro ?? null}
        />
      </div>
    );
  }

  // Desktop player
  return (
    <div className={styles.container}>
      <DesktopVideoPlayer
        tmdbId="0"
        mediaType={isMovie ? 'movie' : 'tv'}
        season={isMovie ? undefined : 1}
        episode={isMovie ? undefined : episode}
        title={title}
        onBack={() => router.push(`/anime/${malId}`)}
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
