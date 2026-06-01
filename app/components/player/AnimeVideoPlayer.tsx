/**
 * AnimeVideoPlayer — dedicated anime playback component.
 *
 * Lightweight, anime-specific. No movie/TV provider code.
 * Uses hls.js with FetchLoader for extension DNR header injection.
 * Proper lifecycle management to prevent hls.js internal crashes.
 */

'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import Hls from 'hls.js';
import FetchLoader from './hls-fetch-loader';
import styles from './Player.module.css';

interface AnimeSource {
  title: string;
  url: string;
  quality?: string;
  provider?: string;
  language?: string;
  skipIntro?: [number, number];
  skipOutro?: [number, number];
}

interface Props {
  title: string;
  sources: AnimeSource[];
  initialSourceIndex?: number;
  episodeLabel?: string;
  onBack?: () => void;
  onError?: (err: string) => void;
  onSourceChange?: (index: number) => void;
}

export default function AnimeVideoPlayer({
  title,
  sources,
  initialSourceIndex = 0,
  episodeLabel,
  onBack,
  onError,
  onSourceChange,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [sourceIdx, setSourceIdx] = useState(initialSourceIndex);
  const [error, setError] = useState<string | null>(null);
  const destroyedRef = useRef(false);

  const currentSource = sources[sourceIdx];

  // ─── Init hls.js ─────────────────────────────────────────────────────
  const urlRef = useRef<string | null>(null);
  useEffect(() => {
    var url = currentSource?.url;
    if (!url || !videoRef.current) return;
    // Prevent re-init for the same URL (React Strict Mode double-mount)
    if (urlRef.current === url && hlsRef.current) return;
    urlRef.current = url;

    var video = videoRef.current;
    destroyedRef.current = false;

    // Clean previous instance
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    console.log('[AnimePlayer] Loading:', url.substring(0, 100));

    if (Hls.isSupported()) {
      var hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 90,
        maxBufferLength: 30,
        maxBufferSize: 60 * 1000 * 1000,
        manifestLoadingTimeOut: 15000,
        manifestLoadingMaxRetry: 4,
        levelLoadingTimeOut: 15000,
        fragLoadingTimeOut: 30000,
        fragLoadingMaxRetry: 8,
        startLevel: -1,
        pLoader: FetchLoader as any,
        fLoader: FetchLoader as any,
      });

      hls.on(Hls.Events.ERROR, function (_event, data) {
        if (destroyedRef.current) return;
        if (data.fatal) {
          console.error('[AnimePlayer] HLS fatal:', data.type, data.details);
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            if ((data.response?.code === 403 || data.response?.code === 404) && sourceIdx < sources.length - 1) {
              setSourceIdx(function (prev) { return prev + 1; });
              return;
            }
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls?.recoverMediaError();
            return;
          }
          setError('Stream playback failed: ' + (data.details || 'unknown'));
          onError?.(data.details || 'HLS error');
        }
      });

      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        if (destroyedRef.current) return;
        console.log('[AnimePlayer] Manifest ready');
        // Don't autoplay — let the user click play to avoid
        // "play() interrupted by new load request" on React remount
      });

      hls.loadSource(url);
      hls.attachMedia(video);
      hlsRef.current = hls;
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
    }

    return function cleanup() {
      destroyedRef.current = true;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [currentSource?.url]);

  // ─── Skip intro/outro ────────────────────────────────────────────────
  const handleTimeUpdate = useCallback(function () {
    const video = videoRef.current;
    if (!video || !currentSource) return;
    const t = video.currentTime;
    const intro = currentSource.skipIntro;
    const outro = currentSource.skipOutro;
    if (intro && t >= intro[0] && t < intro[1]) {
      video.currentTime = intro[1];
    }
    if (outro && t >= outro[0]) {
      video.currentTime = video.duration || outro[1];
    }
  }, [currentSource]);

  // ─── Handlers ────────────────────────────────────────────────────────
  function switchSource(idx: number) {
    if (idx >= 0 && idx < sources.length) {
      setSourceIdx(idx);
      setError(null);
      onSourceChange?.(idx);
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────
  return (
    <div className={styles.playerContainer}>
      {/* Top bar */}
      <div className={styles.topBar}>
        {onBack && (
          <button onClick={onBack} className={styles.backBtn} aria-label="Back">
            ← Back
          </button>
        )}
        <div className={styles.titleInfo}>
          <span className={styles.epTitle}>{title}</span>
          {episodeLabel && <span className={styles.epLabel}>{episodeLabel}</span>}
        </div>
      </div>

      {/* Video */}
      <div className={styles.videoWrapper}>
        <video
          ref={videoRef}
          className={styles.video}
          controls
          crossOrigin="anonymous"
          playsInline
          onTimeUpdate={handleTimeUpdate}
        />

        {error && (
          <div className={styles.errorOverlay}>
            <p>{error}</p>
            {sources.length > 1 && (
              <div className={styles.sourceList}>
                {sources.map(function (s, i) {
                  return (
                    <button
                      key={i}
                      onClick={function () { switchSource(i); }}
                      className={i === sourceIdx ? styles.activeSource : styles.sourceBtn}
                    >
                      {s.title || 'Source ' + (i + 1)}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Source picker */}
      {sources.length > 1 && !error && (
        <div className={styles.sourcePicker}>
          {sources.map(function (s, i) {
            return (
              <button
                key={i}
                onClick={function () { switchSource(i); }}
                className={i === sourceIdx ? styles.activeSource : styles.sourceBtn}
              >
                {s.title || 'Source ' + (i + 1)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
