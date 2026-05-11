'use client';

import React, { useRef, useState, useEffect, useCallback } from 'react';
import Hls from 'hls.js';
import { getFlixerStreamProxyUrl, getAnimeKaiProxyUrl, getHiAnimeStreamProxyUrl } from '@/app/lib/proxy-config';
import { useAnalytics } from '../analytics/AnalyticsProvider';
import { useWatchProgress } from '@/lib/hooks/useWatchProgress';
import { trackWatchStart, trackWatchProgress, trackWatchPause, trackWatchComplete } from '@/lib/utils/live-activity';
import { usePresenceContext } from '../analytics/PresenceProvider';
import { getSubtitlePreferences, setSubtitlesEnabled, setSubtitleLanguage, getSubtitleStyle, setSubtitleStyle, type SubtitleStyle } from '@/lib/utils/subtitle-preferences';
import { 
  getPlayerPreferences, 
  setAutoPlayNextEpisode, 
  setAutoPlayCountdown, 
  setShowNextEpisodeBeforeEnd, 
  setPreferredAnimeKaiServer,
  sourceMatchesAudioPreference,
  getSavedVolume,
  getSavedMuteState,
  saveVolumeSettings,
  type PlayerPreferences,
} from '@/lib/utils/player-preferences';
import { getProviderSettings, saveProviderSettings, recordSuccessfulProvider, SYNC_DATA_CHANGED_EVENT } from '@/lib/sync';

// Type alias for anime audio preference
type AnimeAudioPreference = 'sub' | 'dub';
import { usePinchZoom } from '@/hooks/usePinchZoom';
import { useCast, CastMedia } from '@/hooks/useCast';
import { CastOverlay } from './CastButton';
import TranscriptButton from './TranscriptButton';
import PrimeSrcTurnstile from './PrimeSrcTurnstile';
import { setTurnstileToken } from '@/app/lib/services/primesrc-extractor';
// Player Core hooks — shared logic extracted for reuse by both desktop and mobile players
// These hooks encapsulate HLS management, subtitle handling, progress tracking, and source switching.
// The desktop player integrates these hooks for shared functionality while retaining
// desktop-specific UI controls (keyboard shortcuts, timeline preview, cast, transcript, etc.)
// TODO: Integrate core hooks (usePlayerState, useSubtitles, usePlaybackProgress, useSourceSwitcher)
// to replace inline implementations. See ./core for shared player logic.
import styles from './VideoPlayer.module.css';

// Copy URL button with feedback for external players
function CopyUrlButton({ url }: { url: string }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    
    // Convert relative URLs to absolute URLs
    let fullUrl = url;
    if (url.startsWith('/')) {
      fullUrl = `${window.location.origin}${url}`;
    }
    
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy URL:', err);
    }
  };

  return (
    <button 
      onClick={handleCopy} 
      className={`${styles.btn} ${copied ? styles.active : ''}`}
      data-player-control="copy-url"
      title="Copy stream URL for external player (VLC, mpv, etc.)"
    >
      {copied ? (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      )}
    </button>
  );
}

interface VideoPlayerProps {
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
  onBack?: () => void; // Callback for back navigation (to details page)
  autoplay?: boolean; // Auto-start playback (used when navigating from previous episode)
  malId?: number; // MyAnimeList ID for anime (used for accurate episode mapping)
  malTitle?: string; // MAL title for the specific season/entry
}

/**
 * Apply CF Worker stream proxy to a source URL when needed.
 *
 * Flixer CDN (*.workers.dev) blocks CF Worker IPs (all headers fail with 403).
 * But residential IPs get 200 + ACAO:* from the CDN. So browsers fetch CDN
 * content directly — no proxy needed. Only proxy when requiresSegmentProxy: true.
 */
function applyStreamProxy(sourceUrl: string, providerName: string, requiresProxy?: boolean): string {
  if (!sourceUrl) return sourceUrl;
  // Already proxied — don't double-wrap
  // Check for specific proxy route patterns only (not generic /stream/ which matches CDN paths)
  if (sourceUrl.includes('/flixer/stream') || sourceUrl.includes('/animekai') ||
      sourceUrl.includes('/hianime/') || sourceUrl.includes('/hianime?') ||
      sourceUrl.includes('/vidsrc/') ||
      sourceUrl.includes('/api/stream-proxy') || sourceUrl.includes('/primesrc/')) {
    return sourceUrl;
  }

  // Flixer CDN (*.workers.dev) is handled by the Service Worker which
  // fetches from the browser's residential IP + adds CORS. Do NOT proxy
  // Flixer through CF Worker (its IP is blocked by Flixer CDN).
  // Other providers (DLHD, IPTV, etc.) still need CF Worker proxy for CORS.
  const isFlixerCdn = providerName === 'flixer' && sourceUrl.includes('.workers.dev');
  const needsProxy = (!isFlixerCdn && requiresProxy) ||
    (!isFlixerCdn && sourceUrl.includes('.workers.dev')) ||
    (!isFlixerCdn && sourceUrl.includes('frostcomet')) ||
    (!isFlixerCdn && sourceUrl.includes('thunderleaf')) ||
    (!isFlixerCdn && sourceUrl.includes('skyember')) ||
    (!isFlixerCdn && sourceUrl.includes('nightbreeze')) ||
    (!isFlixerCdn && sourceUrl.includes('wind.'));
  if (!needsProxy) return sourceUrl;

  if (providerName === 'flixer') return getFlixerStreamProxyUrl(sourceUrl);
  if (providerName === 'hianime') return getHiAnimeStreamProxyUrl(sourceUrl);
  if (providerName === 'animekai') return getAnimeKaiProxyUrl(sourceUrl);
  // For other providers, return as-is (they handle their own proxying)
  return sourceUrl;
}

