'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useIsMobile } from '@/hooks/useIsMobile';
import { getProviderSettings, saveProviderSettings } from '@/lib/sync';
import { sourceMatchesAudioPreference, type AnimeAudioPreference } from '@/lib/utils/player-preferences';
import { jikanFull, type JikanAnime } from '@/lib/anime/jikan-client';
import styles from '../../../watch/[id]/WatchPage.module.css';

const DesktopVideoPlayer = dynamic(
  () => import('@/components/player/VideoPlayer'),
  {
    ssr: false,
    loading: () => (
      <div className={styles.loading}>
        <div className={styles.spinner} />
        <p>Loading player...</p>
      </div>
    ),
  },
);

const MobileVideoPlayer = dynamic(
  () => import('@/components/player/MobileVideoPlayer'),
  {
    ssr: false,
    loading: () => (
      <div className={styles.loading}>
        <div className={styles.spinner} />
        <p>Loading player...</p>
      </div>
    ),
  },
);

interface StreamSource {
  title: string;
  url: string;
  quality?: string;
  provider?: string;
  requiresSegmentProxy?: boolean;
  skipIntro?: [number, number];
  skipOutro?: [number, number];
}

const PROVIDER_ORDER = ['miruro', 'animekai'] as const;

export default function AnimeWatchClient({ malId, episode: initialEpisode }: { malId: number; episode: number }) {
  const router = useRouter();
  const mobileInfo = useIsMobile();

  // ─── Anime metadata ──────────────────────────────────────────────────────
  const [anime, setAnime] = useState<JikanAnime | null>(null);
  const [loading, setLoading] = useState(true);
  const [animeError, setAnimeError] = useState(false);

  // ─── Current episode (mutable so prev/next does NOT navigate the route) ──
  const [currentEpisode, setCurrentEpisode] = useState(initialEpisode);
  useEffect(() => { setCurrentEpisode(initialEpisode); }, [initialEpisode]);

  // ─── Mobile detection lock ───────────────────────────────────────────────
  const [useMobilePlayer, setUseMobilePlayer] = useState<boolean | null>(null);
  const mobileLockedRef = useRef(false);
  useEffect(() => {
    if (!mobileLockedRef.current && mobileInfo.screenWidth > 0) {
      setUseMobilePlayer(mobileInfo.isMobile || mobileInfo.screenWidth < 768);
      mobileLockedRef.current = true;
    }
  }, [mobileInfo.isMobile, mobileInfo.screenWidth]);

  // ─── Stream state ────────────────────────────────────────────────────────
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [streamSources, setStreamSources] = useState<StreamSource[]>([]);
  const [streamSourceIndex, setStreamSourceIndex] = useState(0);
  const [streamLoading, setStreamLoading] = useState(true);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamResumeTime, setStreamResumeTime] = useState(0);
  const [currentProvider, setCurrentProvider] = useState<string>('miruro');
  const [availableProviders, setAvailableProviders] = useState<string[]>([]);
  const [audioPref, setAudioPref] = useState<AnimeAudioPreference>(
    () => getProviderSettings().animeAudioPreference,
  );
  const [retryNonce, setRetryNonce] = useState(0);

  // ─── Load anime data ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!malId) return;
    let cancelled = false;
    (async () => {
      const data = await jikanFull(malId);
      if (cancelled) return;
      if (!data) { setAnimeError(true); setLoading(false); return; }
      setAnime(data);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [malId]);

  const isMovie = anime?.type === 'Movie';
  const playEpisode = isMovie ? 1 : currentEpisode;
  const totalEpisodes = anime?.episodes ?? null;
  const title = anime ? (anime.title_english || anime.title) : '';

  // ─── Fetch stream ────────────────────────────────────────────────────────
  const lastFetchedRef = useRef<string | null>(null);
  useEffect(() => {
    if (useMobilePlayer === null || !anime) return;
    const key = `${malId}-${playEpisode}-${audioPref}-${retryNonce}`;
    if (lastFetchedRef.current === key) return;
    lastFetchedRef.current = key;

    let cancelled = false;
    (async () => {
      setStreamLoading(true);
      setStreamError(null);
      const animeTitle = anime.title_english || anime.title;
      const targetEp = isMovie ? undefined : playEpisode;

      let sources: StreamSource[] = [];
      let activeProvider: string = 'miruro';
      const providerSuccess: Record<string, boolean> = {};

      for (const prov of PROVIDER_ORDER) {
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
              providerSuccess.miruro = true;
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
              providerSuccess.animekai = true;
              break;
            }
          }
        } catch (e) {
          console.warn(`[AnimeWatch] ${prov} failed:`, e);
        }
      }

      if (cancelled) return;
      if (sources.length === 0) {
        setStreamError('No streams available for this episode.');
        setStreamLoading(false);
        return;
      }

      // Pick best source matching audio preference
      let idx = 0;
      const matchIdx = sources.findIndex((s) =>
        s.title && sourceMatchesAudioPreference(s.title, audioPref),
      );
      if (matchIdx >= 0) idx = matchIdx;

      setStreamSources(sources);
      setStreamSourceIndex(idx);
      setStreamUrl(sources[idx].url);
      setCurrentProvider(activeProvider);
      setAvailableProviders(PROVIDER_ORDER.filter((p) => providerSuccess[p]));
      setStreamLoading(false);
    })();
    return () => { cancelled = true; };
  }, [useMobilePlayer, malId, playEpisode, audioPref, anime, isMovie, retryNonce]);

  // ─── Document title ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!title) return;
    document.title = `${isMovie ? '' : `E${playEpisode} - `}${title} | Flyx`;
  }, [title, playEpisode, isMovie]);

  // ─── Handlers ────────────────────────────────────────────────────────────
  const handleAudioPrefChange = useCallback((newPref: AnimeAudioPreference, currentTime = 0) => {
    setStreamResumeTime(currentTime);
    setAudioPref(newPref);
    saveProviderSettings({ animeAudioPreference: newPref });
    lastFetchedRef.current = '';
  }, []);

  const handleProviderChange = useCallback((_provider: string, currentTime = 0) => {
    setStreamResumeTime(currentTime);
    lastFetchedRef.current = '';
  }, []);

  const handleSourceChange = useCallback((index: number, currentTime = 0) => {
    if (index >= 0 && index < streamSources.length) {
      setStreamResumeTime(currentTime);
      setStreamSourceIndex(index);
      setStreamUrl(streamSources[index].url);
    }
  }, [streamSources]);

  const handleNextEpisode = useCallback(() => {
    if (isMovie) return;
    setStreamResumeTime(0);
    setCurrentEpisode((e) => {
      if (totalEpisodes != null && e >= totalEpisodes) return e;
      return e + 1;
    });
  }, [isMovie, totalEpisodes]);

  // Keep URL in sync with currentEpisode so refresh resumes the right episode
  useEffect(() => {
    if (isMovie) return;
    const url = `/anime/${malId}/watch?episode=${currentEpisode}`;
    window.history.replaceState({}, '', url);
  }, [malId, currentEpisode, isMovie]);

  const hasNextEpisode = !isMovie && (totalEpisodes == null || currentEpisode < totalEpisodes);

  const retryStream = useCallback(() => {
    setStreamError(null);
    setStreamLoading(true);
    setRetryNonce((n) => n + 1);
  }, []);

  // ─── Render ──────────────────────────────────────────────────────────────
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
  if (animeError || !anime) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>
          <h2>Anime Not Found</h2>
          <p>We couldn't load this anime from MyAnimeList.</p>
          <div className={styles.errorActions}>
            <button onClick={() => router.push('/anime')} className={styles.backButton}>
              Back to Anime
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (streamLoading) {
    return (
      <div className={styles.container}>
        <div className={styles.playerWrapper}>
          <div className={styles.loading}>
            <div className={styles.spinner} />
            <p>{`Finding source for ${isMovie ? title : `E${playEpisode}`}…`}</p>
          </div>
        </div>
      </div>
    );
  }
  if (streamError || !streamUrl) {
    return (
      <div className={styles.container}>
        <div className={styles.playerWrapper}>
          <div className={styles.error}>
            <h2>Playback Error</h2>
            <p>{streamError || 'Failed to load video'}</p>
            <div className={styles.errorActions}>
              <button onClick={retryStream} className={styles.retryButton}>Try Again</button>
              <button onClick={() => router.push(`/anime/${malId}`)} className={styles.backButton}>
                Back to Details
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const nextEp = hasNextEpisode
    ? { season: 1, episode: currentEpisode + 1, title: `Episode ${currentEpisode + 1}` }
    : null;

  if (useMobilePlayer) {
    return (
      <div className={styles.container}>
        <MobileVideoPlayer
          tmdbId="0"
          mediaType={isMovie ? 'movie' : 'tv'}
          season={isMovie ? undefined : 1}
          episode={isMovie ? undefined : playEpisode}
          title={title}
          streamUrl={streamUrl}
          availableSources={streamSources}
          currentSourceIndex={streamSourceIndex}
          onSourceChange={handleSourceChange}
          onBack={() => router.push(`/anime/${malId}`)}
          initialTime={streamResumeTime}
          onError={(err) => setStreamError(err)}
          isAnime
          audioPref={audioPref}
          onAudioPrefChange={handleAudioPrefChange}
          availableProviders={availableProviders as any}
          currentProvider={currentProvider as any}
          onProviderChange={handleProviderChange}
          loadingProvider={false}
          skipIntro={streamSources[streamSourceIndex]?.skipIntro ?? null}
          skipOutro={streamSources[streamSourceIndex]?.skipOutro ?? null}
          nextEpisode={nextEp}
          onNextEpisode={hasNextEpisode ? handleNextEpisode : undefined}
        />
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <DesktopVideoPlayer
        tmdbId="0"
        mediaType={isMovie ? 'movie' : 'tv'}
        season={isMovie ? undefined : 1}
        episode={isMovie ? undefined : playEpisode}
        title={title}
        onBack={() => router.push(`/anime/${malId}`)}
        malId={malId}
        malTitle={title}
        externalStreamUrl={streamUrl}
        externalStreamSources={streamSources}
        externalStreamProvider={currentProvider}
        externalStreamSourceIndex={streamSourceIndex}
        nextEpisode={nextEp}
        onNextEpisode={hasNextEpisode ? handleNextEpisode : undefined}
      />
    </div>
  );
}
