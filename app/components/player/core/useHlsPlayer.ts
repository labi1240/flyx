/**
 * useHlsPlayer — HLS.js initialization, quality selection, error recovery
 * 
 * Encapsulates all HLS.js lifecycle management: creating/destroying instances,
 * loading sources, handling manifest parsing, fragment loading, quality level
 * switching, and error recovery with automatic source fallback.
 * 
 * Requirements: 6.1
 */
'use client';

import { useEffect, useRef, useCallback, useMemo } from 'react';
import Hls from 'hls.js';
import type { HlsQualityLevel } from './types';

export interface UseHlsPlayerOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  streamUrl: string | null;
  playbackSpeed: number;
  pendingSeekTimeRef: React.MutableRefObject<number | null>;
  sourceConfirmedWorkingRef: React.MutableRefObject<boolean>;
  currentSourceIndex: number;
  provider: string;
  shouldAutoplay: boolean;
  // Callbacks
  onManifestParsed?: () => void;
  onLevelsLoaded?: (levels: HlsQualityLevel[]) => void;
  onLevelSwitched?: (resolution: string) => void;
  onFragmentLoaded?: (fragIndex: number) => void;
  onError?: (fatal: boolean, type: string, details: string) => void;
  onSourceConfirmed?: (sourceIndex: number) => void;
  // Subtitle restoration
  restoreSubtitles?: () => void;
  // iOS native HLS support
  isIOS?: boolean;
  supportsNativeHLS?: boolean;
}

export interface UseHlsPlayerReturn {
  hlsRef: React.MutableRefObject<Hls | null>;
  changeHlsLevel: (levelIndex: number) => void;
  isHlsSupported: boolean;
}

