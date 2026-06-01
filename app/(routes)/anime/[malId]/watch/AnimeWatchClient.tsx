'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { getProviderSettings } from '@/lib/sync';
import { sourceMatchesAudioPreference, type AnimeAudioPreference } from '@/lib/utils/player-preferences';
import { ExtensionGate } from '@/components/ExtensionGate';
import { jikanFull, type JikanAnime } from '@/lib/anime/jikan-client';
import styles from '../../../watch/[id]/WatchPage.module.css';

const AnimeVideoPlayer = dynamic(
  () => import('@/components/player/AnimeVideoPlayer'),
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
  language?: string;
  requiresSegmentProxy?: boolean;
  skipIntro?: [number, number];
  skipOutro?: [number, number];
}

// AnimeKai (H.264/MegaUp) first: it plays in every browser. Miruro's only
// working provider (kiwi) serves HEVC/H.265, which Chrome/Edge can't decode
// via MSE — so it's used as the fallback for HEVC-capable devices only.
const PROVIDER_ORDER = ['animekai', 'miruro'] as const;

export default function AnimeWatchClient(props: { malId: number; episode: number }) {
  return (
    <ExtensionGate type="anime">
      <AnimeWatchClientInner {...props} />
    </ExtensionGate>
  );
}

function AnimeWatchClientInner({ malId, episode: initialEpisode }: { malId: number; episode: number }) {
  const router = useRouter();

  // ─── Anime metadata ──────────────────────────────────────────────────────
  const [anime, setAnime] = useState<JikanAnime | null>(null);
  const [loading, setLoading] = useState(true);
  const [animeError, setAnimeError] = useState(false);

  // ─── Current episode ─────────────────────────────────────────────────────
  const [currentEpisode, setCurrentEpisode] = useState(initialEpisode);
  useEffect(() => { setCurrentEpisode(initialEpisode); }, [initialEpisode]);

  // ─── Stream state ────────────────────────────────────────────────────────
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [streamSources, setStreamSources] = useState<StreamSource[]>([]);
  const [streamSourceIndex, setStreamSourceIndex] = useState(0);
  const [streamLoading, setStreamLoading] = useState(true);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [audioPref] = useState<AnimeAudioPreference>(
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
  const title = anime ? (anime.title_english || anime.title) : '';

  // ─── Fetch stream ────────────────────────────────────────────────────────
  const lastFetchedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!anime) return;
    const key = `${malId}-${playEpisode}-${audioPref}-${retryNonce}`;
    if (lastFetchedRef.current === key) return;
    lastFetchedRef.current = key;

    let cancelled = false;
    (async () => {
      setStreamLoading(true);
      setStreamError(null);
      const animeTitle = anime.title_english || anime.title;
      const targetEp = isMovie ? undefined : playEpisode;

      // Extract from BOTH providers upfront — the player can switch
      // between them if one has codec/network issues.
      let allSources: StreamSource[] = [];

      for (const prov of PROVIDER_ORDER) {
        if (cancelled) return;
        try {
          if (prov === 'miruro') {
            const { extractMiruroClient } = await import('@/lib/services/miruro-client-extractor');
            const results = await extractMiruroClient(malId, animeTitle, targetEp, audioPref);
            for (const s of results) {
              allSources.push({
                title: s.title || 'Miruro',
                url: s.url,
                quality: s.quality,
                provider: 'miruro',
                language: s.language || 'ja',
                skipIntro: (s as any).skipIntro,
                skipOutro: (s as any).skipOutro,
              });
            }
          } else if (prov === 'animekai') {
            const { extractAnimeKaiClient } = await import('@/lib/services/animekai-client-extractor');
            const results = await extractAnimeKaiClient(malId, animeTitle, targetEp, audioPref);
            for (const s of results) {
              allSources.push({
                title: s.title || 'AnimeKai',
                url: s.url,
                quality: s.quality,
                provider: 'animekai',
                language: s.language || 'ja',
                skipIntro: (s as any).skipIntro,
                skipOutro: (s as any).skipOutro,
              });
            }
          }
        } catch (e) {
          console.warn(`[AnimeWatch] ${prov} failed:`, e);
        }
      }

      if (cancelled) return;
      if (allSources.length === 0) {
        setStreamError('No anime streams available. Try again or check back later.');
        setStreamLoading(false);
        return;
      }

      // Pick best source matching audio preference
      let idx = 0;
      const matchIdx = allSources.findIndex((s) =>
        s.title && sourceMatchesAudioPreference(s.title, audioPref),
      );
      if (matchIdx >= 0) idx = matchIdx;

      setStreamSources(allSources);
      setStreamSourceIndex(idx);
      setStreamUrl(allSources[idx].url);
      setStreamLoading(false);
    })();
    return () => { cancelled = true; };
  }, [malId, playEpisode, audioPref, anime, isMovie, retryNonce]);

  // ─── Document title ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!title) return;
    document.title = `${isMovie ? '' : `E${playEpisode} - `}${title} | Flyx`;
  }, [title, playEpisode, isMovie]);

  // ─── Handlers ────────────────────────────────────────────────────────────
  const handleSourceChange = useCallback((index: number) => {
    if (index >= 0 && index < streamSources.length) {
      setStreamSourceIndex(index);
      setStreamUrl(streamSources[index].url);
    }
  }, [streamSources]);

  useEffect(() => {
    if (isMovie) return;
    window.history.replaceState({}, '', `/anime/${malId}/watch?episode=${currentEpisode}`);
  }, [malId, currentEpisode, isMovie]);

  const retryStream = useCallback(() => {
    setStreamError(null);
    setStreamLoading(true);
    setRetryNonce((n) => n + 1);
  }, []);

  // ─── Render ──────────────────────────────────────────────────────────────
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
  // Hard error (network failure, etc.) — show error page with retry
  if (streamError) {
    return (
      <div className={styles.container}>
        <div className={styles.playerWrapper}>
          <div className={styles.error}>
            <h2>Playback Error</h2>
            <p>{streamError}</p>
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

  if (!streamUrl) {
    return (
      <div className={styles.container}>
        <div className={styles.playerWrapper}>
          <div className={styles.loading}>
            <div className={styles.spinner} />
            <p>Sourcing stream…</p>
            <button onClick={retryStream} className={styles.retryButton} style={{ marginTop: 12 }}>
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <AnimeVideoPlayer
        title={title}
        sources={streamSources}
        initialSourceIndex={streamSourceIndex}
        episodeLabel={!isMovie ? `Episode ${playEpisode}` : undefined}
        onBack={() => router.push(`/anime/${malId}`)}
        onError={(err) => setStreamError(err)}
        onSourceChange={handleSourceChange}
      />
    </div>
  );
}