export default function VideoPlayer({ tmdbId, mediaType, season, episode, title, nextEpisode, onNextEpisode, onBack, autoplay = false, malId, malTitle }: VideoPlayerProps) {
  // Debug: Log nextEpisode prop
  useEffect(() => {
    console.log('[VideoPlayer] nextEpisode prop received:', nextEpisode);
  }, [nextEpisode]);
  
  // Debug: Log MAL info when available (for anime)
  useEffect(() => {
    if (malId) {
      console.log('[VideoPlayer] MAL info available:', { malId, malTitle, season, episode });
    }
  }, [malId, malTitle, season, episode]);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const subtitlesFetchedRef = useRef(false);
  const subtitlesAutoLoadedRef = useRef(false);
  const hasShownResumePromptRef = useRef(false);
  const shouldShowResumePromptRef = useRef(false); // Track if resume prompt will be shown (to prevent autoplay)
  const triedProvidersRef = useRef<Set<string>>(new Set());
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const isAutoplayNavigationRef = useRef(autoplay); // Track if this is an autoplay navigation

  // Analytics and progress tracking
  const { trackContentEngagement, trackInteraction, updateWatchTime, recordPause, clearWatchTime } = useAnalytics();
  const presenceContext = usePresenceContext();
  const contentType = mediaType === 'tv' ? 'episode' : 'movie';
  const {
    handleProgress,
    loadProgress,
    handleWatchStart,
    handleWatchPause,
    handleWatchResume
  } = useWatchProgress({
    contentId: tmdbId,
    contentType,
    contentTitle: title,
    seasonNumber: season,
    episodeNumber: episode,
    onProgress: (_time, _duration) => {
      // This will be called by the hook when progress is updated
    },
    onComplete: () => {
      // Track completion in viewing history
      trackContentEngagement(tmdbId, mediaType, 'completed', {
        title,
        season,
        episode,
      });
    },
  });

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => getSavedVolume());
  const [isMuted, setIsMuted] = useState(() => getSavedMuteState());
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [availableSources, _setAvailableSources] = useState<any[]>([]);
  const availableSourcesRef = useRef<any[]>([]);
  // Keep ref in sync with state so HLS error handlers always have fresh data
  const setAvailableSources: typeof _setAvailableSources = (update) => {
    _setAvailableSources(prev => {
      const next = typeof update === 'function' ? update(prev) : update;
      availableSourcesRef.current = next;
      return next;
    });
  };
  const [currentSourceIndex, setCurrentSourceIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [buffered, setBuffered] = useState(0);
  const [isBuffering, setIsBuffering] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSubtitles, setShowSubtitles] = useState(false);
  const [showSubtitleCustomization, setShowSubtitleCustomization] = useState(false);
  const [currentSubtitle, setCurrentSubtitle] = useState<string | null>(null);
  const [availableSubtitles, setAvailableSubtitles] = useState<any[]>([]);
  const [subtitlesLoading, setSubtitlesLoading] = useState(false);
  const [subtitleStyle, setSubtitleStyleState] = useState<SubtitleStyle>(getSubtitleStyle());
  const [subtitleOffset, setSubtitleOffset] = useState<number>(0); // Subtitle sync offset in seconds
  const [showSubtitleOffsetIndicator, setShowSubtitleOffsetIndicator] = useState(false); // Show offset change indicator
  const subtitleOffsetIndicatorTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [showResumePrompt, setShowResumePrompt] = useState(false);
  const [savedProgress, setSavedProgress] = useState<number>(0);
  const [showVolumeIndicator, setShowVolumeIndicator] = useState(false);
  const [customSubtitles, setCustomSubtitles] = useState<any[]>([]); // User-uploaded VTT files
  const subtitleFileInputRef = useRef<HTMLInputElement>(null);
  const currentSubtitleDataRef = useRef<any>(null); // Store current subtitle data for re-syncing
  const pendingSeekTimeRef = useRef<number | null>(null); // Store position to restore when switching sources

  const [showNextEpisodeButton, setShowNextEpisodeButton] = useState(false);
  const [autoPlayCountdown, setAutoPlayCountdownState] = useState<number | null>(null);
  const [playerPrefs, setPlayerPrefs] = useState<PlayerPreferences>(getPlayerPreferences());
  const autoPlayTimerRef = useRef<NodeJS.Timeout | null>(null);
  const hasNavigatedToNextRef = useRef<boolean>(false); // Prevent repeated auto-next triggers on iOS
  
  // Playback speed state
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [showSpeedIndicator, setShowSpeedIndicator] = useState(false);
  const speedIndicatorTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const speedOptions = [0.5, 0.75, 1, 1.25, 1.5, 2];
  
  // Refs to access current values in event handlers (avoid stale closures)
  const nextEpisodeRef = useRef(nextEpisode);
  const playerPrefsRef = useRef(playerPrefs);
  const onNextEpisodeRef = useRef(onNextEpisode);
  const showNextEpisodeButtonRef = useRef(showNextEpisodeButton);
  const autoPlayCountdownRef = useRef(autoPlayCountdown);
  
  // Keep refs in sync with props/state
  useEffect(() => { 
    console.log('[VideoPlayer] Updating nextEpisodeRef:', nextEpisode);
    nextEpisodeRef.current = nextEpisode; 
  }, [nextEpisode]);
  useEffect(() => { playerPrefsRef.current = playerPrefs; }, [playerPrefs]);
  useEffect(() => { 
    console.log('[VideoPlayer] Updating onNextEpisodeRef:', !!onNextEpisode);
    onNextEpisodeRef.current = onNextEpisode; 
  }, [onNextEpisode]);
  useEffect(() => { showNextEpisodeButtonRef.current = showNextEpisodeButton; }, [showNextEpisodeButton]);
  useEffect(() => { autoPlayCountdownRef.current = autoPlayCountdown; }, [autoPlayCountdown]);
  
  // Listen for sync data changes and refresh preferences
  useEffect(() => {
    const handleSyncDataChanged = () => {
      console.log('[VideoPlayer] Sync data changed, refreshing preferences');
      setPlayerPrefs(getPlayerPreferences());
      setSubtitleStyleState(getSubtitleStyle());
      setAnimeAudioPref(getProviderSettings().animeAudioPreference);
      setVolume(getSavedVolume());
      setIsMuted(getSavedMuteState());
    };
    
    window.addEventListener(SYNC_DATA_CHANGED_EVENT, handleSyncDataChanged);
    return () => window.removeEventListener(SYNC_DATA_CHANGED_EVENT, handleSyncDataChanged);
  }, []);
  
  const [provider, setProvider] = useState('videasy'); // Default to Videasy (primary provider)
  const [menuProvider, setMenuProvider] = useState('videasy');
  const [showServerMenu, setShowServerMenu] = useState(false);
  const [sourcesCache, setSourcesCache] = useState<Record<string, any[]>>({});
  const [loadingProviders, setLoadingProviders] = useState<Record<string, boolean>>({});
  const [isCastOverlayVisible, setIsCastOverlayVisible] = useState(false);
  const [castError, setCastError] = useState<string | null>(null);
  const [showCastTips, setShowCastTips] = useState(false); // Cast Tips modal
  const castErrorTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [providerAvailability, setProviderAvailability] = useState<Record<string, boolean>>({
    videasy: true, // Videasy — primary provider for movies/TV
    flixer: true, // Flixer — backup source for movies/TV
    uflix: false,
    hexa: false,
    vidsrc: false,
    '1movies': false,
    animekai: true, // Anime-specific provider - auto-selected for anime content
    hianime: true, // HiAnime - primary anime provider (MegaCloud extraction)
  });
  const [isAnimeContent, setIsAnimeContent] = useState(false); // Track if current content is anime
  const [providerTabOrder, setProviderTabOrder] = useState<string[]>([]); // User-preferred provider tab order
  const [highlightServerButton, setHighlightServerButton] = useState(false);
  
  // Anime-specific preferences
  const [animeAudioPref, setAnimeAudioPref] = useState<AnimeAudioPreference>(() => getProviderSettings().animeAudioPreference);
  
  // Skip intro/outro state (from AnimeKai)
  const [skipIntro, setSkipIntro] = useState<[number, number] | null>(null);
  const [skipOutro, setSkipOutro] = useState<[number, number] | null>(null);
  const [showSkipIntroButton, setShowSkipIntroButton] = useState(false);
  const [showSkipOutroButton, setShowSkipOutroButton] = useState(false);
  
  // Sync skip intro/outro refs with state (for use in timeupdate handler)
  useEffect(() => { skipIntroRef.current = skipIntro; }, [skipIntro]);
  useEffect(() => { skipOutroRef.current = skipOutro; }, [skipOutro]);

  // HLS quality levels
  const [hlsLevels, setHlsLevels] = useState<{ height: number; bitrate: number; index: number }[]>([]);
  const [currentHlsLevel, setCurrentHlsLevel] = useState<number>(-1); // -1 = auto
  const [currentResolution, setCurrentResolution] = useState<string>('');

  // Player control navigation (TV/keyboard navigation for control buttons)
  // Row-based navigation: 0=back button, 1=timeline, 2=control buttons
  const [focusedRow, setFocusedRow] = useState<number>(-1); // -1 = no focus, 0=back, 1=timeline, 2=controls
  const [focusedControlIndex, setFocusedControlIndex] = useState<number>(-1); // -1 = no focus within row

  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastFetchedKey = useRef('');
  const volumeIndicatorTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Throttling refs to prevent excessive updates
  const lastTimeUpdateRef = useRef<number>(0);
  const lastWatchTimeUpdateRef = useRef<number>(0);
  const sourceConfirmedWorkingRef = useRef<boolean>(false);
  
  // Resolver for source playback confirmation — initializePlayer sets this,
  // HLS MANIFEST_PARSED or resume prompt resolves it to signal "this source works"
  const sourceReadyResolverRef = useRef<(() => void) | null>(null);
  
  // Auto-advance timer: if a source doesn't begin playing within 10s, skip to next source
  const playbackStartTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const playbackStartedRef = useRef<boolean>(false);
  
  // Skip intro/outro refs (to avoid stale closures in event handlers)
  const skipIntroRef = useRef<[number, number] | null>(null);
  const skipOutroRef = useRef<[number, number] | null>(null);

  // Pinch-to-zoom for mobile
  const [showZoomIndicator, setShowZoomIndicator] = useState(false);
  const zoomIndicatorTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleZoomChange = useCallback((scale: number) => {
    if (scale !== 1) {
      setShowZoomIndicator(true);
      if (zoomIndicatorTimeoutRef.current) {
        clearTimeout(zoomIndicatorTimeoutRef.current);
      }
      zoomIndicatorTimeoutRef.current = setTimeout(() => {
        setShowZoomIndicator(false);
      }, 1500);
    }
  }, []);

  // Adjust subtitle timing offset (Alt + scroll wheel)
  const adjustSubtitleOffset = useCallback((delta: number) => {
    setSubtitleOffset(prev => {
      const newOffset = prev + delta;
      
      // Apply offset to current text tracks
      if (videoRef.current && videoRef.current.textTracks) {
        for (let i = 0; i < videoRef.current.textTracks.length; i++) {
          const textTrack = videoRef.current.textTracks[i];
          if (textTrack.cues) {
            for (let j = 0; j < textTrack.cues.length; j++) {
              const cue = textTrack.cues[j] as VTTCue;
              cue.startTime = Math.max(0, cue.startTime + delta);
              cue.endTime = Math.max(0, cue.endTime + delta);
            }
          }
        }
      }
      console.log('[VideoPlayer] Subtitle offset adjusted to:', newOffset, 'seconds');
      return newOffset;
    });
    
    // Show the offset indicator briefly
    setShowSubtitleOffsetIndicator(true);
    if (subtitleOffsetIndicatorTimeoutRef.current) {
      clearTimeout(subtitleOffsetIndicatorTimeoutRef.current);
    }
    subtitleOffsetIndicatorTimeoutRef.current = setTimeout(() => {
      setShowSubtitleOffsetIndicator(false);
    }, 1500);
  }, []);

  // Single tap handler for mobile:
  // - If paused and controls visible: unpause
  // - If paused and controls hidden: show controls (don't unpause yet)
  // - If playing: pause
  const handleSingleTap = useCallback(() => {
    if (!videoRef.current) return;
    
    const isPaused = videoRef.current.paused;
    
    if (isPaused) {
      // Video is paused
      if (showControls) {
        // Controls are visible, so unpause
        videoRef.current.play();
      } else {
        // Controls are hidden, just show them first
        setShowControls(true);
      }
    } else {
      // Video is playing, pause it
      videoRef.current.pause();
    }
  }, [showControls]);

  const {
    scale: zoomScale,
    isZoomed,
    resetZoom,
    containerProps: zoomContainerProps,
    contentStyle: zoomContentStyle,
  } = usePinchZoom({
    minScale: 1,
    maxScale: 4,
    onZoomChange: handleZoomChange,
    onSingleTap: handleSingleTap,
  });

  // Cast callbacks - memoized to prevent useCast from re-initializing
  const handleCastConnect = useCallback(() => {
    console.log('[VideoPlayer] Cast/AirPlay connected');
    setCastError(null);
  }, []);
  
  const handleCastDisconnect = useCallback(() => {
    console.log('[VideoPlayer] Cast/AirPlay disconnected');
    setIsCastOverlayVisible(false);
  }, []);
  
  const handleCastError = useCallback((error: string) => {
    console.error('[VideoPlayer] Cast error:', error);
    setCastError(error);
    if (castErrorTimeoutRef.current) {
      clearTimeout(castErrorTimeoutRef.current);
    }
    // For LG/Samsung TV help messages (blue popup), don't auto-dismiss
    // These are informational and should stay until user closes or resumes video
    const isHelpMessage = error.includes('LG') || error.includes('Samsung') || 
                          error.includes('Cast tab') || error.includes('screen mirroring') ||
                          error.includes('Win + K');
    if (!isHelpMessage) {
      // Only auto-dismiss regular error messages
      castErrorTimeoutRef.current = setTimeout(() => {
        setCastError(null);
      }, 5000);
    }
  }, []);

  // Cast to TV functionality (Chromecast + AirPlay)
  const cast = useCast({
    videoRef: videoRef,
    streamUrl: streamUrl || undefined, // Pass the actual m3u8 URL for casting
    onConnect: handleCastConnect,
    onDisconnect: handleCastDisconnect,
    onError: handleCastError,
  });

  // Build cast media object
  const getCastMedia = useCallback((): CastMedia | undefined => {
    if (!streamUrl) return undefined;
    
    const episodeInfo = mediaType === 'tv' && season && episode 
      ? `S${season}E${episode}` 
      : undefined;
    
    // Convert relative URLs to absolute URLs for Chromecast
    let castUrl = streamUrl;
    if (streamUrl.startsWith('/')) {
      castUrl = `${window.location.origin}${streamUrl}`;
    }
    
    // Log the cast URL for debugging
    console.log('[VideoPlayer] Cast media URL:', castUrl.substring(0, 100));
    
    return {
      url: castUrl,
      title: title || 'Unknown Title',
      subtitle: episodeInfo,
      contentType: 'application/x-mpegURL',
      isLive: false,
      startTime: currentTime > 0 ? currentTime : undefined,
    };
  }, [streamUrl, title, mediaType, season, episode, currentTime]);

  // Handle cast button click
  const handleCastClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    
    console.log('[VideoPlayer] Cast button clicked, state:', {
      isCasting: cast.isCasting,
      isAirPlayActive: cast.isAirPlayActive,
      isConnected: cast.isConnected,
      streamUrl: streamUrl?.substring(0, 50),
    });
    
    // If already casting, stop
    if (cast.isCasting || cast.isAirPlayActive) {
      cast.stop();
      setIsCastOverlayVisible(false);
      return;
    }
    
    // If already connected, load media
    if (cast.isConnected) {
      const media = getCastMedia();
      if (media) {
        videoRef.current?.pause();
        const success = await cast.loadMedia(media);
        if (success) {
          setIsCastOverlayVisible(true);
        }
      }
      return;
    }
    
    // Try to start a cast session
    // This will show the device picker (Chromecast or AirPlay depending on browser)
    const connected = await cast.requestSession();
    console.log('[VideoPlayer] requestSession returned:', connected, 'lastError:', cast.lastError);
    
    if (connected) {
      const media = getCastMedia();
      if (media) {
        videoRef.current?.pause();
        const success = await cast.loadMedia(media);
        if (success) {
          setIsCastOverlayVisible(true);
        }
      }
    }
    
    // If there's an error from the cast hook that wasn't shown yet, show it
    // Note: The onError callback should have already set castError, but check just in case
    if (!connected && cast.lastError && !castError) {
      setCastError(cast.lastError);
      if (castErrorTimeoutRef.current) {
        clearTimeout(castErrorTimeoutRef.current);
      }
      // For LG/Samsung TV help messages (blue popup), don't auto-dismiss
      const isHelpMessage = cast.lastError.includes('LG') || cast.lastError.includes('Samsung') || 
                            cast.lastError.includes('Cast tab') || cast.lastError.includes('screen mirroring') ||
                            cast.lastError.includes('Win + K');
      if (!isHelpMessage) {
        castErrorTimeoutRef.current = setTimeout(() => {
          setCastError(null);
        }, 8000);
      }
    }
  }, [cast, getCastMedia, castError, streamUrl]);

  // Fetch sources for a specific provider
  const fetchSources = async (providerName: string, force: boolean = false): Promise<any[] | null> => {
    // GUARD: Don't fetch TMDB-dependent providers when tmdbId is 0 (MAL-direct anime)
    if (tmdbId === '0' && !['hianime', 'animekai'].includes(providerName)) {
      console.log(`[VideoPlayer] Skipping ${providerName} fetch — tmdbId=0 (MAL-direct)`);
      return null;
    }

    // Check cache first
    if (!force && sourcesCache[providerName] && sourcesCache[providerName].length > 0) {
      console.log(`[VideoPlayer] Using cached sources for ${providerName}`);
      return sourcesCache[providerName];
    }

    // Include malId in key for MAL-direct anime (tmdbId=0)
    const currentKey = malId 
      ? `mal-${malId}-${mediaType}-${episode}-${providerName}`
      : `${tmdbId}-${mediaType}-${season}-${episode}-${providerName}`;

    // Prevent duplicate fetches in StrictMode if not forcing
    // But allow fetches for different providers even if lastFetchedKey matches a previous provider
    if (!force && lastFetchedKey.current === currentKey && sourcesCache[providerName] !== undefined) {
      console.log('[VideoPlayer] Skipping duplicate fetch (already fetched)');
      return sourcesCache[providerName] || null;
    }

    lastFetchedKey.current = currentKey;

    // Set loading state for this specific provider
    setLoadingProviders(prev => ({ ...prev, [providerName]: true }));

    // Always clear error when fetching a new provider (user clicked a different tab)
    setError(null);
    
    if (providerName === provider) {
      setIsLoading(true);
    }

    try {
      // HEXA: Browser-direct extraction — browser calls hexa.su directly so
      // hexa sees the user's residential IP (no captcha needed). Same pattern as DLHD.
      if (providerName === 'flixer') {
        console.log(`[VideoPlayer] Hexa: browser-direct extraction`);
        const { extractFlixerClient } = await import('@/app/lib/services/flixer-client-extractor');
        const sources = await extractFlixerClient(tmdbId, mediaType as 'movie' | 'tv', season, episode);
        if (sources.length > 0) {
          setSourcesCache(prev => ({ ...prev, flixer: sources }));
          if (providerName === provider) {
            setAvailableSources(sources);
          }
          return sources;
        }
        throw new Error('No Hexa sources available');
      }

      // ANIME PROVIDERS: Use dedicated /api/anime/stream when malId is available
      if (malId && (providerName === 'animekai' || providerName === 'hianime')) {
        const params = new URLSearchParams({
          malId: malId.toString(),
          provider: providerName,
        });
        if (mediaType === 'tv' && episode) {
          params.append('episode', episode.toString());
        }
        console.log(`[VideoPlayer] ${providerName}: fetching via /api/anime/stream (malId=${malId})`);
        const res = await fetch(`/api/anime/stream?${params}`, { priority: 'high' as RequestPriority, cache: 'no-store' });
        const data = await res.json();

        if (data.success && data.sources?.length) {
          const sources = data.sources.filter((s: any) => s.url);
          if (sources.length > 0) {
            // Verify provider matches — don't cache cross-provider sources
            const actualProvider = data.provider || providerName;
            if (actualProvider !== providerName) {
              console.log(`[VideoPlayer] ${providerName}: API returned ${actualProvider} sources — not caching`);
              setSourcesCache(prev => ({ ...prev, [providerName]: [] }));
              return [];
            }
            setSourcesCache(prev => ({ ...prev, [providerName]: sources }));
            if (providerName === provider) {
              setAvailableSources(sources);
              const firstSource = sources[0];
              if (firstSource?.skipIntro) setSkipIntro(firstSource.skipIntro);
              if (firstSource?.skipOutro) setSkipOutro(firstSource.skipOutro);
            }
            return sources;
          }
        }
        throw new Error(data.error || `No ${providerName} sources available`);
      }

      const params = new URLSearchParams({
        tmdbId,
        type: mediaType,
        provider: providerName,
      });

      if (title) params.append('title', title);
      if (mediaType === 'tv' && season && episode) {
        params.append('season', season.toString());
        params.append('episode', episode.toString());
      }

      // Pass MAL info for anime - used by AnimeKai to get correct episode
      if (malId) {
        params.append('malId', malId.toString());
      }
      if (malTitle) {
        params.append('malTitle', malTitle);
      }

      console.log(`[VideoPlayer] Fetching sources for ${providerName}:`, `/api/stream/extract?${params}`);

      const response = await fetch(`/api/stream/extract?${params}`, {
        priority: 'high' as RequestPriority,
        cache: 'no-store', // Don't cache - URLs change frequently
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || data.error || 'Failed to load stream');
      }

      let sources: any[] = [];
      if (data.sources && Array.isArray(data.sources) && data.sources.length > 0) {
        sources = data.sources;
      } else if (data.data?.sources && Array.isArray(data.data.sources) && data.data.sources.length > 0) {
        sources = data.data.sources;
      } else if (data.url || data.streamUrl) {
        sources = [{
          quality: 'auto',
          url: data.url || data.streamUrl
        }];
      }

      if (sources.length > 0) {
        const actualProvider = data.provider || providerName;
        console.log(`[VideoPlayer] Found ${sources.length} sources for ${providerName} (actual: ${actualProvider})`);

        // IMPORTANT: Only cache sources if they're from the requested provider
        // If the API fell back to a different provider, don't show those sources in this tab
        if (actualProvider !== providerName) {
          console.log(`[VideoPlayer] API returned ${actualProvider} sources instead of ${providerName} - not caching for this tab`);
          // Cache empty array so UI shows "No sources from [provider]"
          setSourcesCache(prev => ({
            ...prev,
            [providerName]: []
          }));
          return [];
        }

        // Cache the sources under the provider name
        setSourcesCache(prev => ({
          ...prev,
          [providerName]: sources
        }));

        // If this is the active provider, update available sources and skip data
        if (providerName === provider) {
          setAvailableSources(sources);
          
          // Extract skip intro/outro data
          const firstSource = sources[0];
          if (firstSource?.skipIntro) {
            console.log('[VideoPlayer] Skip intro available from fetchSources:', firstSource.skipIntro);
            setSkipIntro(firstSource.skipIntro);
          }
          if (firstSource?.skipOutro) {
            console.log('[VideoPlayer] Skip outro available from fetchSources:', firstSource.skipOutro);
            setSkipOutro(firstSource.skipOutro);
          }
        }

        return sources;
      } else {
        throw new Error('No stream sources available');
      }
    } catch (err) {
      console.error(`[VideoPlayer] Error fetching sources for ${providerName}:`, err);
      
      // Cache empty array for this provider so UI shows "No sources available"
      // This prevents the tab from showing stale sources when the provider fails
      setSourcesCache(prev => ({
        ...prev,
        [providerName]: [] // Empty array indicates provider has no sources
      }));
      
      // Only set error if this is the active provider
      if (providerName === provider) {
        setError(err instanceof Error ? err.message : 'Failed to load video');
      }
      return null;
    } finally {
      setLoadingProviders(prev => ({ ...prev, [providerName]: false }));
      if (providerName === provider) {
        setIsLoading(false);
      }
    }
  };

  // Helper function to fetch from a specific provider
  // No pre-flight validation - let HLS.js handle it with automatic fallback
  const fetchFromProvider = async (providerName: string): Promise<{ sources: any[], provider: string } | null> => {
    // For anime with malId, use the dedicated anime stream API (supports hianime + animekai)
    if (malId && (providerName === 'animekai' || providerName === 'hianime')) {
      console.log(`[VideoPlayer] Using /api/anime/stream for malId=${malId}, provider=${providerName}`);
      
      const params = new URLSearchParams({
        malId: malId.toString(),
        provider: providerName,
      });
      
      // Only add episode for TV shows
      if (mediaType === 'tv' && episode) {
        params.append('episode', episode.toString());
      }
      
      try {
        const response = await fetch(`/api/anime/stream?${params}`, { priority: 'high' as RequestPriority, cache: 'no-store' });
        const data = await response.json();

        if (data.success && data.sources && data.sources.length > 0) {
          const activeProvider = data.provider || providerName;
          console.log(`[VideoPlayer] ✓ ${activeProvider} (anime stream API) returned ${data.sources.length} sources`);
          if (data.sources[0]?.skipIntro || data.sources[0]?.skipOutro) {
            console.log(`[VideoPlayer] Skip data in response:`, {
              skipIntro: data.sources[0].skipIntro,
              skipOutro: data.sources[0].skipOutro,
            });
          }
          return { sources: data.sources, provider: activeProvider };
        }
        
        console.warn(`[VideoPlayer] ✗ ${providerName} (anime stream API) failed:`, data.error);
        return null;
      } catch (err) {
        console.error(`[VideoPlayer] ✗ ${providerName} (anime stream API) network error:`, err);
        return null;
      }
    }
    
    // HEXA: Browser-direct extraction (fallback path)
    if (providerName === 'flixer') {
      console.log(`[VideoPlayer] Hexa: browser-direct extraction (fallback path)`);
      try {
        const { extractFlixerClient } = await import('@/app/lib/services/flixer-client-extractor');
        const sources = await extractFlixerClient(tmdbId, mediaType as 'movie' | 'tv', season, episode);
        if (sources.length > 0) {
          console.log(`[VideoPlayer] ✓ Hexa returned ${sources.length} source(s)`);
          return { sources, provider: 'flixer' };
        }
        console.warn('[VideoPlayer] ✗ Hexa returned no sources');
        return null;
      } catch (err) {
        console.error('[VideoPlayer] ✗ Hexa error:', err);
        return null;
      }
    }

    // For non-flixer providers, use the generic extract API
    const params = new URLSearchParams({
      tmdbId,
      type: mediaType,
      provider: providerName,
    });

    if (title) params.append('title', title);
    if (mediaType === 'tv' && season && episode) {
      params.append('season', season.toString());
      params.append('episode', episode.toString());
    }
    
    // Pass MAL info for anime - critical for AnimeKai to get correct episode
    if (malId) {
      params.append('malId', malId.toString());
      console.log(`[VideoPlayer] Including malId=${malId} in request to ${providerName}`);
    }
    if (malTitle) {
      params.append('malTitle', malTitle);
    }

    console.log(`[VideoPlayer] Fetching from ${providerName}...${malId ? ` (malId=${malId})` : ''}`);

    try {
      const response = await fetch(`/api/stream/extract?${params}`, { priority: 'high' as RequestPriority, cache: 'no-store' });
      const data = await response.json();

      if (data.sources && data.sources.length > 0) {
        // Use the actual provider from response (may differ due to fallback)
        const actualProvider = data.provider || providerName;
        console.log(`[VideoPlayer] ✓ ${providerName} returned ${data.sources.length} sources (actual provider: ${actualProvider})`);
        // Debug: Log skip data from first source
        if (data.sources[0]?.skipIntro || data.sources[0]?.skipOutro) {
          console.log(`[VideoPlayer] Skip data in response:`, {
            skipIntro: data.sources[0].skipIntro,
            skipOutro: data.sources[0].skipOutro,
          });
        }
        return { sources: data.sources, provider: actualProvider };
      }
      
      // Log detailed error info for debugging
      console.warn(`[VideoPlayer] ✗ ${providerName} failed:`, {
        error: data.error,
        details: data.details,
        suggestion: data.suggestion,
        status: response.status
      });
      return null;
    } catch (err) {
      console.error(`[VideoPlayer] ✗ ${providerName} network error:`, err);
      return null;
    }
  };

  // Debug: Log sub/dub toggle visibility conditions
  useEffect(() => {
    console.log(`[VideoPlayer] Sub/Dub toggle conditions: isAnimeContent=${isAnimeContent}, provider=${provider}, shouldShow=${isAnimeContent && (provider === 'animekai' || provider === 'hianime')}`);
    if (isAnimeContent && provider !== 'animekai' && provider !== 'hianime') {
      console.warn(`[VideoPlayer] ⚠️ Anime content detected but provider is "${provider}" not "animekai" - toggle will NOT show!`);
    }
  }, [isAnimeContent, provider]);

  // Initial fetch with automatic provider fallback
  useEffect(() => {
    // Reset subtitle auto-load flag for new video
    subtitlesAutoLoadedRef.current = false;
    hasShownResumePromptRef.current = false;
    shouldShowResumePromptRef.current = false; // Reset resume prompt check
    triedProvidersRef.current.clear(); // Reset tried providers for new content
    
    // Check early if we'll need to show resume prompt (to prevent autoplay)
    if (!isAutoplayNavigationRef.current) {
      const savedTime = loadProgress();
      // We'll show resume prompt if there's saved progress (will be validated against duration later)
      if (savedTime > 30) {
        shouldShowResumePromptRef.current = true;
        console.log('[VideoPlayer] Will show resume prompt, skipping autoplay');
      }
    }

    // Clear cache when content changes
    setSourcesCache({});
    
    // Reset lastFetchedKey to allow fresh fetch
    lastFetchedKey.current = '';
    setLoadingProviders({});
    setIsLoading(true);
    setError(null);
    setHighlightServerButton(false);
    setStreamUrl(null);
    setIsAnimeContent(false); // Reset anime detection for new content
    
    // Reset skip intro/outro state when content changes
    setSkipIntro(null);
    setSkipOutro(null);
    setShowSkipIntroButton(false);
    setShowSkipOutroButton(false);
    
    // Reset next episode state when content changes (prevents auto-skip bug)
    setShowNextEpisodeButton(false);
    setAutoPlayCountdownState(null);
    hasNavigatedToNextRef.current = false; // Reset navigation flag for new content
    if (autoPlayTimerRef.current) {
      clearTimeout(autoPlayTimerRef.current);
      autoPlayTimerRef.current = null;
    }

    let cancelled = false;

    const initializePlayer = async () => {
      // ================================================================
      // SEQUENTIAL PROVIDER FETCH (same approach as mobile player)
      // Try providers one at a time in priority order.
      // First source with a valid URL wins. Move on after 1s timeout.
      // ================================================================

      const isAnime = !!malId;
      setIsAnimeContent(isAnime);

      // Non-blocking background fetches
      fetch('/api/providers').then(async res => {
        try {
          const data = await res.json();
          setProviderAvailability({
            videasy: data.providers?.videasy?.enabled ?? true,
            flixer: data.providers?.flixer?.enabled ?? true,
            uflix: false,
            hexa: false,
            vidsrc: false,
            '1movies': false,
            animekai: data.providers?.animekai?.enabled ?? true,
            hianime: data.providers?.hianime?.enabled ?? true,
          });
        } catch {}
      }).catch(() => {});

      if (!isAnime) {
        fetch(`/api/content/check-anime?tmdbId=${tmdbId}&type=${mediaType}`)
          .then(async res => { if (res.ok) { const d = await res.json(); if (d.isAnime) setIsAnimeContent(true); } })
          .catch(() => {});
      }

      // Build provider priority order (user preferences respected)
      const userProviderSettings = getProviderSettings();
      const userOrder = userProviderSettings.providerOrder || [];
      const disabledProviders = new Set(userProviderSettings.disabledProviders || []);

      const isMalDirect = tmdbId === '0' || (isAnime && (!tmdbId || tmdbId === '0'));
      const defaultOrder: string[] = isAnime
        ? (isMalDirect
          ? ['hianime', 'animekai']
          : ['hianime', 'animekai', 'flixer'])
        : ['videasy', 'flixer'];

      const priorityOrder: string[] = [];
      for (const p of userOrder) {
        if (!disabledProviders.has(p) && defaultOrder.includes(p) && !priorityOrder.includes(p)) {
          priorityOrder.push(p);
        }
      }
      for (const p of defaultOrder) {
        if (!disabledProviders.has(p) && !priorityOrder.includes(p)) {
          priorityOrder.push(p);
        }
      }

      console.log(`[VideoPlayer] Sequential fetch: [${priorityOrder.join(' → ')}]`);
      setProviderTabOrder([...priorityOrder]);

      const contentKey = `${tmdbId}-${mediaType}${season ? `-s${season}` : ''}${episode ? `-e${episode}` : ''}`;

      // Helper: fetch with a timeout — resolves null if too slow
      const fetchWithTimeout = (url: string, timeoutMs: number): Promise<Response | null> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        return fetch(url, { cache: 'no-store', signal: controller.signal })
          .then(res => { clearTimeout(timer); return res; })
          .catch(() => { clearTimeout(timer); return null; });
      };

      // Helper: build API URL for a provider
      const buildApiUrl = (providerName: string): string | null => {
        if (isMalDirect && !['hianime', 'animekai'].includes(providerName)) return null;
        if (isAnime && malId && (providerName === 'animekai' || providerName === 'hianime')) {
          const params = new URLSearchParams({ malId: malId.toString(), provider: providerName });
          if (mediaType === 'tv' && episode) params.append('episode', episode.toString());
          return `/api/anime/stream?${params}`;
        }
        const params = new URLSearchParams({ tmdbId, type: mediaType, provider: providerName });
        if (mediaType === 'tv' && season && episode) {
          params.append('season', season.toString());
          params.append('episode', episode.toString());
        }
        if (malId) params.append('malId', malId.toString());
        if (malTitle) params.append('malTitle', malTitle);
        return `/api/stream/extract?${params}`;
      };

      // ---- FIRE ALL PROVIDERS IN PARALLEL, USE FIRST SUCCESS ----
      // Each provider races independently. First one to return valid sources wins.
      // This avoids waiting 5-7s for a failing provider before trying the next one.
      type ProviderResult = { providerName: string; data: any; sources: any[] };

      const providerPromises = priorityOrder.map(async (providerName): Promise<ProviderResult> => {
        // Flixer: use browser-direct extraction via CF Worker
        if (providerName === 'flixer') {
          console.log(`[VideoPlayer] Trying flixer (browser-direct)...`);
          const { extractFlixerClient } = await import('@/app/lib/services/flixer-client-extractor');
          const sources = await extractFlixerClient(tmdbId, mediaType as 'movie' | 'tv', season, episode);
          if (sources.length === 0) throw new Error('flixer: no sources');
          console.log(`[VideoPlayer] ✓ flixer: ${sources.length} source(s)`);
          return { providerName: 'flixer', data: { success: true, provider: 'flixer' }, sources };
        }

        // Videasy: browser-direct extraction via CF Worker (backup source)
        if (providerName === 'videasy') {
          console.log(`[VideoPlayer] Trying videasy (browser-direct)...`);
          const { extractVideasyClient } = await import('@/app/lib/services/videasy-client-extractor');
          const sources = await extractVideasyClient(tmdbId, mediaType as 'movie' | 'tv', title || '', season, episode);
          if (sources.length === 0) throw new Error('videasy: no sources');
          console.log(`[VideoPlayer] ✓ videasy: ${sources.length} source(s)`);
          return { providerName: 'videasy', data: { success: true, provider: 'videasy' }, sources };
        }

        const apiUrl = buildApiUrl(providerName);
        if (!apiUrl) throw new Error(`${providerName}: skipped (MAL-direct)`);

        console.log(`[VideoPlayer] Trying ${providerName}...`);
        const res = await fetchWithTimeout(apiUrl, 15000);
        if (!res || !res.ok) throw new Error(`${providerName}: ${res ? res.status : 'timeout'}`);

        const data = await res.json();
        const sources = data.sources?.filter((s: any) => s.url && s.url.length > 0) || [];
        if (sources.length === 0) throw new Error(`${providerName}: no sources`);

        // Verify the provider didn't return a different provider's sources
        const actualProvider = data.provider || providerName;
        if (actualProvider !== providerName) {
          throw new Error(`${providerName}: API returned ${actualProvider} instead`);
        }

        console.log(`[VideoPlayer] ✓ ${providerName}: ${sources.length} source(s)`);
        return { providerName, data, sources };
      });

      // Use Promise.any — first provider to resolve with sources wins
      try {
        const winner = await Promise.any(providerPromises);
        if (cancelled) return;

        const { providerName, sources } = winner;

        // Pick best source — prefer 'validated' status, then any with a URL
        const validatedIdx = sources.findIndex((s: any) => s.url && s.status === 'validated');
        const workingIdx = validatedIdx >= 0 ? validatedIdx : sources.findIndex((s: any) => s.url && s.status !== 'unknown');
        let selectedSource = sources[workingIdx >= 0 ? workingIdx : 0];
        let selectedIndex = workingIdx >= 0 ? workingIdx : 0;

        if (isAnime && (providerName === 'animekai' || providerName === 'hianime')) {
          const audioPref = userProviderSettings.animeAudioPreference || 'sub';
          const matchIdx = sources.findIndex((s: any) =>
            s.title && sourceMatchesAudioPreference(s.title, audioPref)
          );
          if (matchIdx >= 0) {
            selectedSource = sources[matchIdx];
            selectedIndex = matchIdx;
          }
        }

        console.log(`[VideoPlayer] ✓ ${providerName}: playing "${selectedSource.title}" — ${selectedSource.url?.substring(0, 80)}`);

        setProvider(providerName);
        setMenuProvider(providerName);
        recordSuccessfulProvider(contentKey, providerName);
        setSourcesCache(prev => ({ ...prev, [providerName]: sources }));
        setAvailableSources(sources);
        setCurrentSourceIndex(selectedIndex);

        if (selectedSource.skipIntro) setSkipIntro(selectedSource.skipIntro);
        if (selectedSource.skipOutro) setSkipOutro(selectedSource.skipOutro);

        if (isAnime && selectedSource.title && (providerName === 'animekai' || providerName === 'hianime')) {
          const actualPref = sourceMatchesAudioPreference(selectedSource.title, 'dub') ? 'dub' : 'sub';
          const savedPref = userProviderSettings.animeAudioPreference || 'sub';
          if (actualPref !== savedPref) setAnimeAudioPref(actualPref as AnimeAudioPreference);
        }

        setStreamUrl(applyStreamProxy(selectedSource.url, providerName, selectedSource.requiresSegmentProxy));
        setIsLoading(false);

        // Collect remaining sources in background (for source picker)
        Promise.allSettled(providerPromises).then(results => {
          if (cancelled) return;
          for (const r of results) {
            if (r.status === 'fulfilled' && r.value.providerName !== providerName) {
              setSourcesCache(prev => ({ ...prev, [r.value.providerName]: r.value.sources }));
            }
          }
        });

        return;
      } catch (aggregateError) {
        // All providers failed
        if (cancelled) return;
        const errors = (aggregateError as AggregateError).errors || [];
        for (const e of errors) {
          console.warn(`[VideoPlayer] ${e.message || e}`);
        }
      }

      // All providers exhausted
      if (!cancelled) {
        console.error('[VideoPlayer] All providers failed');
        setError('No streams available from any provider');
        setIsLoading(false);
        setHighlightServerButton(true);
      }
    };

    initializePlayer();

    return () => {
      cancelled = true; // Prevent stale updates from React Strict Mode double-mount
    };
  // IMPORTANT: Include malId in dependencies for MAL-direct anime (tmdbId=0)
  // Without this, switching between different MAL anime won't trigger a re-fetch
  }, [tmdbId, mediaType, season, episode, malId]);

  // Initialize HLS
  useEffect(() => {
    if (!streamUrl || !videoRef.current) {
      return;
    }

    const video = videoRef.current;
    console.log('[VideoPlayer] Initializing HLS with URL:', streamUrl);
    
    // Reset source confirmation flag for new stream
    sourceConfirmedWorkingRef.current = false;
    playbackStartedRef.current = false;
    
    // Clear any previous playback start timeout
    if (playbackStartTimeoutRef.current) {
      clearTimeout(playbackStartTimeoutRef.current);
      playbackStartTimeoutRef.current = null;
    }
    
    // Auto-advance: if playback doesn't start within 5s, try next source in the list
    const startPlaybackTimeout = () => {
      playbackStartTimeoutRef.current = setTimeout(() => {
        if (playbackStartedRef.current) return; // Already playing, ignore
        
        console.log(`[VideoPlayer] Source ${currentSourceIndex} didn't start within 5s, auto-advancing...`);
        
        // Save position before switching
        if (video.currentTime > 0 && pendingSeekTimeRef.current === null) {
          pendingSeekTimeRef.current = video.currentTime;
        }
        
        // Mark current source as down (never started playing)
        setAvailableSources(prev => {
          const updated = [...prev];
          if (updated[currentSourceIndex]) {
            updated[currentSourceIndex] = { ...updated[currentSourceIndex], status: 'down' };
            setSourcesCache(prevCache => ({ ...prevCache, [provider]: updated }));
          }
          return updated;
        });
        
        // Try next source in the same provider's list (skip sources without URLs)
        let nextIdx = currentSourceIndex + 1;
        while (nextIdx < availableSources.length && !availableSources[nextIdx]?.url) {
          nextIdx++;
        }
        if (nextIdx < availableSources.length && availableSources[nextIdx]?.url) {
          console.log(`[VideoPlayer] Auto-advancing to source ${nextIdx}: ${availableSources[nextIdx].title}`);
          setCurrentSourceIndex(nextIdx);
          setStreamUrl(applyStreamProxy(availableSources[nextIdx].url, provider, availableSources[nextIdx].requiresSegmentProxy));
        } else {
          console.log('[VideoPlayer] No more sources in current provider, exhausted');
          // Let the existing error handling / provider fallback take over
        }
      }, 5000);
    };
    
    // Listen for the 'playing' event to cancel the timeout
    const onPlaying = () => {
      if (!playbackStartedRef.current) {
        playbackStartedRef.current = true;
        if (playbackStartTimeoutRef.current) {
          clearTimeout(playbackStartTimeoutRef.current);
          playbackStartTimeoutRef.current = null;
        }
      }
    };
    video.addEventListener('playing', onPlaying);

    if (streamUrl.includes('.m3u8') || streamUrl.includes('stream-proxy') || streamUrl.includes('/stream/') || streamUrl.includes('/animekai') || streamUrl.includes('/flixer/stream') || streamUrl.includes('/hianime') || streamUrl.includes('/vidsrc') || streamUrl.includes('workers.dev')) {
      if (Hls.isSupported()) {
        // Check if this is a Hexa source (needs more aggressive buffering)
        const isFlixerSource = streamUrl.includes('flixer') || streamUrl.includes('p.10015.workers.dev') || streamUrl.includes('afc7d47f');
        
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false, // Disable low latency for VOD - improves buffering
          backBufferLength: 90,
          // Increase buffer sizes for Hexa sources to handle variable speeds
          maxBufferLength: isFlixerSource ? 60 : 30,
          maxMaxBufferLength: isFlixerSource ? 120 : 60,
          maxBufferSize: isFlixerSource ? 120 * 1000 * 1000 : 60 * 1000 * 1000,
          maxBufferHole: 0.5,
          highBufferWatchdogPeriod: 2,
          nudgeOffset: 0.1,
          nudgeMaxRetry: 5, // Increase retry count
          manifestLoadingTimeOut: 10000,
          manifestLoadingMaxRetry: 2,
          manifestLoadingRetryDelay: 300,
          levelLoadingTimeOut: 10000,
          levelLoadingMaxRetry: 2,
          fragLoadingTimeOut: 20000, // Segments can be large
          fragLoadingMaxRetry: 4,
          fragLoadingRetryDelay: 500,
          startLevel: -1, // Auto-select quality
          // ABR settings for better quality adaptation
          abrEwmaDefaultEstimate: 1000000, // 1 Mbps default estimate
          abrBandWidthFactor: 0.8, // Be more conservative with bandwidth
          abrBandWidthUpFactor: 0.5, // Slower to upgrade quality
          abrMaxWithRealBitrate: true,
          // @ts-ignore
          xhrSetup: (xhr: any, url: any) => {
            xhr.withCredentials = false;
          },
        } as any);

        console.log('[HLS] Created HLS instance, loading source...');
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        console.log('[HLS] Source loaded and media attached');
        
        // Start the 10s auto-advance timeout (skip dead sources)
        if (!shouldShowResumePromptRef.current) {
          startPlaybackTimeout();
        }

        // HLS events - minimal logging to avoid performance issues
        hls.on(Hls.Events.MANIFEST_LOADED, (_event, data) => {
          console.log('[HLS] Manifest loaded:', data.levels?.length, 'levels');
        });

        hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
          // Only log first few fragments to avoid console spam
          const fragSn = typeof data.frag?.sn === 'number' ? data.frag.sn : -1;
          if (fragSn >= 0 && fragSn < 3) {
            console.log('[HLS] Fragment loaded:', fragSn, 'bytes:', data.payload?.byteLength);
          }
          
          // Mark current source as confirmed working when first fragment loads (only once)
          if ((fragSn === 0 || fragSn === 1) && !sourceConfirmedWorkingRef.current) {
            sourceConfirmedWorkingRef.current = true;
            setAvailableSources(prev => {
              const updated = [...prev];
              if (updated[currentSourceIndex] && updated[currentSourceIndex].status !== 'working') {
                console.log(`[VideoPlayer] Confirming source ${currentSourceIndex} (${updated[currentSourceIndex].title}) as WORKING`);
                updated[currentSourceIndex] = { ...updated[currentSourceIndex], status: 'working' };
                setSourcesCache(prevCache => ({ ...prevCache, [provider]: updated }));
              }
              return updated;
            });
          }
        });

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          // Signal to initializePlayer that this source is playable
          if (sourceReadyResolverRef.current) {
            sourceReadyResolverRef.current();
            sourceReadyResolverRef.current = null;
          }
          
          // Extract available quality levels
          if (hls.levels && hls.levels.length > 0) {
            const levels = hls.levels.map((level, index) => ({
              height: level.height || 0,
              bitrate: level.bitrate || 0,
              index
            })).filter(l => l.height > 0).sort((a, b) => b.height - a.height);
            
            // Remove duplicates by height
            const uniqueLevels = levels.filter((level, idx, arr) => 
              arr.findIndex(l => l.height === level.height) === idx
            );
            
            setHlsLevels(uniqueLevels);
            console.log('[VideoPlayer] HLS quality levels:', uniqueLevels);
          }
          
          // Restore playback position if switching sources
          if (pendingSeekTimeRef.current !== null && pendingSeekTimeRef.current > 0) {
            const seekTime = pendingSeekTimeRef.current;
            console.log('[VideoPlayer] Restoring playback position:', seekTime);
            video.currentTime = seekTime;
            pendingSeekTimeRef.current = null;
          }
          
          // Restore playback speed if not default
          if (playbackSpeed !== 1) {
            console.log('[VideoPlayer] Restoring playback speed:', playbackSpeed);
            video.playbackRate = playbackSpeed;
          }
          
          // Restore subtitles if they were active
          if (currentSubtitleDataRef.current) {
            console.log('[VideoPlayer] Restoring subtitle:', currentSubtitleDataRef.current.language);
            setTimeout(() => {
              loadSubtitle(currentSubtitleDataRef.current, subtitleOffset);
            }, 100);
          } else if (currentSubtitle && availableSubtitles.length > 0) {
            const currentSub = availableSubtitles.find(sub => sub.id === currentSubtitle);
            if (currentSub) {
              setTimeout(() => {
                loadSubtitle(currentSub);
              }, 100);
            }
          }
          // Only autoplay if resume prompt won't be shown
          if (!shouldShowResumePromptRef.current) {
            // Apply saved volume BEFORE play attempt so browser sees correct state
            video.volume = getSavedVolume();
            video.muted = getSavedMuteState();
            video.play().catch(e => {
              console.log('[VideoPlayer] Autoplay prevented, trying muted:', e);
              // Browser blocked unmuted autoplay — try muted, then unmute on first interaction
              video.muted = true;
              video.play().then(() => {
                console.log('[VideoPlayer] Muted autoplay succeeded');
                // Unmute on first user interaction
                const unmute = () => {
                  video.muted = getSavedMuteState();
                  video.volume = getSavedVolume();
                  document.removeEventListener('click', unmute);
                  document.removeEventListener('keydown', unmute);
                };
                document.addEventListener('click', unmute, { once: true });
                document.addEventListener('keydown', unmute, { once: true });
              }).catch(e2 => console.log('[VideoPlayer] Muted autoplay also prevented:', e2));
            });
          } else {
            console.log('[VideoPlayer] Skipping autoplay - resume prompt will be shown');
          }
        });

        // Track current level changes
        hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
          const level = hls.levels[data.level];
          if (level && level.height) {
            setCurrentResolution(`${level.height}p`);
          }
        });

        hls.on(Hls.Events.ERROR, async (_event, data) => {
          // Use console.warn for non-fatal errors to avoid triggering Next.js dev overlay
          const logFn = data.fatal ? console.error : console.warn;
          logFn('[HLS] Error:', {
            type: data.type,
            details: data.details,
            fatal: data.fatal,
            url: data.url,
            response: data.response,
            reason: data.reason,
            frag: data.frag ? { sn: data.frag.sn, url: data.frag.url } : null,
          });
          
          // Log the actual response if available
          if (data.response) {
            logFn('[HLS] Response details:', {
              code: data.response.code,
              text: data.response.text,
            });
          }
          
          if (data.fatal) {
            // Shared fallback: save position + mark source down + try next
            const prepareAndFallback = () => {
              setIsLoading(true);
              setError(null);
              if (video.currentTime > 0 && pendingSeekTimeRef.current === null) {
                pendingSeekTimeRef.current = video.currentTime;
                console.log('[VideoPlayer] Saving position before fallback:', pendingSeekTimeRef.current);
              }
              if (!sourceConfirmedWorkingRef.current) {
                setAvailableSources(prevSources => {
                  const updatedSources = [...prevSources];
                  if (updatedSources[currentSourceIndex]) {
                    console.log(`[VideoPlayer] Marking source ${currentSourceIndex} (${updatedSources[currentSourceIndex].title}) as DOWN`);
                    updatedSources[currentSourceIndex] = { ...updatedSources[currentSourceIndex], status: 'down' };
                    setSourcesCache(prev => ({ ...prev, [provider]: updatedSources }));
                  }
                  return updatedSources;
                });
              }
            };

            // Try to find and fetch the next available source (shared by all fatal error handlers)
            const tryNextSource = async () => {
                  // Use ref for fresh data — closure captures stale state
                  const currentSources = availableSourcesRef.current;
                  const currentIdx = currentSourceIndex;
                  
                  // Look for next source to try
                  for (let i = currentIdx + 1; i < currentSources.length; i++) {
                    const nextSource = currentSources[i];
                    
                    // Skip null/undefined sources
                    if (!nextSource) continue;
                    
                    // If source has a URL, use it directly
                    if (nextSource.url && nextSource.url !== '') {
                      console.log(`[VideoPlayer] Trying source ${i}: ${nextSource.title} (has URL)`);
                      setCurrentSourceIndex(i);
                      setStreamUrl(applyStreamProxy(nextSource.url, provider, nextSource.requiresSegmentProxy));
                      // Sync toggle if switching to a different sub/dub source
                      // NOTE: Don't save to persistent storage — this is an automatic fallback,
                      // not a user choice. The user's saved preference should be preserved.
                      if (isAnimeContent && nextSource.title) {
                        const actualPref = sourceMatchesAudioPreference(nextSource.title, 'dub') ? 'dub' : 'sub';
                        if (actualPref !== animeAudioPref) {
                          setAnimeAudioPref(actualPref as AnimeAudioPreference);
                        }
                      }
                      return true;
                    }
                    
                    // Source doesn't have URL - need to fetch it from API
                    if (nextSource.title && (provider === 'uflix' || provider === 'animekai' || provider === 'hianime' || provider === 'flixer')) {
                      console.log(`[VideoPlayer] Fetching source ${i}: ${nextSource.title}...`);
                      
                      const sourceName = nextSource.title.split(' (')[0];
                      
                      try {
                        const params = new URLSearchParams({
                          tmdbId,
                          type: mediaType,
                          provider,
                          source: sourceName,
                        });
                        
                        if (mediaType === 'tv' && season && episode) {
                          params.append('season', season.toString());
                          params.append('episode', episode.toString());
                        }
                        
                        const response = await fetch(`/api/stream/extract?${params}`);
                        const data = await response.json();
                        
                        if (data.sources && data.sources[0]?.url) {
                          console.log(`[VideoPlayer] ✓ ${sourceName} fetched successfully`);
                          
                          setAvailableSources(prev => {
                            const updatedSources = [...prev];
                            updatedSources[i] = { ...updatedSources[i], ...data.sources[0], status: 'working' };
                            setSourcesCache(prevCache => ({ ...prevCache, [provider]: updatedSources }));
                            return updatedSources;
                          });
                          
                          setCurrentSourceIndex(i);
                          setStreamUrl(applyStreamProxy(data.sources[0].url, provider, data.sources[0].requiresSegmentProxy));
                          return true;
                        } else {
                          console.log(`[VideoPlayer] ✗ ${sourceName} failed, trying next...`);
                          setAvailableSources(prev => {
                            const updatedSources = [...prev];
                            updatedSources[i] = { ...updatedSources[i], status: 'down' };
                            setSourcesCache(prevCache => ({ ...prevCache, [provider]: updatedSources }));
                            return updatedSources;
                          });
                        }
                      } catch (err) {
                        console.error(`[VideoPlayer] Error fetching ${sourceName}:`, err);
                      }
                    }
                  }
                  
                  // No more sources in current provider, try other providers
                  // Order: vidsrc → flixer → 1movies → uflix
                  console.log(`[VideoPlayer] All ${provider} sources exhausted, trying other providers...`);
                  
                  const fallbackProviders: string[] = [];
                  // For anime providers, try the other anime provider first
                  if ((provider === 'animekai' || provider === 'hianime') && isAnimeContent) {
                    if (provider !== 'hianime' && providerAvailability.hianime) fallbackProviders.push('hianime');
                    if (provider !== 'animekai' && providerAvailability.animekai) fallbackProviders.push('animekai');
                  }
                  if (provider !== 'videasy' && providerAvailability.videasy) fallbackProviders.push('videasy');
                  if (provider !== 'flixer' && providerAvailability.flixer) fallbackProviders.push('flixer');

                  for (const fallbackProvider of fallbackProviders) {
                    if (triedProvidersRef.current.has(fallbackProvider)) continue;
                    
                    console.log(`[VideoPlayer] Trying fallback: ${fallbackProvider}`);
                    triedProvidersRef.current.add(fallbackProvider);
                    
                    const result = await fetchFromProvider(fallbackProvider);
                    if (result && result.sources.length > 0 && result.sources[0].url) {
                      console.log(`[VideoPlayer] ✓ ${fallbackProvider} works!`);
                      setProvider(fallbackProvider);
                      setMenuProvider(fallbackProvider);
                      setSourcesCache(prev => ({ ...prev, [fallbackProvider]: result.sources }));
                      setAvailableSources(result.sources);
                      setCurrentSourceIndex(0);
                      setStreamUrl(applyStreamProxy(result.sources[0].url, fallbackProvider, result.sources[0].requiresSegmentProxy));
                      // Sync toggle to match what's actually playing after fallback
                      // NOTE: Don't save to persistent storage — this is an automatic fallback,
                      // not a user choice. The user's saved preference should be preserved.
                      if (isAnimeContent && result.sources[0].title) {
                        const actualPref = sourceMatchesAudioPreference(result.sources[0].title, 'dub') ? 'dub' : 'sub';
                        if (actualPref !== animeAudioPref) {
                          setAnimeAudioPref(actualPref as AnimeAudioPreference);
                        }
                      }
                      return true;
                    }
                  }
                  
              return false;
            };

            const handleFatalWithFallback = (errorLabel: string) => {
              prepareAndFallback();
              tryNextSource().then(found => {
                if (!found) {
                  setIsLoading(false);
                  setError(`${errorLabel}. Try selecting a different server.`);
                  setHighlightServerButton(true);
                }
              });
            };

            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                console.error('[HLS] Fatal network error, trying next source...', data);
                handleFatalWithFallback('All sources failed');
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                console.error('[HLS] Fatal media error, attempting recovery...', data);
                hls.recoverMediaError();
                break;
              default:
                console.error('[HLS] Fatal error (other), trying next source...', data.type, data.details);
                handleFatalWithFallback('Fatal error loading video');
                break;
            }
          }
        });

        hlsRef.current = hls;

        return () => {
          hls.destroy();
          video.removeEventListener('playing', onPlaying);
          if (playbackStartTimeoutRef.current) {
            clearTimeout(playbackStartTimeoutRef.current);
            playbackStartTimeoutRef.current = null;
          }
        };
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = streamUrl;
        // Start auto-advance timeout for Safari native HLS
        if (!shouldShowResumePromptRef.current) {
          startPlaybackTimeout();
        }
        video.addEventListener('loadedmetadata', () => {
          // Restore playback position if switching sources
          if (pendingSeekTimeRef.current !== null && pendingSeekTimeRef.current > 0) {
            console.log('[VideoPlayer] Restoring position (Safari):', pendingSeekTimeRef.current);
            video.currentTime = pendingSeekTimeRef.current;
            pendingSeekTimeRef.current = null;
          }
          // Restore playback speed if not default
          if (playbackSpeed !== 1) {
            video.playbackRate = playbackSpeed;
          }
          // Restore subtitles
          if (currentSubtitleDataRef.current) {
            setTimeout(() => loadSubtitle(currentSubtitleDataRef.current, subtitleOffset), 100);
          }
          // Only autoplay if resume prompt won't be shown
          if (!shouldShowResumePromptRef.current) {
            video.volume = getSavedVolume();
            video.muted = getSavedMuteState();
            video.play().catch(e => {
              console.log('[VideoPlayer] Autoplay prevented (Safari), trying muted:', e);
              video.muted = true;
              video.play().then(() => {
                const unmute = () => { video.muted = getSavedMuteState(); video.volume = getSavedVolume(); document.removeEventListener('click', unmute); document.removeEventListener('keydown', unmute); };
                document.addEventListener('click', unmute, { once: true });
                document.addEventListener('keydown', unmute, { once: true });
              }).catch(() => {});
            });
          } else {
            console.log('[VideoPlayer] Skipping autoplay (Safari) - resume prompt will be shown');
          }
        });
        return () => {
          video.removeEventListener('playing', onPlaying);
          if (playbackStartTimeoutRef.current) {
            clearTimeout(playbackStartTimeoutRef.current);
            playbackStartTimeoutRef.current = null;
          }
        };
      }
    } else {
      video.src = streamUrl;
      // Start auto-advance timeout for native video
      if (!shouldShowResumePromptRef.current) {
        startPlaybackTimeout();
      }
      video.addEventListener('loadedmetadata', () => {
        // Restore playback position if switching sources
        if (pendingSeekTimeRef.current !== null && pendingSeekTimeRef.current > 0) {
          console.log('[VideoPlayer] Restoring position (native):', pendingSeekTimeRef.current);
          video.currentTime = pendingSeekTimeRef.current;
          pendingSeekTimeRef.current = null;
        }
        // Restore playback speed if not default
        if (playbackSpeed !== 1) {
          video.playbackRate = playbackSpeed;
        }
        // Restore subtitles
        if (currentSubtitleDataRef.current) {
          setTimeout(() => loadSubtitle(currentSubtitleDataRef.current, subtitleOffset), 100);
        }
        // Only autoplay if resume prompt won't be shown
        if (!shouldShowResumePromptRef.current) {
          video.volume = getSavedVolume();
          video.muted = getSavedMuteState();
          video.play().catch(e => {
            console.log('[VideoPlayer] Autoplay prevented (native), trying muted:', e);
            video.muted = true;
            video.play().then(() => {
              const unmute = () => { video.muted = getSavedMuteState(); video.volume = getSavedVolume(); document.removeEventListener('click', unmute); document.removeEventListener('keydown', unmute); };
              document.addEventListener('click', unmute, { once: true });
              document.addEventListener('keydown', unmute, { once: true });
            }).catch(() => {});
          });
        } else {
          console.log('[VideoPlayer] Skipping autoplay (native) - resume prompt will be shown');
        }
      });
      return () => {
        video.removeEventListener('playing', onPlaying);
        if (playbackStartTimeoutRef.current) {
          clearTimeout(playbackStartTimeoutRef.current);
          playbackStartTimeoutRef.current = null;
        }
      };
    }
  }, [streamUrl]);

  // Fetch subtitles when content changes
  useEffect(() => {
    if (subtitlesFetchedRef.current) return;
    subtitlesFetchedRef.current = true;

    const getImdbId = async () => {
      try {
        // Skip TMDB lookup for MAL-direct anime (tmdbId=0)
        if (tmdbId === '0') {
          console.log('[VideoPlayer] Skipping IMDB lookup for MAL-direct anime (tmdbId=0)');
          return;
        }
        
        const apiKey = process.env.NEXT_PUBLIC_TMDB_API_KEY;
        if (!apiKey) return;

        const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/external_ids?api_key=${apiKey}`;
        const response = await fetch(url);
        const data = await response.json();

        if (data.imdb_id) {
          await fetchSubtitles(data.imdb_id);
        }
      } catch (err) {
        console.error('[VideoPlayer] Failed to get IMDB ID:', err);
      }
    };

    getImdbId();
  }, [tmdbId, mediaType, season, episode]);

  // Video event handlers
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePlay = () => {
      setIsPlaying(true);
      // Clear cast error when video resumes playing locally
      if (castError) {
        setCastError(null);
        if (castErrorTimeoutRef.current) {
          clearTimeout(castErrorTimeoutRef.current);
        }
      }
      if (video.currentTime === 0) {
        handleWatchStart(video.currentTime, video.duration);
        trackWatchStart(tmdbId, title || 'Unknown Title', mediaType, season, episode);
      } else {
        handleWatchResume(video.currentTime, video.duration);
      }
      // Update presence to "watching"
      presenceContext?.setActivityType('watching', {
        contentId: tmdbId,
        contentTitle: title,
        contentType: mediaType,
        seasonNumber: season,
        episodeNumber: episode,
      });
      trackInteraction({
        element: 'video_player',
        action: 'click',
        context: {
          action_type: 'play',
          contentId: tmdbId,
          contentType: mediaType,
          contentTitle: title,
          currentTime: video.currentTime,
          seasonNumber: season,
          episodeNumber: episode,
        },
      });
    };

    const handlePause = () => {
      setIsPlaying(false);
      handleWatchPause(video.currentTime, video.duration);
      // Record pause for analytics
      recordPause(tmdbId, season, episode);
      const progress = video.duration > 0 ? (video.currentTime / video.duration) * 100 : 0;
      trackWatchPause(tmdbId, title || 'Unknown Title', mediaType, progress, season, episode);
      // Update presence back to "browsing" when paused
      presenceContext?.setActivityType('browsing');
      trackInteraction({
        element: 'video_player',
        action: 'click',
        context: {
          action_type: 'pause',
          contentId: tmdbId,
          contentType: mediaType,
          currentTime: video.currentTime,
          duration: video.duration,
        },
      });
    };

    const handleTimeUpdate = () => {
      const now = Date.now();
      
      // Throttle UI updates to max 4 times per second (250ms)
      if (now - lastTimeUpdateRef.current < 250) {
        return;
      }
      lastTimeUpdateRef.current = now;
      
      setCurrentTime(video.currentTime);
      if (video.buffered.length > 0) {
        setBuffered((video.buffered.end(video.buffered.length - 1) / video.duration) * 100);
      }
      
      // Show/hide skip intro button based on current time (use refs to avoid stale closures)
      const currentSkipIntro = skipIntroRef.current;
      if (currentSkipIntro) {
        const [introStart, introEnd] = currentSkipIntro;
        const inIntro = video.currentTime >= introStart && video.currentTime < introEnd;
        setShowSkipIntroButton(inIntro);
      }
      
      // Show/hide skip outro button based on current time (use refs to avoid stale closures)
      const currentSkipOutro = skipOutroRef.current;
      if (currentSkipOutro) {
        const [outroStart, outroEnd] = currentSkipOutro;
        const inOutro = video.currentTime >= outroStart && video.currentTime < outroEnd;
        setShowSkipOutroButton(inOutro);
      }

      // Show next episode button based on user preference (use refs for current values)
      // Skip if we've already navigated to next episode (prevents iOS repeated triggers)
      if (!hasNavigatedToNextRef.current) {
        const currentNextEpisode = nextEpisodeRef.current;
        const currentPrefs = playerPrefsRef.current;
        const isButtonShowing = showNextEpisodeButtonRef.current;
        if (currentNextEpisode && video.duration > 0) {
          const timeRemaining = video.duration - video.currentTime;
          const showBeforeEnd = currentPrefs.showNextEpisodeBeforeEnd || 90;
          if (timeRemaining <= showBeforeEnd && !isButtonShowing) {
            // Show the button and start countdown if auto-play is enabled
            setShowNextEpisodeButton(true);
            if (currentPrefs.autoPlayNextEpisode) {
              console.log('[VideoPlayer] Starting countdown - time remaining:', timeRemaining);
              setAutoPlayCountdownState(currentPrefs.autoPlayCountdown);
            }
          } else if (timeRemaining > showBeforeEnd && isButtonShowing) {
            // Hide button if we're no longer in the "show before end" window (e.g., user seeked back)
            setShowNextEpisodeButton(false);
            setAutoPlayCountdownState(null);
          }
        }
      }

      if (video.duration > 0) {
        handleProgress(video.currentTime, video.duration);
        const progress = (video.currentTime / video.duration) * 100;
        const currentTimeRounded = Math.floor(video.currentTime);

        // Enhanced watch time tracking - throttle to once per second
        if (now - lastWatchTimeUpdateRef.current >= 1000) {
          lastWatchTimeUpdateRef.current = now;
          updateWatchTime({
            contentId: tmdbId,
            contentType: mediaType,
            contentTitle: title,
            seasonNumber: season,
            episodeNumber: episode,
            currentPosition: video.currentTime,
            duration: video.duration,
            isPlaying: !video.paused,
          });
        }

        if (currentTimeRounded > 0 && currentTimeRounded % 30 === 0) {
          trackWatchProgress(tmdbId, title || 'Unknown Title', mediaType, progress, video.currentTime, season, episode);
        }

        if (progress >= 90 && !video.dataset.completionTracked) {
          video.dataset.completionTracked = 'true';
          trackWatchComplete(tmdbId, title || 'Unknown Title', mediaType, video.currentTime, season, episode);
        }
      }
    };

    const handleDurationChange = () => {
      setDuration(video.duration);

      if (hasShownResumePromptRef.current) return;
      
      // Skip resume prompt if this is an autoplay navigation (coming from previous episode)
      if (isAutoplayNavigationRef.current) {
        console.log('[VideoPlayer] Skipping resume prompt for autoplay navigation');
        hasShownResumePromptRef.current = true;
        isAutoplayNavigationRef.current = false; // Reset for future use
        return;
      }

      const savedTime = loadProgress();
      if (savedTime > 0 && savedTime < video.duration - 30) {
        setSavedProgress(savedTime);
        setShowResumePrompt(true);
        // Signal to initializePlayer that this source is playable (resume prompt = working)
        if (sourceReadyResolverRef.current) {
          sourceReadyResolverRef.current();
          sourceReadyResolverRef.current = null;
        }
        video.pause();
        hasShownResumePromptRef.current = true;
      } else if (video.duration > 0) {
        // Mark as shown even if we didn't show it (e.g. no saved progress)
        // to prevent it from showing later if duration changes again
        hasShownResumePromptRef.current = true;
      }
    };

    const handleVolumeChange = () => {
      setVolume(video.volume);
      setIsMuted(video.muted);
    };

    // Resync subtitles after seeking to ensure they display correctly
    const handleSeeked = () => {
      if (video.textTracks && video.textTracks.length > 0) {
        console.log('[VideoPlayer] Seek completed, resyncing subtitles at time:', video.currentTime);
        
        // Force subtitle track refresh by toggling mode
        for (let i = 0; i < video.textTracks.length; i++) {
          const track = video.textTracks[i];
          if (track.mode === 'showing') {
            // Toggle off and on to force browser to re-evaluate which cues to show
            track.mode = 'hidden';
            // Use requestAnimationFrame to ensure the mode change is processed
            requestAnimationFrame(() => {
              track.mode = 'showing';
            });
          }
        }
      }
    };

    const handleWaiting = () => setIsBuffering(true);
    const handleCanPlay = () => {
      setIsBuffering(false);
      setIsLoading(false);
    };
    const handleLoadedData = () => {
      setIsLoading(false);
      
      // Apply saved volume settings to video element
      const savedVolume = getSavedVolume();
      const savedMuted = getSavedMuteState();
      video.volume = savedVolume;
      video.muted = savedMuted;
      
      trackContentEngagement(tmdbId, mediaType, 'video_loaded', {
        title,
        season,
        episode,
        duration: video.duration,
      });
    };

    const handleEnded = () => {
      console.log('[VideoPlayer] Video ended event fired');
      setIsPlaying(false);
      
      // Prevent repeated triggers (iOS can fire ended event multiple times)
      if (hasNavigatedToNextRef.current) {
        console.log('[VideoPlayer] Already navigated to next episode, ignoring ended event');
        return;
      }
      
      // Use refs for current values (avoid stale closures)
      const currentNextEpisode = nextEpisodeRef.current;
      const currentOnNextEpisode = onNextEpisodeRef.current;
      const currentCountdown = autoPlayCountdownRef.current;
      console.log('[VideoPlayer] handleEnded - nextEpisode:', currentNextEpisode, 'onNextEpisode:', !!currentOnNextEpisode);
      if (currentNextEpisode && currentOnNextEpisode) {
        // Always show the next episode button when video ends
        setShowNextEpisodeButton(true);
        // If countdown isn't already running, start it now
        if (currentCountdown === null) {
          const prefs = getPlayerPreferences();
          console.log('[VideoPlayer] Auto-play prefs:', prefs);
          if (prefs.autoPlayNextEpisode) {
            console.log('[VideoPlayer] Starting auto-play countdown:', prefs.autoPlayCountdown);
            setAutoPlayCountdownState(prefs.autoPlayCountdown);
          }
        }
      } else {
        console.log('[VideoPlayer] No next episode or callback available');
      }
    };

    const handleVideoError = (e: Event) => {
      const videoEl = e.target as HTMLVideoElement;
      const error = videoEl.error;
      console.error('[VideoPlayer] Video element error:', {
        code: error?.code,
        message: error?.message,
        MEDIA_ERR_ABORTED: error?.code === 1,
        MEDIA_ERR_NETWORK: error?.code === 2,
        MEDIA_ERR_DECODE: error?.code === 3,
        MEDIA_ERR_SRC_NOT_SUPPORTED: error?.code === 4,
      });
    };

    video.addEventListener('error', handleVideoError);
    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('durationchange', handleDurationChange);
    video.addEventListener('volumechange', handleVolumeChange);
    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('canplay', handleCanPlay);
    video.addEventListener('loadeddata', handleLoadedData);
    video.addEventListener('ended', handleEnded);
    video.addEventListener('seeked', handleSeeked);

    return () => {
      video.removeEventListener('error', handleVideoError);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('durationchange', handleDurationChange);
      video.removeEventListener('volumechange', handleVolumeChange);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('loadeddata', handleLoadedData);
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('seeked', handleSeeked);
      // Clear watch time tracking on unmount (will sync before clearing)
      clearWatchTime(tmdbId, season, episode);
    };
  }, [tmdbId, season, episode, clearWatchTime]);

  // Fullscreen handler - supports iOS Safari webkitfullscreenchange
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isNowFullscreen = !!(
        document.fullscreenElement || 
        (document as any).webkitFullscreenElement
      );
      setIsFullscreen(isNowFullscreen);
      
      // Unlock orientation when exiting fullscreen (e.g., via Escape key)
      if (!isNowFullscreen && screen.orientation && 'unlock' in screen.orientation) {
        try {
          (screen.orientation as any).unlock();
        } catch (e) {
          // Ignore unlock errors
        }
      }
    };
    
    // iOS Safari video fullscreen events
    const handleiOSFullscreenChange = () => {
      const video = videoRef.current;
      if (video) {
        const isNowFullscreen = !!(video as any).webkitDisplayingFullscreen;
        setIsFullscreen(isNowFullscreen);
      }
    };
    
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    
    // iOS Safari specific events on video element
    const video = videoRef.current;
    if (video) {
      video.addEventListener('webkitbeginfullscreen', handleiOSFullscreenChange);
      video.addEventListener('webkitendfullscreen', handleiOSFullscreenChange);
    }
    
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      if (video) {
        video.removeEventListener('webkitbeginfullscreen', handleiOSFullscreenChange);
        video.removeEventListener('webkitendfullscreen', handleiOSFullscreenChange);
      }
    };
  }, []);

  // Auto-play countdown timer - uses refs to avoid stale closures
  useEffect(() => {
    // Skip if countdown is null (not started)
    if (autoPlayCountdown === null) {
      return;
    }
    
    console.log('[VideoPlayer] Auto-play countdown:', autoPlayCountdown);
    
    // When countdown reaches 0, navigate to next episode
    if (autoPlayCountdown <= 0) {
      // Prevent repeated triggers (iOS can fire ended event multiple times)
      if (hasNavigatedToNextRef.current) {
        console.log('[VideoPlayer] Already navigated to next episode, ignoring');
        setAutoPlayCountdownState(null);
        setShowNextEpisodeButton(false);
        return;
      }
      
      const currentNextEpisode = nextEpisodeRef.current;
      const currentOnNextEpisode = onNextEpisodeRef.current;
      console.log('[VideoPlayer] Countdown reached 0!', { 
        hasNextEpisode: !!currentNextEpisode, 
        hasCallback: !!currentOnNextEpisode,
        nextEpisodeData: currentNextEpisode
      });
      
      // Reset countdown state first to prevent re-triggering
      setAutoPlayCountdownState(null);
      setShowNextEpisodeButton(false);
      
      if (currentNextEpisode && currentOnNextEpisode) {
        console.log('[VideoPlayer] AUTO-NAVIGATING to next episode NOW!');
        hasNavigatedToNextRef.current = true; // Mark as navigated
        // Call immediately - no delay needed
        currentOnNextEpisode();
      } else {
        console.error('[VideoPlayer] Cannot navigate - missing nextEpisode or callback!');
      }
      return;
    }
    
    // Set up the next tick (countdown by 1 second)
    autoPlayTimerRef.current = setTimeout(() => {
      setAutoPlayCountdownState(prev => {
        if (prev === null || prev <= 0) return null;
        const newValue = prev - 1;
        console.log('[VideoPlayer] Countdown tick:', prev, '->', newValue);
        return newValue;
      });
    }, 1000);

    return () => {
      if (autoPlayTimerRef.current) {
        clearTimeout(autoPlayTimerRef.current);
      }
    };
  }, [autoPlayCountdown]);

  // Cancel auto-play countdown when user interacts
  const cancelAutoPlay = useCallback(() => {
    if (autoPlayTimerRef.current) {
      clearTimeout(autoPlayTimerRef.current);
    }
    setAutoPlayCountdownState(null);
  }, []);

  // Keyboard shortcuts with row-based navigation
  // Rows: 0=top row (back button + sub/dub + server), 1=timeline (progress bar), 2=control buttons (bottom)
  // Special handling: volume control when on mute button, menu navigation when menus open
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (!videoRef.current) return;
      if (!containerRef.current) return;
      
      // Only handle keys if the video player container is visible
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      
      // Resume prompt has its own keyboard handler, skip here
      if (showResumePrompt) return;
      
      // Get bottom control buttons (row 2)
      const controlButtons = containerRef.current?.querySelectorAll('[data-player-control]') as NodeListOf<HTMLButtonElement>;
      const controlCount = controlButtons?.length || 0;
      
      // Get top row buttons (row 0): back button + sub/dub + server
      const backButton = document.querySelector('[data-player-back="true"]') as HTMLButtonElement;
      const topControlButtons = containerRef.current?.querySelectorAll('[data-player-top-control]') as NodeListOf<HTMLButtonElement>;
      // Build array of all top row elements: [backButton, ...topControlButtons]
      const topRowElements: HTMLElement[] = [];
      if (backButton) topRowElements.push(backButton);
      topControlButtons?.forEach(btn => topRowElements.push(btn));
      const topRowCount = topRowElements.length;
      
      // Check if focused on mute/volume button (row 2)
      const focusedButton = focusedRow === 2 && focusedControlIndex >= 0 && controlButtons ? controlButtons[focusedControlIndex] : null;
      const isOnVolumeButton = focusedButton?.getAttribute('data-player-control') === 'mute';
      
      // Check if any menu is open (subtitles, settings, server)
      const isMenuOpen = showSubtitles || showSettings || showServerMenu;
      
      // Handle arrow keys for player control navigation
      const isArrowKey = ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(e.key.toLowerCase());
      if (isArrowKey) {
        e.preventDefault();
        e.stopPropagation(); // Prevent TVNavigationProvider from handling
      }
      
      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault();
          e.stopPropagation();
          // If a control button is focused, activate it
          if (focusedRow === 0 && focusedControlIndex >= 0 && topRowElements[focusedControlIndex]) {
            topRowElements[focusedControlIndex].click();
          } else if (focusedRow === 2 && focusedControlIndex >= 0 && controlButtons && controlButtons[focusedControlIndex]) {
            controlButtons[focusedControlIndex].click();
          } else {
            togglePlay();
          }
          break;
        case 'enter':
          e.preventDefault();
          e.stopPropagation();
          // Activate based on current row
          if (focusedRow === 0 && focusedControlIndex >= 0 && topRowElements[focusedControlIndex]) {
            topRowElements[focusedControlIndex].click();
          } else if (focusedRow === 2 && focusedControlIndex >= 0 && controlButtons && controlButtons[focusedControlIndex]) {
            controlButtons[focusedControlIndex].click();
          }
          break;
        case 'f':
          e.preventDefault();
          e.stopPropagation();
          toggleFullscreen();
          break;
        case 'm':
          e.preventDefault();
          e.stopPropagation();
          toggleMute();
          break;
        case 'arrowleft':
          e.preventDefault();
          // Show controls if hidden
          if (!showControls) {
            setShowControls(true);
            setFocusedRow(2);
            setFocusedControlIndex(0);
            return;
          }
          // If server menu is open, navigate tabs left
          if (showServerMenu) {
            const availableProviders = providerTabOrder.filter(p => providerAvailability[p]);
            
            const currentTabIndex = availableProviders.indexOf(menuProvider);
            if (currentTabIndex > 0) {
              const newProvider = availableProviders[currentTabIndex - 1];
              setMenuProvider(newProvider);
              fetchSources(newProvider);
            } else {
              // Wrap to last tab
              const newProvider = availableProviders[availableProviders.length - 1];
              setMenuProvider(newProvider);
              fetchSources(newProvider);
            }
            return;
          }
          // If other menu is open (subtitles/settings), close it
          if (showSubtitles || showSettings) {
            setShowSubtitles(false);
            setShowSettings(false);
            return;
          }
          // Behavior depends on current row
          if (focusedRow === 0 && topRowCount > 0) {
            // Top row: navigate left through back button, sub/dub, server
            if (focusedControlIndex <= 0) {
              setFocusedControlIndex(topRowCount - 1); // Wrap to end
            } else {
              setFocusedControlIndex(prev => prev - 1);
            }
          } else if (focusedRow === 1) {
            // Timeline row: seek backward
            seek(currentTime - 10);
          } else if (focusedRow === 2 && controlCount > 0) {
            // Control buttons row: navigate left
            if (focusedControlIndex <= 0) {
              setFocusedControlIndex(controlCount - 1); // Wrap to end
            } else {
              setFocusedControlIndex(prev => prev - 1);
            }
          } else if (focusedRow < 0) {
            // No focus yet, start at controls
            setFocusedRow(2);
            setFocusedControlIndex(0);
          }
          break;
        case 'arrowright':
          e.preventDefault();
          // Show controls if hidden
          if (!showControls) {
            setShowControls(true);
            setFocusedRow(2);
            setFocusedControlIndex(0);
            return;
          }
          // If server menu is open, navigate tabs right
          if (showServerMenu) {
            const availableProviders = providerTabOrder.filter(p => providerAvailability[p]);
            
            const currentTabIndex = availableProviders.indexOf(menuProvider);
            if (currentTabIndex < availableProviders.length - 1) {
              const newProvider = availableProviders[currentTabIndex + 1];
              setMenuProvider(newProvider);
              fetchSources(newProvider);
            } else {
              // Wrap to first tab
              const newProvider = availableProviders[0];
              setMenuProvider(newProvider);
              fetchSources(newProvider);
            }
            return;
          }
          // If other menu is open (subtitles/settings), close it
          if (showSubtitles || showSettings) {
            setShowSubtitles(false);
            setShowSettings(false);
            return;
          }
          // Behavior depends on current row
          if (focusedRow === 0 && topRowCount > 0) {
            // Top row: navigate right through back button, sub/dub, server
            if (focusedControlIndex >= topRowCount - 1) {
              setFocusedControlIndex(0); // Wrap to start
            } else {
              setFocusedControlIndex(prev => prev + 1);
            }
          } else if (focusedRow === 1) {
            // Timeline row: seek forward
            seek(currentTime + 10);
          } else if (focusedRow === 2 && controlCount > 0) {
            // Control buttons row: navigate right
            if (focusedControlIndex >= controlCount - 1) {
              setFocusedControlIndex(0); // Wrap to start
            } else {
              setFocusedControlIndex(prev => prev + 1);
            }
          } else if (focusedRow < 0) {
            // No focus yet, start at controls
            setFocusedRow(2);
            setFocusedControlIndex(0);
          }
          break;
        case 'arrowup':
          e.preventDefault();
          // Show controls if hidden
          if (!showControls) {
            setShowControls(true);
            setFocusedRow(2);
            setFocusedControlIndex(0);
            return;
          }
          // If on volume button, increase volume
          if (isOnVolumeButton) {
            handleVolumeChange(Math.min(volume * 100 + 10, 100));
            return;
          }
          // If menu is open, let native focus handle menu navigation
          if (isMenuOpen) {
            // Focus previous menu item - use specific selector for server menu sources
            const sourceItems = showServerMenu 
              ? containerRef.current?.querySelectorAll('[data-server-source]') as NodeListOf<HTMLButtonElement>
              : containerRef.current?.querySelectorAll('.settingsOption, [class*="settingsOption"]') as NodeListOf<HTMLButtonElement>;
            if (sourceItems && sourceItems.length > 0) {
              const currentFocus = document.activeElement;
              const currentIndex = Array.from(sourceItems).indexOf(currentFocus as HTMLButtonElement);
              if (currentIndex > 0) {
                sourceItems[currentIndex - 1].focus();
              } else if (currentIndex === -1) {
                // No source focused yet, focus the last one
                sourceItems[sourceItems.length - 1].focus();
              } else {
                sourceItems[sourceItems.length - 1].focus(); // Wrap to end
              }
            }
            return;
          }
          // Move up through rows: controls(2) -> timeline(1) -> top row(0)
          if (focusedRow < 0) {
            setFocusedRow(2);
            setFocusedControlIndex(0);
          } else if (focusedRow === 2) {
            setFocusedRow(1); // Move to timeline
            setFocusedControlIndex(-1);
          } else if (focusedRow === 1 && topRowCount > 0) {
            setFocusedRow(0); // Move to top row
            setFocusedControlIndex(0); // Start at back button (first element)
          }
          break;
        case 'arrowdown':
          e.preventDefault();
          // Show controls if hidden
          if (!showControls) {
            setShowControls(true);
            setFocusedRow(2);
            setFocusedControlIndex(0);
            return;
          }
          // If on volume button, decrease volume
          if (isOnVolumeButton) {
            handleVolumeChange(Math.max(volume * 100 - 10, 0));
            return;
          }
          // If menu is open, navigate through menu items
          if (isMenuOpen) {
            // Focus next menu item - use specific selector for server menu sources
            const sourceItems = showServerMenu 
              ? containerRef.current?.querySelectorAll('[data-server-source]') as NodeListOf<HTMLButtonElement>
              : containerRef.current?.querySelectorAll('.settingsOption, [class*="settingsOption"]') as NodeListOf<HTMLButtonElement>;
            if (sourceItems && sourceItems.length > 0) {
              const currentFocus = document.activeElement;
              const currentIndex = Array.from(sourceItems).indexOf(currentFocus as HTMLButtonElement);
              if (currentIndex < sourceItems.length - 1 && currentIndex >= 0) {
                sourceItems[currentIndex + 1].focus();
              } else if (currentIndex === -1) {
                // No source focused yet, focus the first one
                sourceItems[0].focus();
              } else {
                sourceItems[0].focus(); // Wrap to start
              }
            }
            return;
          }
          // Move down through rows: back(0) -> timeline(1) -> controls(2)
          if (focusedRow < 0) {
            setFocusedRow(2);
            setFocusedControlIndex(0);
          } else if (focusedRow === 0) {
            setFocusedRow(1); // Move from back to timeline
            setFocusedControlIndex(-1);
          } else if (focusedRow === 1) {
            setFocusedRow(2); // Move to controls
            setFocusedControlIndex(0);
          }
          // At row 2, can't go lower
          break;
        case 'escape':
        case 'backspace':
          e.preventDefault();
          e.stopPropagation();
          // If menu is open, close it first
          if (isMenuOpen) {
            setShowSubtitles(false);
            setShowSettings(false);
            setShowServerMenu(false);
            return;
          }
          // Clear focus or go back
          if (focusedRow >= 0) {
            setFocusedRow(-1);
            setFocusedControlIndex(-1);
          } else {
            // Use onBack callback if provided (navigates to details page)
            // Otherwise fall back to browser history
            if (onBack) {
              onBack();
            } else {
              window.history.back();
            }
          }
          break;
        case 'n':
          // Test: Trigger next episode flow
          e.preventDefault();
          e.stopPropagation();
          const currentNextEp = nextEpisodeRef.current;
          const currentCallback = onNextEpisodeRef.current;
          if (currentNextEp && currentCallback) {
            const prefs = getPlayerPreferences();
            if (prefs.autoPlayNextEpisode) {
              setAutoPlayCountdownState(prefs.autoPlayCountdown);
            }
            setShowNextEpisodeButton(true);
          }
          break;
        case 'g':
          e.preventDefault();
          e.stopPropagation();
          if (currentSubtitle) adjustSubtitleOffset(0.5);
          break;
        case 'h':
          e.preventDefault();
          e.stopPropagation();
          if (currentSubtitle) adjustSubtitleOffset(-0.5);
          break;
        case ',':
        case '<':
          // Decrease playback speed
          e.preventDefault();
          e.stopPropagation();
          {
            const currentIndex = speedOptions.indexOf(playbackSpeed);
            if (currentIndex > 0) {
              changeSpeed(speedOptions[currentIndex - 1]);
            }
          }
          break;
        case '.':
        case '>':
          // Increase playback speed
          e.preventDefault();
          e.stopPropagation();
          {
            const currentIndex = speedOptions.indexOf(playbackSpeed);
            if (currentIndex < speedOptions.length - 1) {
              changeSpeed(speedOptions[currentIndex + 1]);
            }
          }
          break;
      }
    };
    // Use capture phase to intercept before TVNavigationProvider
    window.addEventListener('keydown', handleKeyPress, true);
    return () => window.removeEventListener('keydown', handleKeyPress, true);
  }, [currentTime, volume, showResumePrompt, showControls, focusedRow, focusedControlIndex, showSubtitles, showSettings, showServerMenu, playbackSpeed]);

  // Alt + Scroll wheel for subtitle sync adjustment (using Alt instead of Ctrl to avoid browser zoom)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      // Only handle when Alt is pressed and subtitles are active
      if (!e.altKey || !currentSubtitle) return;
      
      e.preventDefault();
      e.stopPropagation();
      
      // Scroll up = earlier subtitles (negative offset), scroll down = later subtitles (positive offset)
      const delta = e.deltaY > 0 ? 0.5 : -0.5;
      adjustSubtitleOffset(delta);
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [currentSubtitle, adjustSubtitleOffset]);

  // Apply visual focus based on row and control index
  useEffect(() => {
    if (!containerRef.current) return;
    
    // Get bottom control buttons (row 2)
    const controlButtons = containerRef.current.querySelectorAll('[data-player-control]') as NodeListOf<HTMLButtonElement>;
    const progressBar = containerRef.current.querySelector('[data-player-timeline]') as HTMLElement;
    
    // Get top row elements (row 0): back button + sub/dub + server
    const backButton = document.querySelector('[data-player-back="true"]') as HTMLButtonElement;
    const topControlButtons = containerRef.current.querySelectorAll('[data-player-top-control]') as NodeListOf<HTMLButtonElement>;
    const topRowElements: HTMLElement[] = [];
    if (backButton) topRowElements.push(backButton);
    topControlButtons?.forEach(btn => topRowElements.push(btn));
    
    // Remove all focus classes first
    controlButtons?.forEach(btn => {
      btn.classList.remove(styles.playerControlFocused);
    });
    topRowElements.forEach(el => {
      el.classList.remove('player-back-focused');
      el.classList.remove(styles.playerControlFocused);
    });
    progressBar?.classList.remove(styles.timelineFocused);
    
    // Apply focus based on current row
    if (focusedRow === 0 && focusedControlIndex >= 0 && topRowElements[focusedControlIndex]) {
      // Top row - back button, sub/dub, or server
      const el = topRowElements[focusedControlIndex];
      if (el === backButton) {
        el.classList.add('player-back-focused');
      } else {
        el.classList.add(styles.playerControlFocused);
      }
      el.focus();
    } else if (focusedRow === 1 && progressBar) {
      // Timeline row - only highlight timeline, no button focus
      progressBar.classList.add(styles.timelineFocused);
    } else if (focusedRow === 2 && controlButtons && focusedControlIndex >= 0 && focusedControlIndex < controlButtons.length) {
      // Control buttons row
      controlButtons[focusedControlIndex].classList.add(styles.playerControlFocused);
      controlButtons[focusedControlIndex].focus();
    }
  }, [focusedRow, focusedControlIndex]);

  // Reset focus when controls hide
  useEffect(() => {
    if (!showControls) {
      setFocusedRow(-1);
      setFocusedControlIndex(-1);
    }
  }, [showControls]);

  // Auto-focus first source when server menu opens
  useEffect(() => {
    if (showServerMenu && containerRef.current) {
      // Small delay to ensure menu is rendered
      const timer = setTimeout(() => {
        const firstSource = containerRef.current?.querySelector('[data-server-source="0"]') as HTMLButtonElement;
        if (firstSource) {
          firstSource.focus();
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [showServerMenu, menuProvider, sourcesCache]);

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play();
    }
  };

  const handleVolumeChange = (value: number) => {
    if (!videoRef.current) return;
    const newVolume = value / 100;
    const newMuted = newVolume === 0;
    videoRef.current.volume = newVolume;
    setVolume(newVolume);
    setIsMuted(newMuted);
    // Save to localStorage for persistence
    saveVolumeSettings(newVolume, newMuted);
    setShowVolumeIndicator(true);
    if (volumeIndicatorTimeoutRef.current) {
      clearTimeout(volumeIndicatorTimeoutRef.current);
    }
    volumeIndicatorTimeoutRef.current = setTimeout(() => {
      setShowVolumeIndicator(false);
    }, 1000);
    trackInteraction({
      element: 'volume_control',
      action: 'click',
      context: {
        action_type: 'volume_change',
        volume: newVolume,
        contentId: tmdbId,
      },
    });
  };

  const toggleMute = () => {
    if (!videoRef.current) return;
    const newMuted = !isMuted;
    videoRef.current.muted = newMuted;
    setIsMuted(newMuted);
    // Save to localStorage for persistence
    saveVolumeSettings(volume, newMuted);
    setShowVolumeIndicator(true);
    if (volumeIndicatorTimeoutRef.current) {
      clearTimeout(volumeIndicatorTimeoutRef.current);
    }
    volumeIndicatorTimeoutRef.current = setTimeout(() => {
      setShowVolumeIndicator(false);
    }, 1000);
  };

  // Change playback speed
  const changeSpeed = (speed: number) => {
    if (!videoRef.current) return;
    videoRef.current.playbackRate = speed;
    setPlaybackSpeed(speed);
    // Show speed indicator briefly
    setShowSpeedIndicator(true);
    if (speedIndicatorTimeoutRef.current) {
      clearTimeout(speedIndicatorTimeoutRef.current);
    }
    speedIndicatorTimeoutRef.current = setTimeout(() => {
      setShowSpeedIndicator(false);
    }, 1000);
  };

  // Force resync subtitles to current video time
  const resyncSubtitles = useCallback(() => {
    if (!videoRef.current || !videoRef.current.textTracks) return;
    
    const video = videoRef.current;
    console.log('[VideoPlayer] Resyncing subtitles at time:', video.currentTime);
    
    for (let i = 0; i < video.textTracks.length; i++) {
      const track = video.textTracks[i];
      if (track.mode === 'showing') {
        // Toggle mode to force browser to re-evaluate which cues to display
        track.mode = 'hidden';
        requestAnimationFrame(() => {
          track.mode = 'showing';
        });
      }
    }
  }, []);

  const seek = (time: number) => {
    if (!videoRef.current) return;
    const newTime = Math.max(0, Math.min(time, duration));
    videoRef.current.currentTime = newTime;
    // Resync subtitles after seek completes
    setTimeout(resyncSubtitles, 50);
    trackInteraction({
      element: 'video_player',
      action: 'click',
      context: {
        action_type: 'seek',
        contentId: tmdbId,
        fromTime: currentTime,
        toTime: newTime,
        seekAmount: newTime - currentTime,
      },
    });
  };

  const toggleFullscreen = async () => {
    const video = videoRef.current;
    const container = containerRef.current;
    if (!container || !video) return;
    
    // Check if we're currently in fullscreen (including webkit prefix)
    const isCurrentlyFullscreen = !!(
      document.fullscreenElement || 
      (document as any).webkitFullscreenElement ||
      (video as any).webkitDisplayingFullscreen
    );
    
    if (!isCurrentlyFullscreen) {
      try {
        // iOS Safari: Use webkitEnterFullscreen on video element
        // This is the ONLY way to get fullscreen on iOS Safari
        if ((video as any).webkitEnterFullscreen) {
          console.log('[VideoPlayer] Using iOS webkitEnterFullscreen');
          (video as any).webkitEnterFullscreen();
        }
        // Safari desktop: Use webkitRequestFullscreen on container
        else if ((container as any).webkitRequestFullscreen) {
          console.log('[VideoPlayer] Using Safari webkitRequestFullscreen');
          await (container as any).webkitRequestFullscreen();
        }
        // Standard fullscreen API
        else if (container.requestFullscreen) {
          console.log('[VideoPlayer] Using standard requestFullscreen');
          await container.requestFullscreen();
        }
        
        // Force landscape orientation on mobile devices (Android)
        if (screen.orientation && 'lock' in screen.orientation) {
          try {
            await (screen.orientation as any).lock('landscape');
          } catch (e) {
            // Orientation lock may not be supported or allowed
            console.log('[VideoPlayer] Could not lock orientation:', e);
          }
        }
      } catch (e) {
        console.error('[VideoPlayer] Fullscreen request failed:', e);
      }
    } else {
      // Unlock orientation when exiting fullscreen
      if (screen.orientation && 'unlock' in screen.orientation) {
        try {
          (screen.orientation as any).unlock();
        } catch (e) {
          // Ignore unlock errors
        }
      }
      
      // Exit fullscreen using appropriate method
      if ((video as any).webkitExitFullscreen) {
        (video as any).webkitExitFullscreen();
      } else if ((document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen();
      } else if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  };

  const updateSubtitleStyle = (newStyle: Partial<SubtitleStyle>) => {
    const updated = { ...subtitleStyle, ...newStyle };
    setSubtitleStyleState(updated);
    setSubtitleStyle(updated);
    if (videoRef.current) {
      const video = videoRef.current;
      const styleId = 'dynamic-subtitle-style';
      let styleEl = document.getElementById(styleId) as HTMLStyleElement;
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = styleId;
        document.head.appendChild(styleEl);
      }
      const bgOpacity = updated.backgroundOpacity / 100;
      const linePosition = updated.verticalPosition;
      styleEl.textContent = `
        video::cue {
          font-size: ${updated.fontSize}% !important;
          color: ${updated.textColor} !important;
          background-color: rgba(0, 0, 0, ${bgOpacity}) !important;
          text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.8) !important;
          line: ${linePosition}% !important;
        }
      `;
      if (video.textTracks && video.textTracks.length > 0) {
        const track = video.textTracks[0];
        if (track.cues) {
          for (let i = 0; i < track.cues.length; i++) {
            const cue = track.cues[i] as any;
            if (cue.line !== undefined) {
              cue.line = linePosition;
              cue.snapToLines = false;
            }
          }
        }
      }
    }
  };

  const loadSubtitle = (subtitle: any | null, offset: number = 0) => {
    if (!videoRef.current) return;
    
    // First, disable all existing text tracks to prevent them from showing
    if (videoRef.current.textTracks) {
      for (let i = 0; i < videoRef.current.textTracks.length; i++) {
        videoRef.current.textTracks[i].mode = 'disabled';
      }
    }
    
    // Remove all track elements
    const tracks = videoRef.current.querySelectorAll('track');
    tracks.forEach(track => track.remove());
    
    // Store current subtitle data for re-syncing
    currentSubtitleDataRef.current = subtitle;
    
    if (subtitle) {
      // For custom uploaded subtitles, use the blob URL directly
      // For OpenSubtitles, proxy through our API with cache-busting and language code for encoding
      const cacheBuster = Date.now();
      const langCode = subtitle.iso639 || subtitle.langCode || '';
      const subtitleUrl = subtitle.isCustom 
        ? subtitle.url 
        : `/api/subtitle-proxy?url=${encodeURIComponent(subtitle.url)}&lang=${encodeURIComponent(langCode)}&_t=${cacheBuster}`;
      
      console.log('[VideoPlayer] Loading subtitle:', { 
        isCustom: subtitle.isCustom, 
        url: subtitleUrl.substring(0, 100),
        language: subtitle.language,
        langCode: subtitle.langCode,
        iso639: subtitle.iso639,
        id: subtitle.id,
        offset: offset
      });
      
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = subtitle.language || 'Subtitles';
      track.srclang = subtitle.iso639 || 'en';
      track.src = subtitleUrl;
      track.default = true;
      track.addEventListener('load', () => {
        console.log('[VideoPlayer] Subtitle track loaded successfully');
        if (videoRef.current && videoRef.current.textTracks) {
          const video = videoRef.current;
          const currentVideoTime = video.currentTime;
          
          // Set all tracks to showing and apply offset
          for (let i = 0; i < video.textTracks.length; i++) {
            const textTrack = video.textTracks[i];
            console.log('[VideoPlayer] Track', i, ':', textTrack.label, textTrack.mode, 'cues:', textTrack.cues?.length);
            
            // Apply offset to all cues if needed
            if (offset !== 0 && textTrack.cues) {
              for (let j = 0; j < textTrack.cues.length; j++) {
                const cue = textTrack.cues[j] as VTTCue;
                cue.startTime = Math.max(0, cue.startTime + offset);
                cue.endTime = Math.max(0, cue.endTime + offset);
              }
              console.log('[VideoPlayer] Applied offset of', offset, 'seconds to', textTrack.cues.length, 'cues');
            }
            
            // Force sync: toggle mode to refresh cue display at current time
            textTrack.mode = 'hidden';
          }
          
          // Use requestAnimationFrame to ensure mode change is processed before showing
          requestAnimationFrame(() => {
            if (video.textTracks) {
              for (let i = 0; i < video.textTracks.length; i++) {
                video.textTracks[i].mode = 'showing';
              }
              console.log('[VideoPlayer] Subtitles synced at video time:', currentVideoTime);
            }
          });
        }
      });
      track.addEventListener('error', (e) => {
        console.error('[VideoPlayer] Subtitle track failed to load:', e);
      });
      videoRef.current.appendChild(track);
      
      // Force track to show after a delay with proper sync
      setTimeout(() => {
        if (videoRef.current && videoRef.current.textTracks) {
          const video = videoRef.current;
          console.log('[VideoPlayer] Delayed subtitle sync at time:', video.currentTime);
          
          // Toggle mode to force browser to re-evaluate cues at current time
          for (let i = 0; i < video.textTracks.length; i++) {
            const textTrack = video.textTracks[i];
            if (textTrack.mode !== 'showing') {
              textTrack.mode = 'hidden';
              requestAnimationFrame(() => {
                textTrack.mode = 'showing';
              });
            }
          }
        }
      }, 500);
      
      setCurrentSubtitle(subtitle.id);
      setSubtitleLanguage(subtitle.langCode, subtitle.language);
      setSubtitlesEnabled(true);
      // Reset subtitle offset when switching to a new subtitle
      if (offset === 0) {
        setSubtitleOffset(0);
      }
    } else {
      currentSubtitleDataRef.current = null;
      setCurrentSubtitle(null);
      setSubtitlesEnabled(false);
      setSubtitleOffset(0);
    }
    setShowSubtitles(false);
  };

  // Reset subtitle offset
  const resetSubtitleOffset = () => {
    if (subtitleOffset !== 0 && currentSubtitleDataRef.current) {
      // Reload the subtitle to reset timing
      loadSubtitle(currentSubtitleDataRef.current, 0);
      setSubtitleOffset(0);
      console.log('[VideoPlayer] Subtitle offset reset');
    }
  };

  const fetchSubtitles = async (imdbId: string) => {
    try {
      setSubtitlesLoading(true);
      const params = new URLSearchParams({ imdbId });
      if (mediaType === 'tv' && season && episode) {
        params.append('season', season.toString());
        params.append('episode', episode.toString());
      }
      const response = await fetch(`/api/subtitles?${params}`);
      const data = await response.json();
      if (data.success && data.subtitles && Array.isArray(data.subtitles)) {
        setAvailableSubtitles(data.subtitles);
      } else {
        setAvailableSubtitles([]);
      }
    } catch (err) {
      setAvailableSubtitles([]);
    } finally {
      setSubtitlesLoading(false);
    }
  };

  // Handle custom VTT file upload
  const handleSubtitleFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file type
    const validTypes = ['.vtt', '.srt'];
    const fileExtension = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
    if (!validTypes.includes(fileExtension)) {
      alert('Please upload a .vtt or .srt subtitle file');
      return;
    }

    const reader = new FileReader();
    reader.onerror = (error) => {
      console.error('[VideoPlayer] FileReader error:', error);
      alert('Failed to read subtitle file');
    };
    reader.onload = (e) => {
      let content = e.target?.result as string;
      
      if (!content) {
        console.error('[VideoPlayer] File content is empty or null');
        alert('Subtitle file appears to be empty');
        return;
      }
      
      console.log('[VideoPlayer] === SUBTITLE FILE LOADED ===');
      console.log('[VideoPlayer] Original file size:', content.length, 'bytes');
      console.log('[VideoPlayer] File extension:', fileExtension);
      console.log('[VideoPlayer] First 200 chars raw:', JSON.stringify(content.substring(0, 200)));
      
      // Convert SRT to VTT if needed
      if (fileExtension === '.srt') {
        console.log('[VideoPlayer] Starting SRT conversion...');
        content = convertSrtToVtt(content);
        console.log('[VideoPlayer] After conversion length:', content.length);
        console.log('[VideoPlayer] Converted preview:', JSON.stringify(content.substring(0, 300)));
      }
      
      // Ensure VTT header exists
      if (!content.startsWith('WEBVTT')) {
        console.log('[VideoPlayer] Adding WEBVTT header');
        content = 'WEBVTT\n\n' + content;
      }

      // Create a blob URL for the subtitle
      const blob = new Blob([content], { type: 'text/vtt' });
      const blobUrl = URL.createObjectURL(blob);
      console.log('[VideoPlayer] Created blob URL:', blobUrl);
      console.log('[VideoPlayer] Final content length:', content.length);

      // Extract language from filename if possible (e.g., "movie.en.vtt" or "movie_english.srt")
      const fileName = file.name.toLowerCase();
      let language = 'Custom';
      if (fileName.includes('english') || fileName.includes('.en.') || fileName.includes('_en.')) language = 'English (Custom)';
      else if (fileName.includes('spanish') || fileName.includes('.es.') || fileName.includes('_es.')) language = 'Spanish (Custom)';
      else if (fileName.includes('french') || fileName.includes('.fr.') || fileName.includes('_fr.')) language = 'French (Custom)';
      else if (fileName.includes('german') || fileName.includes('.de.') || fileName.includes('_de.')) language = 'German (Custom)';
      else if (fileName.includes('danish') || fileName.includes('.da.') || fileName.includes('_da.')) language = 'Danish (Custom)';
      else if (fileName.includes('dutch') || fileName.includes('.nl.') || fileName.includes('_nl.')) language = 'Dutch (Custom)';
      else if (fileName.includes('swedish') || fileName.includes('.sv.') || fileName.includes('_sv.')) language = 'Swedish (Custom)';
      else if (fileName.includes('norwegian') || fileName.includes('.no.') || fileName.includes('_no.')) language = 'Norwegian (Custom)';

      const customSub = {
        id: `custom-${Date.now()}`,
        url: blobUrl,
        language: language,
        langCode: 'custom',
        format: 'vtt',
        fileName: file.name,
        isCustom: true,
        qualityScore: 100, // Custom subs get highest priority
      };

      // Add to custom subtitles list
      setCustomSubtitles(prev => [...prev, customSub]);
      
      // Reset subtitle offset
      setSubtitleOffset(0);
      
      // Load the subtitle
      loadSubtitle(customSub);
      
      console.log('[VideoPlayer] Custom subtitle loaded:', file.name);
    };

    reader.readAsText(file);
    
    // Reset the input so the same file can be uploaded again if needed
    event.target.value = '';
  }, []);

  // Convert SRT format to VTT format
  const convertSrtToVtt = (srtContent: string): string => {
    console.log('[VideoPlayer] Converting SRT, input length:', srtContent.length);
    
    // Normalize line endings
    let normalized = srtContent
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();
    
    // Start with VTT header
    let vttContent = 'WEBVTT\n\n';
    
    // Use regex to match SRT blocks: number, timestamp, text
    // SRT format: 
    // 1
    // 00:00:01,000 --> 00:00:04,000
    // Subtitle text here
    // (blank line)
    
    const srtBlockRegex = /(\d+)\n(\d{1,2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,\.]\d{3})\n([\s\S]*?)(?=\n\n\d+\n|\n*$)/g;
    
    let match;
    let blockCount = 0;
    
    while ((match = srtBlockRegex.exec(normalized)) !== null) {
      blockCount++;
      const startTime = match[2].replace(',', '.');
      const endTime = match[3].replace(',', '.');
      const text = match[4].trim();
      
      if (text) {
        vttContent += `${startTime} --> ${endTime}\n${text}\n\n`;
      }
    }
    
    console.log('[VideoPlayer] SRT conversion found', blockCount, 'blocks');
    
    // If regex didn't find anything, try a simpler line-by-line approach
    if (blockCount === 0) {
      console.log('[VideoPlayer] Trying fallback SRT parsing...');
      const lines = normalized.split('\n');
      let i = 0;
      
      while (i < lines.length) {
        // Skip empty lines and subtitle numbers
        while (i < lines.length && (lines[i].trim() === '' || /^\d+$/.test(lines[i].trim()))) {
          i++;
        }
        
        if (i >= lines.length) break;
        
        // Check if this line is a timestamp
        const timestampMatch = lines[i].match(/(\d{1,2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,\.]\d{3})/);
        
        if (timestampMatch) {
          const startTime = timestampMatch[1].replace(',', '.');
          const endTime = timestampMatch[2].replace(',', '.');
          i++;
          
          // Collect subtitle text until empty line or next number
          const textLines: string[] = [];
          while (i < lines.length && lines[i].trim() !== '' && !/^\d+$/.test(lines[i].trim())) {
            textLines.push(lines[i]);
            i++;
          }
          
          if (textLines.length > 0) {
            blockCount++;
            vttContent += `${startTime} --> ${endTime}\n${textLines.join('\n')}\n\n`;
          }
        } else {
          i++;
        }
      }
      
      console.log('[VideoPlayer] Fallback parsing found', blockCount, 'blocks');
    }
    
    console.log('[VideoPlayer] Final VTT length:', vttContent.length);
    return vttContent;
  };

  useEffect(() => {
    updateSubtitleStyle(subtitleStyle);
  }, []);

  useEffect(() => {
    if (availableSubtitles.length === 0) return;
    if (subtitlesAutoLoadedRef.current) return;
    const preferences = getSubtitlePreferences();
    if (preferences.enabled) {
      const preferredSubtitle = availableSubtitles.find(sub => sub.langCode === preferences.languageCode);
      if (preferredSubtitle) {
        loadSubtitle(preferredSubtitle);
        subtitlesAutoLoadedRef.current = true;
      } else {
        const englishSubtitle = availableSubtitles.find(sub => sub.langCode === 'eng');
        if (englishSubtitle) {
          loadSubtitle(englishSubtitle);
          subtitlesAutoLoadedRef.current = true;
        }
      }
    }
  }, [availableSubtitles]);

  // Change HLS quality level
  const changeHlsLevel = (levelIndex: number) => {
    if (hlsRef.current) {
      hlsRef.current.currentLevel = levelIndex;
      setCurrentHlsLevel(levelIndex);
      
      if (levelIndex === -1) {
        setCurrentResolution('Auto');
      } else {
        const level = hlsLevels.find(l => l.index === levelIndex);
        if (level) {
          setCurrentResolution(`${level.height}p`);
        }
      }
    }
  };

  const handleRetry = () => {
    setError(null);
    setIsLoading(true);
    fetchSources(provider, true).then(sources => {
      if (sources && sources.length > 0 && sources[0]?.url) {
        setAvailableSources(sources);
        setCurrentSourceIndex(0);
        setStreamUrl(applyStreamProxy(sources[0].url, provider, sources[0].requiresSegmentProxy));
      } else {
        setError('No valid sources found');
        setIsLoading(false);
      }
    });
  };

  const handleStartOver = () => {
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
      videoRef.current.play();
    }
    setShowResumePrompt(false);
    shouldShowResumePromptRef.current = false;
  };

  const handleResume = () => {
    if (videoRef.current) {
      videoRef.current.currentTime = savedProgress;
      videoRef.current.play();
      // Resync subtitles after a short delay to ensure seek is complete
      setTimeout(resyncSubtitles, 100);
    }
    setShowResumePrompt(false);
    shouldShowResumePromptRef.current = false;
  };

  // Auto-focus the Resume button and handle keyboard navigation when modal is open
  useEffect(() => {
    if (!showResumePrompt) return;

    // Focus the Resume button immediately
    const focusResumeButton = () => {
      const resumeBtn = document.querySelector('[data-resume-btn="resume"]') as HTMLButtonElement;
      if (resumeBtn) {
        resumeBtn.focus();
        resumeBtn.classList.add('tv-focused');
      }
    };

    // Small delay to ensure DOM is ready
    const focusTimer = setTimeout(focusResumeButton, 50);

    // Handle keyboard navigation within the modal
    const handleModalKeyDown = (e: KeyboardEvent) => {
      const startBtn = document.querySelector('[data-resume-btn="start"]') as HTMLButtonElement;
      const resumeBtn = document.querySelector('[data-resume-btn="resume"]') as HTMLButtonElement;
      if (!startBtn || !resumeBtn) return;

      const buttons = [startBtn, resumeBtn];
      let currentIndex = buttons.findIndex(btn => document.activeElement === btn);
      if (currentIndex === -1) currentIndex = 1; // Default to Resume button

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        
        // Remove old focus styling
        buttons.forEach(btn => btn.classList.remove('tv-focused'));
        
        let newIndex = currentIndex;
        if (e.key === 'ArrowLeft') {
          newIndex = Math.max(0, currentIndex - 1);
        } else {
          newIndex = Math.min(buttons.length - 1, currentIndex + 1);
        }
        
        buttons[newIndex].focus();
        buttons[newIndex].classList.add('tv-focused');
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        buttons[currentIndex].click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleStartOver();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // Block up/down and keep current focus
        e.preventDefault();
        e.stopPropagation();
        // Re-apply focus styling to current button
        buttons.forEach(btn => btn.classList.remove('tv-focused'));
        buttons[currentIndex].classList.add('tv-focused');
      }
    };

    // Use capture phase to intercept before other handlers
    window.addEventListener('keydown', handleModalKeyDown, true);

    return () => {
      clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleModalKeyDown, true);
    };
  }, [showResumePrompt]);

  const resetControlsTimeout = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    // Don't auto-hide controls if keyboard navigation is active
    if (isPlaying && focusedRow < 0 && focusedControlIndex < 0) {
      controlsTimeoutRef.current = setTimeout(() => {
        setShowControls(false);
      }, 4000); // Hide after 4 seconds of no movement
    }
  }, [isPlaying, focusedRow, focusedControlIndex]);

  // Handle tap to play/pause (separate from zoom gestures)
  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    // Only toggle play if clicking directly on the container or video wrapper
    // and not on controls or other interactive elements
    const target = e.target as HTMLElement;
    
    // Check for any interactive elements - be very permissive to avoid blocking menu clicks
    if (
      target.closest('button') || 
      target.closest('input') ||
      target.closest('select') ||
      target.closest('[data-player-menu]') ||
      target.closest('[class*="settings"]') || 
      target.closest('[class*="controls"]') ||
      target.closest('[class*="Menu"]') ||
      target.closest('[class*="menu"]') ||
      target.closest('[role="menu"]') ||
      target.closest('[role="menuitem"]')
    ) {
      return;
    }
    togglePlay();
  }, []);

  // Handle mouse move - show controls and clear keyboard focus
  const handleMouseMove = useCallback(() => {
    resetControlsTimeout();
    // Clear keyboard focus when mouse is used
    if (focusedRow >= 0 || focusedControlIndex >= 0) {
      setFocusedRow(-1);
      setFocusedControlIndex(-1);
    }
  }, [resetControlsTimeout, focusedRow, focusedControlIndex]);

  return (
    <div
      ref={containerRef}
      className={`${styles.playerContainer} ${!showControls && isPlaying ? styles.hideCursor : ''}`}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => isPlaying && setShowControls(false)}
      onClick={handleContainerClick}
      data-tv-skip-navigation="true"
    >
      {/* PrimeSrc Turnstile solver — invisible, solves challenge in background */}
      <PrimeSrcTurnstile
        onToken={(token) => {
          setTurnstileToken(token);
          console.log('[VideoPlayer] PrimeSrc Turnstile token set');
        }}
        onError={(err) => console.warn('[VideoPlayer] Turnstile error:', err)}
      />

      {/* Back button - controlled by showControls */}
      {onBack && (showControls || !isPlaying) && (
        <button 
          onClick={(e) => { e.stopPropagation(); onBack(); }} 
          className={styles.backButton}
          data-player-back="true"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
          <span>Back</span>
        </button>
      )}

      {(isLoading || isBuffering) && (
        <div className={styles.loading}>
          <div className={styles.spinner} />
          <p>{isLoading ? 'Loading video...' : 'Buffering...'}</p>
          {isLoading && (
            <div className={styles.loadingHint}>
              <small>Extracting best quality source...</small>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className={styles.error}>
          <div className={styles.errorContent}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <h3>Playback Error</h3>
            <p>{error}</p>
            <div className={styles.errorActions}>
              <button onClick={handleRetry} className={styles.retryButton}>
                Retry
              </button>
            </div>
            <div className={styles.serverHint}>
              <p>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.5 19c0-3.037-2.463-5.5-5.5-5.5S6.5 15.963 6.5 19" />
                  <path d="M17.5 19c2.485 0 4.5-2.015 4.5-4.5S19.985 10 17.5 10c-.163 0-.322.01-.48.028C16.54 6.608 13.567 4 10 4 5.582 4 2 7.582 2 12c0 3.657 2.475 6.72 5.91 7.68" />
                </svg>
                Try a different server using the cloud button in the top right
              </p>
            </div>
          </div>
        </div>
      )}

      {showVolumeIndicator && (
        <div className={styles.volumeIndicator}>
          <div className={styles.volumeIndicatorIcon}>
            {isMuted || volume === 0 ? (
              <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
              </svg>
            ) : (
              <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z" />
              </svg>
            )}
          </div>
          <div className={styles.volumeIndicatorBar}>
            <div
              className={styles.volumeIndicatorFill}
              style={{ height: `${isMuted ? 0 : volume * 100}%` }}
            />
          </div>
          <div className={styles.volumeIndicatorText}>
            {Math.round((isMuted ? 0 : volume) * 100)}%
          </div>
        </div>
      )}

      {/* Subtitle offset indicator */}
      {showSubtitleOffsetIndicator && (
        <div 
          style={{
            position: 'absolute',
            top: '15%',
            left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor: 'rgba(0, 0, 0, 0.85)',
            color: 'white',
            padding: '12px 24px',
            borderRadius: '8px',
            fontSize: '1rem',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            zIndex: 100,
            animation: 'fadeIn 0.2s ease',
            backdropFilter: 'blur(4px)',
          }}
        >
          <span style={{ fontSize: '1.25rem' }}>📝</span>
          <span>
            Subtitle Sync: {subtitleOffset > 0 ? '+' : ''}{subtitleOffset.toFixed(1)}s
          </span>
        </div>
      )}

      {/* Playback speed indicator */}
      {showSpeedIndicator && (
        <div 
          style={{
            position: 'absolute',
            top: '15%',
            left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor: 'rgba(0, 0, 0, 0.85)',
            color: 'white',
            padding: '12px 24px',
            borderRadius: '8px',
            fontSize: '1rem',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            zIndex: 100,
            animation: 'fadeIn 0.2s ease',
            backdropFilter: 'blur(4px)',
          }}
        >
          <span style={{ fontSize: '1.25rem' }}>⏩</span>
          <span>
            Speed: {playbackSpeed}x {playbackSpeed === 1 && '(Normal)'}
          </span>
        </div>
      )}

      {/* Cast error/help notification */}
      {castError && (
        <div 
          style={{
            position: 'absolute',
            bottom: '100px',
            left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor: castError.includes('LG') || castError.includes('Samsung') || castError.includes('Cast tab') || castError.includes('laggy')
              ? 'rgba(59, 130, 246, 0.95)' // Blue for help/info
              : 'rgba(220, 38, 38, 0.95)', // Red for errors
            color: 'white',
            padding: '16px 20px',
            borderRadius: '12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            zIndex: 100,
            maxWidth: '420px',
            width: '90%',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
            animation: 'fadeIn 0.2s ease-out',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M1 18v3h3c0-1.66-1.34-3-3-3z" />
              <path d="M1 14v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7z" />
              <path d="M1 10v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z" />
              <path d="M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
            </svg>
            <span style={{ fontSize: '14px', fontWeight: 500, flex: 1 }}>
              {castError.includes('LG') || castError.includes('Samsung') || castError.includes('Cast tab') 
                ? 'How to Cast to Smart TV' 
                : 'Cast Info'}
            </span>
            <button 
              onClick={(e) => { e.stopPropagation(); setCastError(null); }}
              style={{
                background: 'rgba(255,255,255,0.2)',
                border: 'none',
                color: 'white',
                cursor: 'pointer',
                padding: '4px 8px',
                borderRadius: '4px',
                fontSize: '12px',
              }}
            >
              ✕
            </button>
          </div>
          <div style={{ fontSize: '13px', opacity: 0.95, lineHeight: 1.5 }}>
            {castError.includes('LG') || castError.includes('Samsung') || castError.includes('Cast tab') ? (
              <>
                <p style={{ margin: '0 0 8px 0' }}>LG & Samsung TVs use screen mirroring:</p>
                <ol style={{ margin: 0, paddingLeft: '20px', fontSize: '12px' }}>
                  <li>Click Chrome menu (⋮) → Cast</li>
                  <li>Click "Sources" dropdown</li>
                  <li>Select "Cast tab"</li>
                  <li>Choose your TV</li>
                </ol>
                <p style={{ margin: '8px 0 0 0', fontSize: '11px', opacity: 0.8 }}>
                  💡 Tip: Tab casting mirrors your screen. For smoother playback, use a Chromecast device.
                </p>
              </>
            ) : (
              <p style={{ margin: 0 }}>{castError}</p>
            )}
          </div>
        </div>
      )}

      {/* Cast Tips Modal */}
      {showCastTips && (
        <div 
          style={{
            position: 'absolute',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.9)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 200,
            padding: '20px',
          }}
          onClick={() => setShowCastTips(false)}
        >
          <div 
            style={{
              backgroundColor: '#1a1a1a',
              borderRadius: '16px',
              padding: '24px',
              maxWidth: '500px',
              width: '100%',
              maxHeight: '80vh',
              overflow: 'auto',
              boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, fontSize: '1.25rem', color: 'white', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="#e50914">
                  <path d="M1 18v3h3c0-1.66-1.34-3-3-3z" />
                  <path d="M1 14v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7z" />
                  <path d="M1 10v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z" />
                  <path d="M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
                </svg>
                Cast to TV - Tips & Help
              </h2>
              <button 
                onClick={() => setShowCastTips(false)}
                style={{
                  background: 'rgba(255,255,255,0.1)',
                  border: 'none',
                  color: 'white',
                  cursor: 'pointer',
                  padding: '8px 12px',
                  borderRadius: '8px',
                  fontSize: '14px',
                }}
              >
                ✕
              </button>
            </div>

            {/* Windows Section */}
            <div style={{ marginBottom: '20px', padding: '16px', backgroundColor: 'rgba(59, 130, 246, 0.1)', borderRadius: '12px', border: '1px solid rgba(59, 130, 246, 0.3)' }}>
              <h3 style={{ margin: '0 0 12px 0', fontSize: '1rem', color: '#60a5fa', display: 'flex', alignItems: 'center', gap: '8px' }}>
                🖥️ Windows PC (Best Method)
              </h3>
              <p style={{ margin: '0 0 8px 0', fontSize: '14px', color: 'rgba(255,255,255,0.9)' }}>
                Use <strong>Windows + K</strong> for the best wireless display experience:
              </p>
              <ol style={{ margin: 0, paddingLeft: '20px', fontSize: '13px', color: 'rgba(255,255,255,0.8)', lineHeight: 1.6 }}>
                <li>Press <kbd style={{ background: '#333', padding: '2px 6px', borderRadius: '4px', fontSize: '12px' }}>Win</kbd> + <kbd style={{ background: '#333', padding: '2px 6px', borderRadius: '4px', fontSize: '12px' }}>K</kbd> on your keyboard</li>
                <li>Select your TV from the list of wireless displays</li>
                <li>Choose "Duplicate" or "Second screen only"</li>
                <li>Play the video in fullscreen for best quality</li>
              </ol>
              <p style={{ margin: '10px 0 0 0', fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>
                💡 This uses Miracast/Wi-Fi Direct for smoother playback than Chrome tab casting.
              </p>
            </div>

            {/* iOS/iPhone Section */}
            <div style={{ marginBottom: '20px', padding: '16px', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)' }}>
              <h3 style={{ margin: '0 0 12px 0', fontSize: '1rem', color: 'white', display: 'flex', alignItems: 'center', gap: '8px' }}>
                📱 iPhone / iPad (AirPlay)
              </h3>
              <ol style={{ margin: 0, paddingLeft: '20px', fontSize: '13px', color: 'rgba(255,255,255,0.8)', lineHeight: 1.6 }}>
                <li>Tap the AirPlay button in the player (or use Control Center)</li>
                <li>Select your Apple TV or AirPlay-compatible TV</li>
                <li>Video will play directly on your TV</li>
              </ol>
              <p style={{ margin: '10px 0 0 0', fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>
                ✅ AirPlay sends the stream directly to your TV for smooth playback.
              </p>
            </div>

            {/* Android Section */}
            <div style={{ marginBottom: '20px', padding: '16px', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)' }}>
              <h3 style={{ margin: '0 0 12px 0', fontSize: '1rem', color: 'white', display: 'flex', alignItems: 'center', gap: '8px' }}>
                🤖 Android
              </h3>
              <p style={{ margin: '0 0 10px 0', fontSize: '13px', color: 'rgba(255,255,255,0.9)' }}>
                <strong>Option 1:</strong> Tap the Cast button (works with Chromecast devices)
              </p>
              <p style={{ margin: '0 0 8px 0', fontSize: '13px', color: 'rgba(255,255,255,0.9)' }}>
                <strong>Option 2 (Recommended):</strong> Use Screen Mirroring:
              </p>
              <ol style={{ margin: 0, paddingLeft: '20px', fontSize: '13px', color: 'rgba(255,255,255,0.8)', lineHeight: 1.6 }}>
                <li>Swipe down for Quick Settings on your phone</li>
                <li>Tap "Smart View" / "Screen Cast" / "Wireless Display"</li>
                <li>Select your TV from the list</li>
              </ol>
              <p style={{ margin: '10px 0 0 0', fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>
                💡 Screen mirroring works with all TVs and all stream types.
              </p>
            </div>

            {/* Smart TV Section - IMPORTANT WARNING */}
            <div style={{ marginBottom: '20px', padding: '16px', backgroundColor: 'rgba(255, 193, 7, 0.15)', borderRadius: '12px', border: '1px solid rgba(255, 193, 7, 0.4)' }}>
              <h3 style={{ margin: '0 0 12px 0', fontSize: '1rem', color: '#ffc107', display: 'flex', alignItems: 'center', gap: '8px' }}>
                ⚠️ LG / Samsung Smart TVs - IMPORTANT
              </h3>
              <p style={{ margin: '0 0 10px 0', fontSize: '14px', color: 'rgba(255,255,255,0.95)', fontWeight: 500 }}>
                These TVs do NOT have native Chromecast support!
              </p>
              <p style={{ margin: '0 0 10px 0', fontSize: '13px', color: 'rgba(255,255,255,0.85)' }}>
                The cast button will connect but video won't play. You must use screen mirroring instead:
              </p>
              <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px', color: 'rgba(255,255,255,0.8)', lineHeight: 1.6 }}>
                <li><strong>Best:</strong> Press <kbd style={{ background: '#333', padding: '2px 6px', borderRadius: '4px', fontSize: '12px' }}>Win</kbd> + <kbd style={{ background: '#333', padding: '2px 6px', borderRadius: '4px', fontSize: '12px' }}>K</kbd> (Windows wireless display)</li>
                <li><strong>Chrome:</strong> Menu (⋮) → Cast → Sources → <strong>Cast tab</strong></li>
                <li><strong>Android:</strong> Quick Settings → Smart View / Screen Cast</li>
              </ul>
              <p style={{ margin: '12px 0 0 0', fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>
                💡 For smooth native casting, consider buying a Chromecast device (~$30). It plugs into your TV's HDMI port and enables true Chromecast support.
              </p>
            </div>

            {/* Troubleshooting */}
            <div style={{ padding: '16px', backgroundColor: 'rgba(229, 9, 20, 0.1)', borderRadius: '12px', border: '1px solid rgba(229, 9, 20, 0.3)' }}>
              <h3 style={{ margin: '0 0 12px 0', fontSize: '1rem', color: '#f87171', display: 'flex', alignItems: 'center', gap: '8px' }}>
                🔧 Troubleshooting
              </h3>
              <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px', color: 'rgba(255,255,255,0.8)', lineHeight: 1.6 }}>
                <li>Make sure your TV and device are on the same WiFi network</li>
                <li>Try restarting your TV or Chromecast</li>
                <li>For laggy playback, try lowering the video quality</li>
                <li>Right-click casting is always laggy - use the cast button instead</li>
              </ul>
            </div>

            <button 
              onClick={() => setShowCastTips(false)}
              style={{
                width: '100%',
                marginTop: '20px',
                padding: '12px',
                backgroundColor: '#e50914',
                border: 'none',
                borderRadius: '8px',
                color: 'white',
                fontSize: '14px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Got it!
            </button>
          </div>
        </div>
      )}

      {/* Video wrapper for pinch-to-zoom on mobile */}
      <div
        {...zoomContainerProps}
        className={styles.videoWrapper}
      >
        <video
          ref={videoRef}
          className={styles.video}
          style={zoomContentStyle}
          playsInline
          autoPlay={false}
          controls={false}
          preload="metadata"
          // @ts-ignore - iOS/Safari specific attributes
          x-webkit-airplay="allow"
          // @ts-ignore
          webkit-playsinline="true"
          // @ts-ignore - Allow AirPlay
          airplay="allow"
          // @ts-ignore - Disable picture-in-picture on iOS if needed
          disablePictureInPicture={false}
        />
      </div>

      {/* Zoom indicator */}
      {showZoomIndicator && (
        <div className={styles.zoomIndicator}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
            <path d="M12 10h-2v2H9v-2H7V9h2V7h1v2h2v1z"/>
          </svg>
          <span>{Math.round(zoomScale * 100)}%</span>
        </div>
      )}

      {/* Reset zoom button - hides with controls */}
      {isZoomed && (showControls || !isPlaying) && (
        <button
          className={styles.resetZoomButton}
          onClick={(e) => {
            e.stopPropagation();
            resetZoom();
          }}
          title="Reset zoom"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
            <path d="M7 9h5v1H7z"/>
          </svg>
          <span>1x</span>
        </button>
      )}

      {/* Skip Intro Button */}
      {showSkipIntroButton && skipIntro && (
        <button
          className={styles.skipButton}
          onClick={(e) => {
            e.stopPropagation();
            if (videoRef.current && skipIntro) {
              videoRef.current.currentTime = skipIntro[1];
              setShowSkipIntroButton(false);
            }
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
          </svg>
          <span>Skip Intro</span>
        </button>
      )}

      {/* Skip Outro Button */}
      {showSkipOutroButton && skipOutro && (
        <button
          className={styles.skipButton}
          onClick={(e) => {
            e.stopPropagation();
            if (videoRef.current && skipOutro) {
              videoRef.current.currentTime = skipOutro[1];
              setShowSkipOutroButton(false);
            }
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
          </svg>
          <span>Skip Outro</span>
        </button>
      )}

      {/* Next Episode Button with integrated countdown timer */}
      {showNextEpisodeButton && nextEpisode && (
        <div className={styles.nextEpisodeContainer} onClick={(e) => e.stopPropagation()}>
          {/* Cancel button (X) */}
          <button
            className={styles.nextEpisodeDismiss}
            onClick={() => {
              cancelAutoPlay();
              setShowNextEpisodeButton(false);
            }}
            title="Dismiss"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
          
          <button
            className={styles.nextEpisodeButton}
            onClick={() => {
              console.log('[VideoPlayer] Next episode button clicked!');
              cancelAutoPlay();
              setShowNextEpisodeButton(false);
              const callback = onNextEpisodeRef.current || onNextEpisode;
              if (callback) {
                console.log('[VideoPlayer] Calling next episode callback from button click');
                callback();
              } else {
                console.error('[VideoPlayer] No callback available for next episode!');
              }
            }}
          >
            {/* Countdown circle */}
            {autoPlayCountdown !== null && autoPlayCountdown > 0 && (
              <div className={styles.nextEpisodeCountdown}>
                <svg viewBox="0 0 36 36" className={styles.countdownCircle}>
                  <circle
                    className={styles.countdownCircleBg}
                    cx="18"
                    cy="18"
                    r="16"
                  />
                  <circle
                    className={styles.countdownCircleProgress}
                    cx="18"
                    cy="18"
                    r="16"
                    style={{
                      strokeDasharray: `${2 * Math.PI * 16}`,
                      strokeDashoffset: `${2 * Math.PI * 16 * (1 - autoPlayCountdown / (playerPrefs.autoPlayCountdown || 10))}`,
                    }}
                  />
                </svg>
                <span className={styles.countdownNumber}>{autoPlayCountdown}</span>
              </div>
            )}
            
            <div className={styles.nextEpisodeInfo}>
              <span className={styles.nextEpisodeLabel}>
                {autoPlayCountdown !== null && autoPlayCountdown > 0 ? 'Playing in...' : 'Up Next'}
              </span>
              <span className={styles.nextEpisodeTitle}>
                {nextEpisode.isNextSeason && `S${nextEpisode.season} • `}
                {nextEpisode.title || `Episode ${nextEpisode.episode}`}
              </span>
            </div>
            
            <svg className={styles.nextEpisodeIcon} width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
            </svg>
          </button>
        </div>
      )}

      <div className={`${styles.controls} ${showControls || !isPlaying ? styles.visible : ''}`}>
        <div 
          className={styles.progressContainer} 
          data-player-timeline="true"
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            const pos = (e.clientX - rect.left) / rect.width;
            seek(pos * duration);
          }}
        >
          <div className={styles.progressBuffered} style={{ width: `${buffered}%` }} />
          <div className={styles.progressFilled} style={{ width: `${(currentTime / duration) * 100}%` }} />
          <div className={styles.progressThumb} style={{ left: `${(currentTime / duration) * 100}%` }} />
        </div>

        <div className={styles.controlsRow}>
          <div className={styles.leftControls}>
            <button onClick={(e) => { e.stopPropagation(); togglePlay(); }} className={styles.btn} data-player-control="play" title="Play/Pause">
              {isPlaying ? (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                </svg>
              ) : (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            <button onClick={(e) => { e.stopPropagation(); seek(currentTime - 10); }} className={styles.btn} data-player-control="rewind" title="Rewind 10s">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
                <text x="9" y="15" fontSize="8" fill="white" fontWeight="bold">10</text>
              </svg>
            </button>

            <button onClick={(e) => { e.stopPropagation(); seek(currentTime + 10); }} className={styles.btn} data-player-control="forward" title="Forward 10s">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z" />
                <text x="9" y="15" fontSize="8" fill="white" fontWeight="bold">10</text>
              </svg>
            </button>

            <button onClick={(e) => { e.stopPropagation(); toggleMute(); }} className={styles.btn} data-player-control="mute" title="Mute/Unmute">
              {isMuted || volume === 0 ? (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                </svg>
              ) : (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z" />
                </svg>
              )}
            </button>

            <div className={styles.volumeContainer} onClick={(e) => e.stopPropagation()}>
              <input
                type="range"
                min="0"
                max="100"
                value={isMuted ? 0 : volume * 100}
                onChange={(e) => handleVolumeChange(Number(e.target.value))}
                className={styles.volumeSlider}
                style={{ '--volume-percent': `${isMuted ? 0 : volume * 100}%` } as React.CSSProperties}
              />
            </div>

            <span className={styles.time}>
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          <div className={styles.rightControls}>
            <div className={styles.settingsContainer}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowSubtitles(!showSubtitles);
                  setShowSettings(false);
                }}
                className={`${styles.btn} ${currentSubtitle ? styles.active : ''}`}
                data-player-control="subtitles"
                title="Subtitles"
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z" />
                </svg>
              </button>

              {showSubtitles && (
                <div className={styles.settingsMenu} data-player-menu="subtitles" onClick={(e) => e.stopPropagation()}>
                  <div className={styles.settingsSection}>
                    <div className={styles.menuHeader}>
                      <div className={styles.settingsLabel}>Subtitles</div>
                      <button 
                        className={styles.menuCloseBtn}
                        onClick={(e) => { e.stopPropagation(); setShowSubtitles(false); }}
                        title="Close"
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18"></line>
                          <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                      </button>
                    </div>
                    <button
                      className={`${styles.settingsOption} ${!currentSubtitle ? styles.active : ''}`}
                      onClick={() => loadSubtitle(null)}
                    >
                      Off
                    </button>
                    {/* Custom uploaded subtitles */}
                    {customSubtitles.length > 0 && (
                      <div className={styles.sourcesList}>
                        <div style={{ padding: '0.5rem 1rem', color: 'rgba(255, 255, 255, 0.5)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                          Uploaded
                        </div>
                        {customSubtitles.map((subtitle) => (
                          <button
                            key={subtitle.id}
                            className={`${styles.settingsOption} ${currentSubtitle === subtitle.id ? styles.active : ''}`}
                            onClick={() => loadSubtitle(subtitle)}
                            title={subtitle.fileName}
                            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                          >
                            <span>📁</span>
                            <span style={{ 
                              overflow: 'hidden', 
                              textOverflow: 'ellipsis', 
                              whiteSpace: 'nowrap',
                              maxWidth: '180px'
                            }}>
                              {subtitle.fileName}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                    
                    {/* OpenSubtitles results */}
                    {subtitlesLoading ? (
                      <div style={{ padding: '0.75rem 1rem', color: 'rgba(255, 255, 255, 0.5)', fontSize: '0.875rem', fontStyle: 'italic' }}>
                        Loading subtitles...
                      </div>
                    ) : availableSubtitles.length > 0 ? (
                      <div className={styles.sourcesList}>
                        <div style={{ padding: '0.5rem 1rem', color: 'rgba(255, 255, 255, 0.5)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                          OpenSubtitles
                        </div>
                        {availableSubtitles.map((subtitle, index) => (
                          <button
                            key={index}
                            className={`${styles.settingsOption} ${currentSubtitle === subtitle.id ? styles.active : ''}`}
                            onClick={() => loadSubtitle(subtitle)}
                            title={`${subtitle.language} - ${subtitle.fileName || 'Subtitle'}`}
                          >
                            {subtitle.language}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div style={{ padding: '0.75rem 1rem', color: 'rgba(255, 255, 255, 0.5)', fontSize: '0.875rem', fontStyle: 'italic' }}>
                        No subtitles available
                      </div>
                    )}
                    
                    {/* Upload custom subtitle button */}
                    <button
                      className={styles.settingsOption}
                      onClick={() => subtitleFileInputRef.current?.click()}
                      style={{ borderTop: '1px solid rgba(255, 255, 255, 0.1)', marginTop: '0.5rem', paddingTop: '0.75rem' }}
                    >
                      📤 Upload VTT/SRT File
                    </button>
                    <input
                      ref={subtitleFileInputRef}
                      type="file"
                      accept=".vtt,.srt"
                      onChange={handleSubtitleFileUpload}
                      style={{ display: 'none' }}
                    />

                    <button
                      className={styles.settingsOption}
                      onClick={() => {
                        setShowSubtitleCustomization(!showSubtitleCustomization);
                        setShowSubtitles(false);
                      }}
                      style={{ borderTop: '1px solid rgba(255, 255, 255, 0.1)', marginTop: '0.5rem', paddingTop: '0.75rem' }}
                    >
                      ⚙️ Customize Appearance
                    </button>
                  </div>
                </div>
              )}

              {showSubtitleCustomization && (
                <div className={styles.settingsMenu} data-player-menu="subtitle-customization" onClick={(e) => e.stopPropagation()}>
                  <div className={styles.settingsSection}>
                    {/* Subtitle Sync Controls */}
                    <div className={styles.settingsLabel}>Subtitle Sync</div>
                    <div style={{ padding: '0.75rem 1rem' }}>
                      <div style={{ 
                        color: 'rgba(255, 255, 255, 0.8)', 
                        fontSize: '0.875rem', 
                        marginBottom: '0.75rem',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center'
                      }}>
                        <span>Offset: {subtitleOffset > 0 ? '+' : ''}{subtitleOffset.toFixed(1)}s</span>
                        {subtitleOffset !== 0 && (
                          <button
                            onClick={resetSubtitleOffset}
                            style={{
                              background: 'rgba(229, 9, 20, 0.3)',
                              border: '1px solid rgba(229, 9, 20, 0.5)',
                              borderRadius: '4px',
                              color: '#fff',
                              padding: '2px 8px',
                              fontSize: '0.75rem',
                              cursor: 'pointer',
                            }}
                          >
                            Reset
                          </button>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                        <button
                          onClick={() => adjustSubtitleOffset(-5)}
                          style={{
                            background: 'rgba(255, 255, 255, 0.1)',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '4px',
                            color: '#fff',
                            padding: '6px 10px',
                            fontSize: '0.8rem',
                            cursor: 'pointer',
                          }}
                        >
                          -5s
                        </button>
                        <button
                          onClick={() => adjustSubtitleOffset(-1)}
                          style={{
                            background: 'rgba(255, 255, 255, 0.1)',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '4px',
                            color: '#fff',
                            padding: '6px 10px',
                            fontSize: '0.8rem',
                            cursor: 'pointer',
                          }}
                        >
                          -1s
                        </button>
                        <button
                          onClick={() => adjustSubtitleOffset(-0.5)}
                          style={{
                            background: 'rgba(255, 255, 255, 0.1)',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '4px',
                            color: '#fff',
                            padding: '6px 10px',
                            fontSize: '0.8rem',
                            cursor: 'pointer',
                          }}
                        >
                          -0.5s
                        </button>
                        <button
                          onClick={() => adjustSubtitleOffset(0.5)}
                          style={{
                            background: 'rgba(255, 255, 255, 0.1)',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '4px',
                            color: '#fff',
                            padding: '6px 10px',
                            fontSize: '0.8rem',
                            cursor: 'pointer',
                          }}
                        >
                          +0.5s
                        </button>
                        <button
                          onClick={() => adjustSubtitleOffset(1)}
                          style={{
                            background: 'rgba(255, 255, 255, 0.1)',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '4px',
                            color: '#fff',
                            padding: '6px 10px',
                            fontSize: '0.8rem',
                            cursor: 'pointer',
                          }}
                        >
                          +1s
                        </button>
                        <button
                          onClick={() => adjustSubtitleOffset(5)}
                          style={{
                            background: 'rgba(255, 255, 255, 0.1)',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '4px',
                            color: '#fff',
                            padding: '6px 10px',
                            fontSize: '0.8rem',
                            cursor: 'pointer',
                          }}
                        >
                          +5s
                        </button>
                      </div>
                      <div style={{ 
                        color: 'rgba(255, 255, 255, 0.5)', 
                        fontSize: '0.7rem', 
                        marginTop: '0.5rem',
                        textAlign: 'center'
                      }}>
                        Use + if subtitles appear too early, - if too late
                      </div>
                    </div>
                    
                    <div className={styles.settingsLabel} style={{ marginTop: '0.5rem' }}>Subtitle Appearance</div>
                    <div style={{ padding: '0.75rem 1rem' }}>
                      <div style={{ color: 'rgba(255, 255, 255, 0.8)', fontSize: '0.875rem', marginBottom: '0.5rem' }}>
                        Font Size: {subtitleStyle.fontSize}%
                      </div>
                      <input
                        type="range"
                        min="50"
                        max="200"
                        value={subtitleStyle.fontSize}
                        onChange={(e) => updateSubtitleStyle({ fontSize: Number(e.target.value) })}
                        className={styles.volumeSlider}
                        style={{ width: '100%' }}
                      />
                    </div>
                    <div style={{ padding: '0.75rem 1rem' }}>
                      <div style={{ color: 'rgba(255, 255, 255, 0.8)', fontSize: '0.875rem', marginBottom: '0.5rem' }}>
                        Background Opacity: {subtitleStyle.backgroundOpacity}%
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={subtitleStyle.backgroundOpacity}
                        onChange={(e) => updateSubtitleStyle({ backgroundOpacity: Number(e.target.value) })}
                        className={styles.volumeSlider}
                        style={{ width: '100%' }}
                      />
                    </div>
                    <div style={{ padding: '0.75rem 1rem' }}>
                      <div style={{ color: 'rgba(255, 255, 255, 0.8)', fontSize: '0.875rem', marginBottom: '0.5rem' }}>
                        Text Color
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                        {['#ffffff', '#ffff00', '#00ff00', '#00ffff', '#ff00ff'].map(color => (
                          <button
                            key={color}
                            onClick={() => updateSubtitleStyle({ textColor: color })}
                            style={{
                              width: '32px',
                              height: '32px',
                              borderRadius: '4px',
                              backgroundColor: color,
                              border: subtitleStyle.textColor === color ? '2px solid #e50914' : '2px solid rgba(255, 255, 255, 0.3)',
                              cursor: 'pointer',
                            }}
                          />
                        ))}
                      </div>
                    </div>
                    <div style={{ padding: '0.75rem 1rem' }}>
                      <div style={{ color: 'rgba(255, 255, 255, 0.8)', fontSize: '0.875rem', marginBottom: '0.5rem' }}>
                        Vertical Position: {subtitleStyle.verticalPosition}% {subtitleStyle.verticalPosition < 30 ? '(Top)' : subtitleStyle.verticalPosition > 70 ? '(Bottom)' : '(Middle)'}
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={subtitleStyle.verticalPosition}
                        onChange={(e) => updateSubtitleStyle({ verticalPosition: Number(e.target.value) })}
                        className={styles.volumeSlider}
                        style={{ width: '100%' }}
                      />
                    </div>
                    <button
                      className={styles.settingsOption}
                      onClick={() => {
                        setShowSubtitleCustomization(false);
                        setShowSubtitles(true);
                      }}
                      style={{ borderTop: '1px solid rgba(255, 255, 255, 0.1)', marginTop: '0.5rem' }}
                    >
                      ← Back to Subtitles
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Resolution/Quality button - only for HLS quality levels */}
            <div className={styles.settingsContainer}>
              <button onClick={(e) => {
                e.stopPropagation();
                setShowSettings(!showSettings);
                setShowSubtitles(false);
                setShowServerMenu(false);
              }} className={styles.btn} data-player-control="settings" title="Resolution">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94L14.4 2.81c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
                </svg>
              </button>

              {showSettings && (
                <div className={styles.settingsMenu} data-player-menu="settings" onClick={(e) => e.stopPropagation()}>
                  <div className={styles.settingsSection}>
                    <div className={styles.menuHeader}>
                      <div className={styles.settingsLabel}>
                        Resolution {currentResolution && <span style={{ opacity: 0.7, fontSize: '0.85em' }}>({currentResolution})</span>}
                      </div>
                      <button 
                        className={styles.menuCloseBtn}
                        onClick={(e) => { e.stopPropagation(); setShowSettings(false); }}
                        title="Close"
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18"></line>
                          <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                      </button>
                    </div>
                    <div className={styles.sourcesList}>
                      {hlsLevels.length > 0 ? (
                        <>
                          <button
                            className={`${styles.settingsOption} ${currentHlsLevel === -1 ? styles.active : ''}`}
                            onClick={() => changeHlsLevel(-1)}
                          >
                            Auto
                          </button>
                          {hlsLevels.map((level) => (
                            <button
                              key={level.index}
                              className={`${styles.settingsOption} ${currentHlsLevel === level.index ? styles.active : ''}`}
                              onClick={() => changeHlsLevel(level.index)}
                            >
                              {level.height}p
                            </button>
                          ))}
                        </>
                      ) : (
                        <div className={styles.settingsOption} style={{ opacity: 0.6, cursor: 'default' }}>
                          {currentResolution || 'Auto'}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Playback Speed */}
                  <div className={styles.settingsSection} style={{ borderTop: '1px solid rgba(255, 255, 255, 0.1)', marginTop: '0.5rem', paddingTop: '0.75rem' }}>
                    <div className={styles.settingsLabel}>
                      Playback Speed <span style={{ opacity: 0.7, fontSize: '0.85em' }}>({playbackSpeed}x)</span>
                    </div>
                    <div className={styles.sourcesList}>
                      {speedOptions.map((speed) => (
                        <button
                          key={speed}
                          className={`${styles.settingsOption} ${playbackSpeed === speed ? styles.active : ''}`}
                          onClick={() => changeSpeed(speed)}
                        >
                          {speed}x {speed === 1 && <span style={{ opacity: 0.6, marginLeft: '0.5rem' }}>(Normal)</span>}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Auto-play settings - only show for TV shows */}
                  {mediaType === 'tv' && (
                    <div className={styles.settingsSection} style={{ borderTop: '1px solid rgba(255, 255, 255, 0.1)', marginTop: '0.5rem', paddingTop: '0.75rem' }}>
                      <div className={styles.settingsLabel}>Next Episode</div>
                      <button
                        className={styles.settingsOption}
                        onClick={() => {
                          const newValue = !playerPrefs.autoPlayNextEpisode;
                          setAutoPlayNextEpisode(newValue);
                          setPlayerPrefs(prev => ({ ...prev, autoPlayNextEpisode: newValue }));
                        }}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                      >
                        <span>Auto-play next</span>
                        <span style={{
                          width: '40px',
                          height: '22px',
                          borderRadius: '11px',
                          backgroundColor: playerPrefs.autoPlayNextEpisode ? '#e50914' : 'rgba(255, 255, 255, 0.2)',
                          position: 'relative',
                          transition: 'background-color 0.2s',
                        }}>
                          <span style={{
                            position: 'absolute',
                            top: '2px',
                            left: playerPrefs.autoPlayNextEpisode ? '20px' : '2px',
                            width: '18px',
                            height: '18px',
                            borderRadius: '50%',
                            backgroundColor: '#fff',
                            transition: 'left 0.2s',
                          }} />
                        </span>
                      </button>
                      {playerPrefs.autoPlayNextEpisode && (
                        <div style={{ padding: '0.5rem 1rem' }}>
                          <div style={{ color: 'rgba(255, 255, 255, 0.7)', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                            Countdown timer: {playerPrefs.autoPlayCountdown}s
                          </div>
                          <input
                            type="range"
                            min="5"
                            max="30"
                            step="5"
                            value={playerPrefs.autoPlayCountdown}
                            onChange={(e) => {
                              const newValue = Number(e.target.value);
                              setAutoPlayCountdown(newValue);
                              setPlayerPrefs(prev => ({ ...prev, autoPlayCountdown: newValue }));
                            }}
                            className={styles.volumeSlider}
                            style={{ width: '100%' }}
                          />
                        </div>
                      )}
                      <div style={{ padding: '0.5rem 1rem' }}>
                        <div style={{ color: 'rgba(255, 255, 255, 0.7)', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                          Show &quot;Up Next&quot; before end: {playerPrefs.showNextEpisodeBeforeEnd || 90}s
                        </div>
                        <input
                          type="range"
                          min="30"
                          max="180"
                          step="15"
                          value={playerPrefs.showNextEpisodeBeforeEnd || 90}
                          onChange={(e) => {
                            const newValue = Number(e.target.value);
                            setShowNextEpisodeBeforeEnd(newValue);
                            setPlayerPrefs(prev => ({ ...prev, showNextEpisodeBeforeEnd: newValue }));
                          }}
                          className={styles.volumeSlider}
                          style={{ width: '100%' }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Cast to TV / AirPlay button - always visible */}
            <button 
              onClick={handleCastClick} 
              className={`${styles.btn} ${cast.isCasting || cast.isAirPlayActive ? styles.active : ''}`}
              data-player-control="cast"
              title={cast.isCasting || cast.isAirPlayActive 
                ? 'Stop casting' 
                : cast.isAirPlayAvailable 
                  ? 'AirPlay to Apple TV' 
                  : 'Cast (Chromecast supported, LG/Samsung use Cast Tab)'}
            >
              {cast.isAirPlayAvailable ? (
                // AirPlay icon
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  {cast.isAirPlayActive ? (
                    // AirPlay active
                    <>
                      <path d="M6 22h12l-6-6-6 6z" />
                      <path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h4v-2H3V5h18v12h-4v2h4c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
                      <path d="M12 16l6 6H6l6-6z" opacity="0.3" />
                    </>
                  ) : (
                    // AirPlay available
                    <>
                      <path d="M6 22h12l-6-6-6 6z" />
                      <path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h4v-2H3V5h18v12h-4v2h4c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
                    </>
                  )}
                </svg>
              ) : (
                // Chromecast icon
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  {cast.isCasting ? (
                    <>
                      <path d="M1 18v3h3c0-1.66-1.34-3-3-3z" />
                      <path d="M1 14v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7z" />
                      <path d="M1 10v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z" />
                      <path d="M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
                      <path d="M5 7v2h12v8h-4v2h6V7z" opacity="0.3" />
                    </>
                  ) : (
                    <>
                      <path d="M1 18v3h3c0-1.66-1.34-3-3-3z" />
                      <path d="M1 14v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7z" />
                      <path d="M1 10v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z" />
                      <path d="M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
                    </>
                  )}
                </svg>
              )}
            </button>

            {/* Cast Tips button */}
            <button 
              onClick={(e) => { e.stopPropagation(); setShowCastTips(true); }}
              className={styles.btn}
              data-player-control="cast-tips"
              title="Cast Tips & Help"
              style={{ fontSize: '12px', fontWeight: 600 }}
            >
              ?
            </button>

            {/* Transcript button - desktop only */}
            <TranscriptButton
              currentTime={currentTime}
              onSeek={seek}
              subtitleData={currentSubtitleDataRef.current ? {
                url: currentSubtitleDataRef.current.url,
                language: currentSubtitleDataRef.current.language,
                langCode: currentSubtitleDataRef.current.langCode,
                iso639: currentSubtitleDataRef.current.iso639,
                isCustom: currentSubtitleDataRef.current.isCustom,
              } : null}
              disabled={!currentSubtitle}
            />

            {/* Copy URL button - for external players */}
            {streamUrl && (
              <CopyUrlButton url={streamUrl} />
            )}

            <button onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }} className={styles.btn} data-player-control="fullscreen" title="Fullscreen">
              {isFullscreen ? (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
                </svg>
              ) : (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {(showControls || !isPlaying) && (
        <div style={{
          position: 'absolute',
          top: '2rem',
          right: '2rem',
          zIndex: 20,
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          pointerEvents: 'auto',
        }}>
          {/* Dub/Sub toggle - show for anime content when anime sources exist */}
          {isAnimeContent && (
            provider === 'animekai' || provider === 'hianime' ||
            (sourcesCache['animekai'] && sourcesCache['animekai'].length > 0) ||
            (sourcesCache['hianime'] && sourcesCache['hianime'].length > 0)
          ) && (
            <button 
              data-player-top-control="subdub"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                background: 'rgba(0,0,0,0.6)',
                backdropFilter: 'blur(4px)',
                padding: '6px 10px',
                borderRadius: '20px',
                cursor: 'pointer',
                border: 'none',
              }}
              onClick={async (e) => {
                e.stopPropagation();
                const newPref = animeAudioPref === 'sub' ? 'dub' : 'sub';
                setAnimeAudioPref(newPref);
                saveProviderSettings({ animeAudioPreference: newPref });
                
                // Save current position before switching
                if (videoRef.current && videoRef.current.currentTime > 0) {
                  pendingSeekTimeRef.current = videoRef.current.currentTime;
                }
                
                // Find a matching source within the CURRENT provider first.
                // The sub/dub toggle should NOT jump between provider tabs —
                // each provider tab (AnimeKai, HiAnime) has its own sub+dub sources,
                // and the toggle just filters which ones are shown/played.
                const currentAnimeProvider = (provider === 'animekai' || provider === 'hianime') ? provider : 
                  (sourcesCache['animekai']?.length ? 'animekai' : sourcesCache['hianime']?.length ? 'hianime' : provider);
                const sources = sourcesCache[currentAnimeProvider] || availableSources;
                const matchingSource = sources.find((s: any) => 
                  s.title && sourceMatchesAudioPreference(s.title, newPref)
                );
                
                if (matchingSource) {
                  console.log(`[VideoPlayer] Switching to ${newPref} on ${currentAnimeProvider}:`, matchingSource.title);
                  
                  // If source needs fetching (or was previously marked down), fetch it
                  if (matchingSource.status === 'unknown' || matchingSource.status === 'down' || !matchingSource.url) {
                    setIsLoading(true);
                    const sourceName = matchingSource.title?.split(' (')[0] || matchingSource.title;
                    try {
                      const params = new URLSearchParams({
                        tmdbId,
                        type: mediaType,
                        provider: currentAnimeProvider,
                        source: sourceName,
                      });
                      if (mediaType === 'tv' && season && episode) {
                        params.append('season', season.toString());
                        params.append('episode', episode.toString());
                      }
                      const response = await fetch(`/api/stream/extract?${params}`);
                      const data = await response.json();
                      if (data.success && data.sources?.[0]?.url) {
                        const newIndex = sources.findIndex((s: any) => s.title === matchingSource.title);
                        setCurrentSourceIndex(newIndex >= 0 ? newIndex : 0);
                        setStreamUrl(applyStreamProxy(data.sources[0].url, currentAnimeProvider, data.sources[0].requiresSegmentProxy));
                        setProvider(currentAnimeProvider);
                        setPreferredAnimeKaiServer(sourceName);
                      }
                    } catch (err) {
                      console.error('[VideoPlayer] Failed to fetch source:', err);
                      pendingSeekTimeRef.current = null;
                    } finally {
                      setIsLoading(false);
                    }
                  } else {
                    // Source already has URL, switch directly
                    const newIndex = sources.findIndex((s: any) => s.title === matchingSource.title);
                    setCurrentSourceIndex(newIndex >= 0 ? newIndex : 0);
                    setStreamUrl(applyStreamProxy(matchingSource.url, currentAnimeProvider, matchingSource.requiresSegmentProxy));
                    setProvider(currentAnimeProvider);
                    const serverName = matchingSource.title?.split(' (')[0];
                    if (serverName) setPreferredAnimeKaiServer(serverName);
                  }
                } else {
                  console.log(`[VideoPlayer] No ${newPref} sources available on ${currentAnimeProvider}`);
                }
              }}
              title={`Switch to ${animeAudioPref === 'sub' ? 'Dubbed' : 'Subbed'}`}
            >
              <span style={{ 
                fontSize: '0.75rem', 
                fontWeight: 600,
                color: animeAudioPref === 'sub' ? '#3b82f6' : 'rgba(255,255,255,0.5)',
                transition: 'color 0.2s'
              }}>
                SUB
              </span>
              <div style={{
                width: '36px',
                height: '20px',
                borderRadius: '10px',
                backgroundColor: animeAudioPref === 'dub' ? '#8b5cf6' : '#3b82f6',
                position: 'relative',
                transition: 'background-color 0.2s ease'
              }}>
                <span style={{
                  position: 'absolute',
                  top: '2px',
                  left: animeAudioPref === 'dub' ? '18px' : '2px',
                  width: '16px',
                  height: '16px',
                  borderRadius: '50%',
                  backgroundColor: '#fff',
                  transition: 'left 0.2s ease',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.3)'
                }} />
              </div>
              <span style={{ 
                fontSize: '0.75rem', 
                fontWeight: 600,
                color: animeAudioPref === 'dub' ? '#8b5cf6' : 'rgba(255,255,255,0.5)',
                transition: 'color 0.2s'
              }}>
                DUB
              </span>
            </button>
          )}
          
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowServerMenu(!showServerMenu);
              setShowSettings(false);
              setShowSubtitles(false);
              setHighlightServerButton(false); // Clear highlight when clicked
              // Initialize menu provider to current provider when opening
              // Always show the tab of the provider that's currently playing
              if (!showServerMenu) {
                setMenuProvider(provider);
              }
            }}
            className={`${styles.btn} ${highlightServerButton ? styles.serverButtonHighlight : ''}`}
            data-player-top-control="server"
            style={{
              background: 'rgba(0,0,0,0.5)',
              backdropFilter: 'blur(4px)',
              padding: '0.75rem',
              borderRadius: '50%'
            }}
            title="Servers"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17.5 19c0-3.037-2.463-5.5-5.5-5.5S6.5 15.963 6.5 19" />
              <path d="M17.5 19c2.485 0 4.5-2.015 4.5-4.5S19.985 10 17.5 10c-.163 0-.322.01-.48.028C16.54 6.608 13.567 4 10 4 5.582 4 2 7.582 2 12c0 3.657 2.475 6.72 5.91 7.68" />
            </svg>
          </button>

          {showServerMenu && (
            <div className={styles.settingsMenu} data-player-menu="server" style={{ top: '100%', right: 0, bottom: 'auto', marginTop: '0.5rem', minWidth: '280px', zIndex: 200 }} onClick={(e) => e.stopPropagation()}>
              <div className={styles.settingsSection}>
                <div className={styles.menuHeader}>
                  <div className={styles.settingsLabel}>Server Selection</div>
                  <button 
                    className={styles.menuCloseBtn}
                    onClick={(e) => { e.stopPropagation(); setShowServerMenu(false); }}
                    title="Close"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"></line>
                      <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                  </button>
                </div>

                {/* Provider tabs rendered in user's preferred order */}
                <div className={styles.tabsContainer} data-server-tabs="true">
                  {providerTabOrder
                    .filter(p => providerAvailability[p])
                    .filter(p => tmdbId !== '0' || ['hianime', 'animekai'].includes(p))
                    .map(p => {
                      const displayNames: Record<string, string> = {
                        videasy: 'Videasy',
                        flixer: 'Flixer',
                        uflix: 'Uflix',
                        hexa: 'Hexa',
                        vidsrc: 'VidSrc',
                        '1movies': '1movies',
                        hianime: 'HiAnime',
                        animekai: 'AnimeKai',
                      };
                      return (
                        <button
                          key={p}
                          className={`${styles.tab} ${menuProvider === p ? styles.active : ''}`}
                          data-server-tab={p}
                          onClick={() => {
                            setMenuProvider(p);
                            fetchSources(p);
                          }}
                        >
                          {displayNames[p] || p}
                        </button>
                      );
                    })}
                </div>

                <div className={styles.sourcesList} data-server-sources="true">
                  {loadingProviders[menuProvider] ? (
                    <div style={{ padding: '1rem', textAlign: 'center', color: 'rgba(255,255,255,0.5)', fontSize: '0.9rem' }}>
                      Loading sources...
                    </div>
                  ) : sourcesCache[menuProvider] && sourcesCache[menuProvider].length > 0 ? (
                    (() => {
                      // Tag each source with its original index in the unfiltered cache
                      const allSources = sourcesCache[menuProvider]
                        .map((s: any, i: number) => s != null ? { ...s, _origIdx: i } : null)
                        .filter((s: any) => s != null);
                      const isAnimeProvider = menuProvider === 'animekai' || menuProvider === 'hianime';
                      
                      if (isAnimeProvider) {
                        // Filter by dub/sub preference for anime providers
                        const filtered = allSources.filter((s: any) => s.title && sourceMatchesAudioPreference(s.title, animeAudioPref));
                        // If filter removes everything, show all sources (don't leave empty)
                        return filtered.length > 0 ? filtered : allSources;
                      }
                      return allSources;
                    })()
                      .map((source: any) => {
                      const origIdx = source._origIdx as number;
                      return (
                      <button
                        key={origIdx}
                        className={`${styles.settingsOption} ${provider === menuProvider && currentSourceIndex === origIdx ? styles.active : ''}`}
                        data-server-source={origIdx}
                        onClick={async () => {
                          // Save current playback position before switching sources
                          if (videoRef.current && videoRef.current.currentTime > 0) {
                            pendingSeekTimeRef.current = videoRef.current.currentTime;
                            console.log('[VideoPlayer] Saving playback position:', pendingSeekTimeRef.current);
                          }
                          
                          // If source has "unknown" or "down" status (not yet fetched, or previously failed), fetch it
                          // "down" sources should be re-fetchable — the user explicitly clicked it, so give it another shot
                          if ((source.status === 'unknown' || source.status === 'down') && (menuProvider === 'uflix' || menuProvider === 'animekai' || menuProvider === 'hianime' || menuProvider === 'flixer')) {
                            console.log(`[VideoPlayer] Fetching unknown source: ${source.title} from ${menuProvider}`);
                            setIsLoading(true);
                            setShowServerMenu(false);
                            
                            // Extract source name from title (e.g., "Neon (English)" -> "Neon", "Yuki (AnimeKai)" -> "Yuki")
                            const sourceName = source.title?.split(' (')[0] || source.title;
                            
                            try {
                              // Flixer: use browser-direct extraction
                              if (menuProvider === 'flixer') {
                                const { fetchFlixerSourceClient } = await import('@/app/lib/services/flixer-client-extractor');
                                const fetchedSource = await fetchFlixerSourceClient(
                                  sourceName, tmdbId, mediaType as 'movie' | 'tv', season, episode
                                );
                                if (fetchedSource) {
                                  const updatedSources = [...sourcesCache[menuProvider]];
                                  updatedSources[origIdx] = { ...source, ...fetchedSource, status: 'working' };
                                  setSourcesCache(prev => ({ ...prev, [menuProvider]: updatedSources }));
                                  setAvailableSources(updatedSources);
                                  setStreamUrl(applyStreamProxy(fetchedSource.url, menuProvider, fetchedSource.requiresSegmentProxy));
                                  setCurrentSourceIndex(origIdx);
                                  setProvider(menuProvider);
                                } else {
                                  pendingSeekTimeRef.current = null;
                                  const updatedSources = [...sourcesCache[menuProvider]];
                                  updatedSources[origIdx] = { ...source, status: 'down' };
                                  setSourcesCache(prev => ({ ...prev, [menuProvider]: updatedSources }));
                                  setError(`Source "${sourceName}" is not available`);
                                }
                                setIsLoading(false);
                                return;
                              }

                              const params = new URLSearchParams({
                                tmdbId,
                                type: mediaType,
                                provider: menuProvider,
                                source: sourceName,
                              });
                              if (mediaType === 'tv' && season && episode) {
                                params.append('season', season.toString());
                                params.append('episode', episode.toString());
                              }
                              
                              const response = await fetch(`/api/stream/extract?${params}`);
                              const data = await response.json();
                              
                              if (data.success && data.sources && data.sources.length > 0) {
                                const fetchedSource = data.sources[0];
                                // Update the source in cache at the ORIGINAL index
                                const updatedSources = [...sourcesCache[menuProvider]];
                                updatedSources[origIdx] = { ...source, ...fetchedSource, status: 'working' };
                                setSourcesCache(prev => ({ ...prev, [menuProvider]: updatedSources }));
                                setAvailableSources(updatedSources);
                                
                                // Save preferred AnimeKai server
                                if (menuProvider === 'animekai' || menuProvider === 'hianime') {
                                  setPreferredAnimeKaiServer(sourceName);
                                }
                                
                                // Set the stream URL
                                setStreamUrl(applyStreamProxy(fetchedSource.url, menuProvider, fetchedSource.requiresSegmentProxy));
                                setCurrentSourceIndex(origIdx);
                                setProvider(menuProvider);
                                // Sync toggle to match what's actually playing
                                // NOTE: Don't save to persistent storage — clicking a server
                                // is not the same as toggling sub/dub preference.
                                if (source.title && (menuProvider === 'animekai' || menuProvider === 'hianime')) {
                                  const actualPref = sourceMatchesAudioPreference(source.title, 'dub') ? 'dub' : 'sub';
                                  if (actualPref !== animeAudioPref) {
                                    setAnimeAudioPref(actualPref as AnimeAudioPreference);
                                  }
                                }
                              } else {
                                // Mark as failed - clear pending seek since we're not switching
                                pendingSeekTimeRef.current = null;
                                const updatedSources = [...sourcesCache[menuProvider]];
                                updatedSources[origIdx] = { ...source, status: 'down' };
                                setSourcesCache(prev => ({ ...prev, [menuProvider]: updatedSources }));
                                setError(`Source "${sourceName}" is not available`);
                              }
                            } catch (err) {
                              console.error('[VideoPlayer] Failed to fetch source:', err);
                              pendingSeekTimeRef.current = null; // Clear pending seek on error
                              setError('Failed to load source');
                            } finally {
                              setIsLoading(false);
                            }
                            return;
                          }
                          
                          // For working sources, just switch to them
                          if (menuProvider !== provider) {
                            setProvider(menuProvider);
                            setAvailableSources(sourcesCache[menuProvider]);
                          }
                          
                          // Save preferred AnimeKai server
                          if ((menuProvider === 'animekai' || menuProvider === 'hianime') && source.title) {
                            const serverName = source.title.split(' (')[0];
                            setPreferredAnimeKaiServer(serverName);
                          }
                          
                          // Set the stream URL directly
                          if (source.url) {
                            setStreamUrl(applyStreamProxy(source.url, menuProvider, source.requiresSegmentProxy));
                            setCurrentSourceIndex(origIdx);
                            setShowServerMenu(false);
                            // Sync toggle to match what's actually playing
                            // NOTE: Don't save to persistent storage — clicking a server
                            // is not the same as toggling sub/dub preference.
                            if (source.title && (menuProvider === 'animekai' || menuProvider === 'hianime')) {
                              const actualPref = sourceMatchesAudioPreference(source.title, 'dub') ? 'dub' : 'sub';
                              if (actualPref !== animeAudioPref) {
                                setAnimeAudioPref(actualPref as AnimeAudioPreference);
                              }
                            }
                          }
                        }}
                        style={{
                          padding: '0.6rem 1rem',
                          fontSize: '0.9rem',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          opacity: source.status === 'down' ? 0.5 : 1
                        }}
                      >
                        <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          {source.title || source.quality}
                          {source.language && source.language !== 'en' && (
                            <span style={{
                              fontSize: '0.75rem',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              backgroundColor: 'rgba(255, 255, 255, 0.15)',
                              color: 'rgba(255, 255, 255, 0.9)',
                              textTransform: 'uppercase',
                              fontWeight: 500
                            }}>
                              {source.language}
                            </span>
                          )}
                        </span>
                        {source.status && (
                          <span
                            style={{
                              width: '8px',
                              height: '8px',
                              borderRadius: '50%',
                              backgroundColor: source.status === 'working' ? '#4ade80' : 
                                             source.status === 'unknown' ? '#fbbf24' : '#f87171',
                              marginLeft: '8px',
                              boxShadow: `0 0 4px ${source.status === 'working' ? 'rgba(74, 222, 128, 0.5)' : 
                                                    source.status === 'unknown' ? 'rgba(251, 191, 36, 0.5)' : 'rgba(248, 113, 113, 0.5)'}`
                            }}
                            title={source.status === 'working' ? 'Available' : 
                                   source.status === 'unknown' ? 'Click to try' : 'Unavailable'}
                          />
                        )}
                      </button>
                      );})
                  ) : (
                    <div style={{ padding: '1rem', textAlign: 'center', color: 'rgba(255,255,255,0.5)', fontSize: '0.9rem' }}>
                      {loadingProviders[menuProvider] ? 'Loading sources...' : 
                       sourcesCache[menuProvider]?.length === 0 ? `No sources from ${menuProvider === 'animekai' ? 'AnimeKai' : menuProvider === 'vidsrc' ? 'VidSrc' : menuProvider === '1movies' ? '1movies' : menuProvider === 'flixer' ? 'Flixer' : menuProvider === 'uflix' ? 'Uflix' : menuProvider}` :
                       'Click to load sources'}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {title && title.trim() && title !== 'Loading...' && title !== 'Unknown' && (showControls || !isPlaying) && (
        <div className={styles.titleOverlay}>
          <div className={styles.titleContent}>
            <h2>{title}</h2>
            {mediaType === 'tv' && season && episode && (
              <div className={styles.episodeInfo}>
                Season {season} • Episode {episode}
              </div>
            )}
            {duration > 0 && (
              <div className={styles.progressInfo}>
                {formatTime(currentTime)} / {formatTime(duration)}
              </div>
            )}
          </div>
        </div>
      )}

      {!isPlaying && !isLoading && !showResumePrompt && (
        <button className={styles.centerPlayButton} onClick={(e) => { e.stopPropagation(); togglePlay(); }}>
          <svg width="80" height="80" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>
      )}

      {showResumePrompt && (
        <div 
          className={styles.resumePrompt} 
          onClick={(e) => e.stopPropagation()}
          data-resume-modal="true"
        >
          <div className={styles.resumePromptContent}>
            <h3>Resume Playback?</h3>
            <p>Continue from {formatTime(savedProgress)}</p>
            <div className={styles.resumePromptButtons}>
              <button 
                onClick={handleStartOver} 
                className={styles.resumeButton}
                data-resume-btn="start"
                data-tv-skip="true"
              >
                Start Over
              </button>
              <button 
                onClick={handleResume} 
                className={`${styles.resumeButton} ${styles.resumeButtonPrimary}`}
                data-resume-btn="resume"
                data-tv-skip="true"
              >
                Resume
              </button>
            </div>
          </div>
        </div>
      )}



      {/* Cast Overlay - shown when casting to TV */}
      {isCastOverlayVisible && cast.isCasting && (
        <CastOverlay
          title={title || 'Unknown Title'}
          subtitle={mediaType === 'tv' && season && episode ? `Season ${season} • Episode ${episode}` : undefined}
          onStopCasting={() => {
            cast.stop();
            setIsCastOverlayVisible(false);
          }}
          currentTime={cast.currentTime}
          duration={cast.duration}
          isPlaying={cast.playerState === 'PLAYING'}
          onPlayPause={cast.playOrPause}
          onSeek={cast.seek}
        />
      )}
    </div>
  );
}

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}