export function useHlsPlayer(options: UseHlsPlayerOptions): UseHlsPlayerReturn {
  const {
    videoRef,
    streamUrl,
    playbackSpeed,
    pendingSeekTimeRef,
    sourceConfirmedWorkingRef,
    shouldAutoplay,
    onManifestParsed,
    onLevelsLoaded,
    onLevelSwitched,
    onFragmentLoaded,
    onError,
    onSourceConfirmed,
    restoreSubtitles,
    isIOS = false,
    supportsNativeHLS = false,
  } = options;

  const hlsRef = useRef<Hls | null>(null);
  const isHlsSupported = typeof window !== 'undefined' ? Hls.isSupported() : false;
  const consecutiveSegmentErrorsRef = useRef(0);
  const MAX_CONSECUTIVE_SEGMENT_ERRORS = 8;

  const hlsConfig = useMemo(() => ({
    enableWorker: true,
    lowLatencyMode: false,
    backBufferLength: 90,
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
    maxBufferSize: 60 * 1000 * 1000,
    maxBufferHole: 0.5,
    highBufferWatchdogPeriod: 2,
    nudgeOffset: 0.1,
    nudgeMaxRetry: 5,
    manifestLoadingTimeOut: 15000,
    manifestLoadingMaxRetry: 3,
    manifestLoadingRetryDelay: 500,
    levelLoadingTimeOut: 15000,
    levelLoadingMaxRetry: 3,
    fragLoadingTimeOut: 30000,
    fragLoadingMaxRetry: 5,
    fragLoadingRetryDelay: 1000,
    startLevel: -1,
    abrEwmaDefaultEstimate: 1000000,
    abrBandWidthFactor: 0.8,
    abrBandWidthUpFactor: 0.5,
    abrMaxWithRealBitrate: true,
    xhrSetup: (xhr: XMLHttpRequest) => {
      xhr.withCredentials = false;
    },
  }), []);

  // Initialize HLS when streamUrl changes
  useEffect(() => {
    if (!streamUrl || !videoRef.current) return;

    const video = videoRef.current;
    sourceConfirmedWorkingRef.current = false;
    consecutiveSegmentErrorsRef.current = 0;

    const isHlsUrl = streamUrl.includes('.m3u8') ||
      streamUrl.includes('stream-proxy') ||
      streamUrl.includes('/stream/') ||
      streamUrl.includes('/animekai') ||
      streamUrl.includes('/vidsrc');

    // iOS native HLS
    if (isIOS && supportsNativeHLS) {
      video.src = streamUrl;
      const handleLoadedMetadata = () => {
        if (pendingSeekTimeRef.current !== null && pendingSeekTimeRef.current > 0) {
          video.currentTime = pendingSeekTimeRef.current;
          pendingSeekTimeRef.current = null;
        }
        if (playbackSpeed !== 1) video.playbackRate = playbackSpeed;
        restoreSubtitles?.();
        if (shouldAutoplay) {
          video.play().catch(() => {
            video.muted = true;
            video.play().catch(() => {});
          });
        }
      };
      video.addEventListener('loadedmetadata', handleLoadedMetadata);
      return () => {
        video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      };
    }

    // HLS.js path
    if (isHlsUrl && Hls.isSupported()) {
      // Destroy previous instance
      if (hlsRef.current) {
        hlsRef.current.destroy();
      }

      const hls = new Hls(hlsConfig as any);
      hlsRef.current = hls;

      hls.loadSource(streamUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        // Extract quality levels
        if (hls.levels && hls.levels.length > 0) {
          const levels = hls.levels
            .map((level, index) => ({
              height: level.height || 0,
              bitrate: level.bitrate || 0,
              index,
            }))
            .filter(l => l.height > 0)
            .sort((a, b) => b.height - a.height);

          const uniqueLevels = levels.filter(
            (level, idx, arr) => arr.findIndex(l => l.height === level.height) === idx
          );
          onLevelsLoaded?.(uniqueLevels);
        }

        // Restore seek position
        if (pendingSeekTimeRef.current !== null && pendingSeekTimeRef.current > 0) {
          video.currentTime = pendingSeekTimeRef.current;
          pendingSeekTimeRef.current = null;
        }

        // Restore playback speed
        if (playbackSpeed !== 1) {
          video.playbackRate = playbackSpeed;
        }

        // Restore subtitles
        restoreSubtitles?.();

        onManifestParsed?.();

        if (shouldAutoplay) {
          video.play().catch(e => console.log('[HLS] Autoplay prevented:', e));
        }
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        const level = hls.levels[data.level];
        if (level?.height) {
          onLevelSwitched?.(`${level.height}p`);
        }
      });

      hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
        const fragSn = typeof data.frag?.sn === 'number' ? data.frag.sn : -1;
        onFragmentLoaded?.(fragSn);

        // Reset segment error counter on successful load
        consecutiveSegmentErrorsRef.current = 0;

        if ((fragSn === 0 || fragSn === 1) && !sourceConfirmedWorkingRef.current) {
          sourceConfirmedWorkingRef.current = true;
          onSourceConfirmed?.(options.currentSourceIndex);
        }
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        console.error('[HLS] Error:', {
          type: data.type,
          details: data.details,
          fatal: data.fatal,
        });

        if (data.fatal) {
          const isSegmentError =
            data.details === 'fragLoadError' ||
            data.details === 'fragLoadTimeOut' ||
            data.details === 'fragParsingError' ||
            data.details === 'levelLoadError' ||
            data.details === 'levelLoadTimeOut' ||
            data.details === 'bufferStalledError' ||
            data.details === 'bufferAppendError';

          const isManifestError =
            data.details === 'manifestLoadError' ||
            data.details === 'manifestLoadTimeOut';

          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              if (isManifestError) {
                // Manifest unreachable — source is dead, escalate immediately
                onError?.(true, 'network', data.details);
              } else if (isSegmentError) {
                // Fragment/segment error — skip the bad segment,
                // only escalate after many consecutive failures
                consecutiveSegmentErrorsRef.current++;
                if (consecutiveSegmentErrorsRef.current >= MAX_CONSECUTIVE_SEGMENT_ERRORS) {
                  consecutiveSegmentErrorsRef.current = 0;
                  onError?.(true, 'network', data.details);
                } else {
                  hls.startLoad();
                }
              } else {
                onError?.(true, 'network', data.details);
              }
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              onError?.(true, 'fatal', data.details);
              break;
          }
        }
      });

      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    }

    // Direct MP4 fallback
    video.src = streamUrl;
    const handleLoaded = () => {
      if (pendingSeekTimeRef.current !== null && pendingSeekTimeRef.current > 0) {
        video.currentTime = pendingSeekTimeRef.current;
        pendingSeekTimeRef.current = null;
      }
      if (playbackSpeed !== 1) video.playbackRate = playbackSpeed;
      if (shouldAutoplay) {
        video.play().catch(() => {});
      }
    };
    video.addEventListener('loadedmetadata', handleLoaded);
    return () => {
      video.removeEventListener('loadedmetadata', handleLoaded);
    };
  }, [streamUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeHlsLevel = useCallback((levelIndex: number) => {
    if (hlsRef.current) {
      hlsRef.current.currentLevel = levelIndex;
    }
  }, []);

  return {
    hlsRef,
    changeHlsLevel,
    isHlsSupported,
  };
}
