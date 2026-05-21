'use client';

import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import Hls from 'hls.js';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useMobileGestures } from '@/hooks/useMobileGestures';
import { useWatchProgress } from '@/lib/hooks/useWatchProgress';
import { useCast, CastMedia } from '@/hooks/useCast';
import { usePresenceContext } from '@/components/analytics/PresenceProvider';
import { getSavedVolume, getSavedMuteState, saveVolumeSettings } from '@/lib/utils/player-preferences';
import styles from './MobileVideoPlayer.module.css';

type AudioPreference = 'sub' | 'dub';
type Provider = 'vidsrc' | '1movies' | 'flixer' | 'videasy' | 'uflix' | 'hexa' | 'animekai' | 'hianime' | 'primesrc' | 'miruro' | 'moviebox' | 'bingebox' | 'multi-embed';

interface SubtitleTrack {
  id: string;
  url: string;
  language: string;
  langCode?: string;
  iso639?: string;
}

interface MobileVideoPlayerProps {
  tmdbId: string;
  mediaType: 'movie' | 'tv';
  season?: number;
  episode?: number;
  title?: string;
  streamUrl: string;
  onBack?: () => void;
  onError?: (error: string) => void;
  onSourceChange?: (sourceIndex: number, currentTime: number) => void;
  availableSources?: Array<{ title: string; url: string; quality?: string; provider?: string; skipIntro?: [number, number]; skipOutro?: [number, number] }>;
  currentSourceIndex?: number;
  nextEpisode?: { season: number; episode: number; title?: string } | null;
  onNextEpisode?: () => void;
  isAnime?: boolean;
  audioPref?: AudioPreference;
  onAudioPrefChange?: (pref: AudioPreference, currentTime: number) => void;
  initialTime?: number;
  imdbId?: string;
  currentProvider?: Provider;
  availableProviders?: Provider[];
  onProviderChange?: (provider: Provider, currentTime: number) => void;
  loadingProvider?: boolean;
  skipIntro?: [number, number] | null;
  skipOutro?: [number, number] | null;
}

const formatTime = (seconds: number): string => {
  if (!seconds || isNaN(seconds)) return '0:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const triggerHaptic = (type: 'light' | 'medium' | 'heavy' = 'light') => {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    const duration = type === 'light' ? 10 : type === 'medium' ? 25 : 50;
    navigator.vibrate(duration);
  }
};

const PROVIDER_NAMES: Record<Provider, string> = {
  primesrc: 'PrimeSrc',
  flixer: 'Flixer',
  videasy: 'Videasy',
  uflix: 'Uflix',
  hexa: 'Hexa',
  vidsrc: 'VidSrc',
  'multi-embed': 'MultiEmbed',
  '1movies': '1movies',
  animekai: 'AnimeKai',
  hianime: 'HiAnime',
  miruro: 'Miruro',
  moviebox: 'MovieBox',
  bingebox: 'BingeBox',
};

// ── SVG Icon Components ─────────────────────────────────────────────────
const IconBack = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);
const IconPlay = () => (
  <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
    <path d="M8 5v14l11-7z" />
  </svg>
);
const IconPause = () => (
  <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="4" width="4" height="16" rx="1" />
    <rect x="14" y="4" width="4" height="16" rx="1" />
  </svg>
);
const IconSkipBack = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 19l-7-7 7-7" />
    <path d="M18 19l-7-7 7-7" />
  </svg>
);
const IconSkipForward = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 5l7 7-7 7" />
    <path d="M6 5l7 7-7 7" />
  </svg>
);
const IconFullscreenEnter = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
  </svg>
);
const IconFullscreenExit = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
    <line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" />
  </svg>
);
const IconLock = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);
const IconUnlock = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" />
  </svg>
);
const IconServer = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" />
    <circle cx="6" cy="6" r="1" fill="currentColor" /><circle cx="6" cy="18" r="1" fill="currentColor" />
  </svg>
);
const IconSubtitles = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="1" y="4" width="22" height="16" rx="2" /><line x1="5" y1="12" x2="11" y2="12" /><line x1="13" y1="12" x2="19" y2="12" />
    <line x1="5" y1="16" x2="15" y2="16" />
  </svg>
);
const IconCast = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M1 18v3h3c0-1.66-1.34-3-3-3z" />
    <path d="M1 14v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7z" />
    <path d="M1 10v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z" />
    <path d="M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
  </svg>
);
const IconAirPlay = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M6 22h12l-6-6-6 6z" />
    <path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h4v-2H3V5h18v12h-4v2h4c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
  </svg>
);
const IconNextTrack = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
    <path d="M6 18l8.5-6L6 6v12z" /><rect x="16" y="6" width="2" height="12" rx="1" />
  </svg>
);
const IconSkipForwardSmall = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M5 4l10 8-10 8V4z" /><rect x="17" y="5" width="2" height="14" rx="1" />
  </svg>
);
const IconClose = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);
const IconInfo = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><circle cx="12" cy="8" r="0.5" fill="currentColor" />
  </svg>
);
const IconSettings = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);
const IconBrightness = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
    <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
  </svg>
);
const IconVolume = ({ level }: { level: number }) => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    {level > 0 && <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />}
    {level > 0.5 && <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />}
    {level === 0 && <><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></>}
  </svg>
);

export default function MobileVideoPlayer({
  tmdbId,
  mediaType,
  season,
  episode,
  title,
  streamUrl,
  onBack,
  onError,
  onSourceChange,
  availableSources = [],
  currentSourceIndex = 0,
  nextEpisode,
  onNextEpisode,
  isAnime = false,
  audioPref = 'sub',
  onAudioPrefChange,
  initialTime = 0,
  imdbId,
  currentProvider,
  availableProviders = [],
  onProviderChange,
  loadingProvider = false,
  skipIntro: skipIntroProp = null,
  skipOutro: skipOutroProp = null,
}: MobileVideoPlayerProps) {
  const mobileInfo = useIsMobile();
  const presenceContext = usePresenceContext();

  // Lock in iOS and HLS support detection to prevent re-initialization on rotation
  const isIOSRef = useRef<boolean | null>(null);
  const supportsHLSRef = useRef<boolean | null>(null);
  if (isIOSRef.current === null && typeof window !== 'undefined') {
    isIOSRef.current = mobileInfo.isIOS;
    supportsHLSRef.current = mobileInfo.supportsHLS;
  }
  const isIOS = isIOSRef.current ?? mobileInfo.isIOS;
  const supportsHLS = supportsHLSRef.current ?? mobileInfo.supportsHLS;

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const seekPreviewTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Core playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isBuffering, setIsBuffering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // UI state
  const [showControls, setShowControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showSourceMenu, setShowSourceMenu] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);

  // Orientation state
  const [isLandscape, setIsLandscape] = useState(false);
  const [showRotateHint, setShowRotateHint] = useState(false);

  // Gesture feedback state
  const [seekPreview, setSeekPreview] = useState<{ show: boolean; time: number; delta: number } | null>(null);
  const [doubleTapIndicator, setDoubleTapIndicator] = useState<{ show: boolean; side: 'left' | 'right'; x: number; y: number } | null>(null);
  const [brightnessLevel, setBrightnessLevel] = useState(1);

  // Skip intro/outro state
  const [showSkipIntroButton, setShowSkipIntroButton] = useState(false);
  const [showSkipOutroButton, setShowSkipOutroButton] = useState(false);
  const skipIntroRef = useRef<[number, number] | null>(skipIntroProp);
  const skipOutroRef = useRef<[number, number] | null>(skipOutroProp);

  useEffect(() => { skipIntroRef.current = skipIntroProp; }, [skipIntroProp]);
  useEffect(() => { skipOutroRef.current = skipOutroProp; }, [skipOutroProp]);
  const [volumeLevel, setVolumeLevel] = useState(() => getSavedVolume());
  const [isMuted, setIsMuted] = useState(() => getSavedMuteState());
  const [showBrightnessOverlay, setShowBrightnessOverlay] = useState(false);
  const [showVolumeOverlay, setShowVolumeOverlay] = useState(false);
  const [longPressActive, setLongPressActive] = useState(false);
  const [showGestureHint, setShowGestureHint] = useState(false);

  // Resume playback state
  const [showResumePrompt, setShowResumePrompt] = useState(false);
  const [savedProgress, setSavedProgress] = useState(0);
  const hasShownResumePromptRef = useRef(false);

  // Subtitle state
  const [showSubtitleMenu, setShowSubtitleMenu] = useState(false);
  const [availableSubtitles, setAvailableSubtitles] = useState<SubtitleTrack[]>([]);
  const [currentSubtitle, setCurrentSubtitle] = useState<string | null>(null);
  const [subtitlesLoading, setSubtitlesLoading] = useState(false);

  // Cast state
  const [isCastOverlayVisible, setIsCastOverlayVisible] = useState(false);
  const [castError, setCastError] = useState<string | null>(null);
  const [showCastTips, setShowCastTips] = useState(false);
  const castErrorTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleCastConnect = useCallback(() => {
    setCastError(null);
  }, []);

  const handleCastDisconnect = useCallback(() => {
    setIsCastOverlayVisible(false);
  }, []);

  const handleCastError = useCallback((error: string) => {
    setCastError(error);
    if (castErrorTimeoutRef.current) clearTimeout(castErrorTimeoutRef.current);
    castErrorTimeoutRef.current = setTimeout(() => setCastError(null), 5000);
  }, []);

  const cast = useCast({
    videoRef: videoRef,
    streamUrl: streamUrl,
    onConnect: handleCastConnect,
    onDisconnect: handleCastDisconnect,
    onError: handleCastError,
  });

  const getCastMedia = useCallback((): CastMedia | undefined => {
    if (!streamUrl) return undefined;
    const episodeInfo = mediaType === 'tv' && season && episode ? `S${season}E${episode}` : undefined;
    return {
      url: streamUrl.startsWith('/') ? `${window.location.origin}${streamUrl}` : streamUrl,
      title: title || 'Unknown Title',
      subtitle: episodeInfo,
      contentType: 'application/x-mpegURL',
      isLive: false,
      startTime: currentTime > 0 ? currentTime : undefined,
    };
  }, [streamUrl, title, mediaType, season, episode, currentTime]);

  const castClickHandledRef = useRef(false);
  const handleCastClick = useCallback(async (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (castClickHandledRef.current) return;
    castClickHandledRef.current = true;
    setTimeout(() => { castClickHandledRef.current = false; }, 500);
    triggerHaptic('light');

    if (cast.isCasting || cast.isAirPlayActive) {
      cast.stop();
      setIsCastOverlayVisible(false);
      return;
    }
    if (cast.isConnected) {
      const media = getCastMedia();
      if (media) {
        videoRef.current?.pause();
        const success = await cast.loadMedia(media);
        if (success) setIsCastOverlayVisible(true);
      }
      return;
    }
    const connected = await cast.requestSession();
    if (connected) {
      const media = getCastMedia();
      if (media) {
        videoRef.current?.pause();
        const success = await cast.loadMedia(media);
        if (success) setIsCastOverlayVisible(true);
      }
    }
    if (cast.lastError && !castError) {
      setCastError(cast.lastError);
      if (castErrorTimeoutRef.current) clearTimeout(castErrorTimeoutRef.current);
      castErrorTimeoutRef.current = setTimeout(() => setCastError(null), 8000);
    }
  }, [cast, getCastMedia, castError]);

  // Refs for gesture calculations
  const seekStartTimeRef = useRef(0);
  const brightnessStartRef = useRef(1);
  const volumeStartRef = useRef(1);
  const pendingSeekTimeRef = useRef<number | null>(initialTime > 0 ? initialTime : null);
  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  const networkRetryCountRef = useRef(0);
  const onSourceChangeRef = useRef(onSourceChange);
  useEffect(() => { onSourceChangeRef.current = onSourceChange; }, [onSourceChange]);

  const playbackStartTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const playbackStartedRef = useRef<boolean>(false);

  // Watch progress tracking
  const {
    loadProgress,
    handleProgress,
    handleWatchStart,
    handleWatchPause,
    handleWatchResume,
  } = useWatchProgress({
    contentId: tmdbId,
    contentType: mediaType === 'tv' ? 'episode' : 'movie',
    contentTitle: title,
    seasonNumber: season,
    episodeNumber: episode,
  });

  // Auto-show gesture hints on first visit
  useEffect(() => {
    const key = 'flyx-gesture-hint-seen';
    if (!localStorage.getItem(key)) {
      const timer = setTimeout(() => {
        setShowGestureHint(true);
        localStorage.setItem(key, 'true');
      }, 2500);
      return () => clearTimeout(timer);
    }
  }, []);

  // Auto-hide controls — consistent 3s timeout
  const resetControlsTimeout = useCallback(() => {
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    if (!isLocked) {
      setShowControls(true);
      if (isPlaying && !showSourceMenu && !showSpeedMenu && !showSettingsMenu) {
        controlsTimeoutRef.current = setTimeout(() => setShowControls(false), 3000);
      }
    }
  }, [isPlaying, showSourceMenu, showSpeedMenu, showSettingsMenu, isLocked]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video || isLocked) return;
    if (video.paused) {
      if (video.muted && !isMuted) video.muted = false;
      video.play().catch(console.error);
    } else {
      video.pause();
    }
    triggerHaptic('light');
    resetControlsTimeout();
  }, [isLocked, isMuted, resetControlsTimeout]);

  const seekTo = useCallback((time: number) => {
    const video = videoRef.current;
    if (!video || isLocked) return;
    const newTime = Math.max(0, Math.min(time, duration));
    video.currentTime = newTime;
    setCurrentTime(newTime);
  }, [duration, isLocked]);

  const skip = useCallback((seconds: number) => {
    if (isLocked) return;
    seekTo(currentTime + seconds);
    triggerHaptic('light');
  }, [currentTime, seekTo, isLocked]);

  const handleTap = useCallback(() => {
    if (isLocked) {
      setShowControls(true);
      setTimeout(() => setShowControls(false), 2000);
      return;
    }
    if (showControls) {
      setShowControls(false);
    } else {
      resetControlsTimeout();
    }
  }, [isLocked, showControls, resetControlsTimeout]);

  const handleDoubleTap = useCallback((x: number, y: number, side: 'left' | 'center' | 'right') => {
    if (isLocked) return;
    if (side === 'center') { togglePlay(); return; }
    const seekAmount = side === 'left' ? -10 : 10;
    skip(seekAmount);
    setDoubleTapIndicator({ show: true, side, x, y });
    setTimeout(() => setDoubleTapIndicator(null), 600);
    triggerHaptic('medium');
  }, [isLocked, togglePlay, skip]);

  const handleLongPress = useCallback(() => {
    if (isLocked) return;
    setLongPressActive(true);
    if (videoRef.current) videoRef.current.playbackRate = 2;
    triggerHaptic('heavy');
  }, [isLocked]);

  const handleLongPressEnd = useCallback(() => {
    if (longPressActive) {
      setLongPressActive(false);
      if (videoRef.current) videoRef.current.playbackRate = playbackSpeed;
    }
  }, [longPressActive, playbackSpeed]);

  const handleHorizontalDrag = useCallback((_deltaX: number, progress: number) => {
    if (isLocked) return;
    const seekDelta = progress * duration * 0.5;
    const previewTime = Math.max(0, Math.min(duration, seekStartTimeRef.current + seekDelta));
    setSeekPreview({ show: true, time: previewTime, delta: seekDelta });
  }, [isLocked, duration]);

  const handleHorizontalDragEnd = useCallback(() => {
    if (isLocked || !seekPreview) return;
    seekTo(seekPreview.time);
    if (seekPreviewTimeoutRef.current) clearTimeout(seekPreviewTimeoutRef.current);
    seekPreviewTimeoutRef.current = setTimeout(() => setSeekPreview(null), 300);
    triggerHaptic('light');
  }, [isLocked, seekPreview, seekTo]);

  const handleVerticalDragLeft = useCallback((_deltaY: number, progress: number) => {
    if (isLocked) return;
    const newBrightness = Math.max(0.2, Math.min(1.5, brightnessStartRef.current - progress));
    setBrightnessLevel(newBrightness);
    setShowBrightnessOverlay(true);
  }, [isLocked]);

  const handleVerticalDragLeftEnd = useCallback(() => {
    brightnessStartRef.current = brightnessLevel;
    setTimeout(() => setShowBrightnessOverlay(false), 500);
  }, [brightnessLevel]);

  const handleVerticalDragRight = useCallback((_deltaY: number, progress: number) => {
    if (isLocked) return;
    const newVolume = Math.max(0, Math.min(1, volumeStartRef.current - progress));
    setVolumeLevel(newVolume);
    const newMuted = newVolume === 0;
    setIsMuted(newMuted);
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
      videoRef.current.muted = newMuted;
    }
    setShowVolumeOverlay(true);
  }, [isLocked]);

  const handleVerticalDragRightEnd = useCallback(() => {
    volumeStartRef.current = volumeLevel;
    saveVolumeSettings(volumeLevel, volumeLevel === 0);
    setTimeout(() => setShowVolumeOverlay(false), 500);
  }, [volumeLevel]);

  const handleGestureStart = useCallback((type: string) => {
    if (type === 'horizontal-drag') seekStartTimeRef.current = currentTime;
    else if (type === 'vertical-drag-left') brightnessStartRef.current = brightnessLevel;
    else if (type === 'vertical-drag-right') volumeStartRef.current = volumeLevel;
  }, [currentTime, brightnessLevel, volumeLevel]);

  const handleGestureEnd = useCallback((type: string) => {
    if (type === 'long-press') handleLongPressEnd();
  }, [handleLongPressEnd]);

  const { isGestureActive } = useMobileGestures(containerRef as React.RefObject<HTMLElement>, {
    onTap: handleTap,
    onDoubleTap: handleDoubleTap,
    onLongPress: handleLongPress,
    onHorizontalDrag: handleHorizontalDrag,
    onHorizontalDragEnd: handleHorizontalDragEnd,
    onVerticalDragLeft: handleVerticalDragLeft,
    onVerticalDragLeftEnd: handleVerticalDragLeftEnd,
    onVerticalDragRight: handleVerticalDragRight,
    onVerticalDragRightEnd: handleVerticalDragRightEnd,
    onGestureStart: handleGestureStart,
    onGestureEnd: handleGestureEnd,
    enabled: !showSourceMenu && !showSpeedMenu && !showSettingsMenu,
    preventScroll: true,
    doubleTapMaxDelay: 300,
    longPressDelay: 500,
    dragThreshold: 15,
  });

  const hlsConfig = useMemo(() => ({
    enableWorker: true,
    lowLatencyMode: false,
    backBufferLength: 60,
    maxBufferLength: 45,
    maxMaxBufferLength: 90,
    maxBufferSize: 60 * 1000 * 1000,
    maxBufferHole: 0.5,
    manifestLoadingTimeOut: 20000,
    manifestLoadingMaxRetry: 6,
    manifestLoadingRetryDelay: 1000,
    levelLoadingTimeOut: 20000,
    levelLoadingMaxRetry: 6,
    levelLoadingRetryDelay: 1000,
    fragLoadingTimeOut: 30000,
    fragLoadingMaxRetry: 8,
    fragLoadingRetryDelay: 1000,
    startLevel: -1,
    abrEwmaDefaultEstimate: 1000000,
    abrBandWidthFactor: 0.7,
    abrBandWidthUpFactor: 0.5,
    abrMaxWithRealBitrate: true,
    nudgeOffset: 0.1,
    nudgeMaxRetry: 5,
  }), []);

  // Track the last initialized stream URL to prevent re-initialization on rotation
  const lastInitializedUrlRef = useRef<string | null>(null);

  // Initialize HLS
  useEffect(() => {
    if (!streamUrl || !videoRef.current) return;
    if (lastInitializedUrlRef.current === streamUrl && hlsRef.current) return;

    lastInitializedUrlRef.current = streamUrl;
    networkRetryCountRef.current = 0;

    const video = videoRef.current;
    setIsLoading(true);
    setError(null);

    playbackStartedRef.current = false;
    if (playbackStartTimeoutRef.current) {
      clearTimeout(playbackStartTimeoutRef.current);
      playbackStartTimeoutRef.current = null;
    }

    const startPlaybackTimeout = () => {
      playbackStartTimeoutRef.current = setTimeout(() => {
        if (playbackStartedRef.current) return;
        const nextIdx = currentSourceIndex + 1;
        if (nextIdx < availableSources.length && availableSources[nextIdx]?.url) {
          onSourceChangeRef.current?.(nextIdx, video.currentTime || 0);
        }
      }, 10000);
    };

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

    const attemptAutoplay = () => {
      if (pendingSeekTimeRef.current !== null && pendingSeekTimeRef.current > 0) {
        video.currentTime = pendingSeekTimeRef.current;
        pendingSeekTimeRef.current = null;
      }
      const savedVolume = getSavedVolume();
      const savedMuted = getSavedMuteState();
      video.volume = savedVolume;
      video.muted = savedMuted;
      setVolumeLevel(savedVolume);
      setIsMuted(savedMuted);
      video.play().catch(() => {
        video.muted = true;
        setIsMuted(true);
        video.play().catch(() => {});
      });
    };

    const checkResumeProgress = () => {
      if (hasShownResumePromptRef.current) return;
      if (pendingSeekTimeRef.current !== null && pendingSeekTimeRef.current > 0) {
        hasShownResumePromptRef.current = true;
        return;
      }
      const savedTime = loadProgress();
      if (savedTime > 0 && video.duration > 0 && savedTime < video.duration - 30) {
        setSavedProgress(savedTime);
        setShowResumePrompt(true);
        video.pause();
        hasShownResumePromptRef.current = true;
      } else {
        hasShownResumePromptRef.current = true;
      }
    };

    if (isIOS && supportsHLS) {
      video.src = streamUrl;
      if (!showResumePrompt) startPlaybackTimeout();
      const handleLoadedMetadata = () => {
        setDuration(video.duration);
        setIsLoading(false);
        checkResumeProgress();
        if (!showResumePrompt) attemptAutoplay();
      };
      const handleCanPlay = () => {
        setIsLoading(false);
        if (video.paused) attemptAutoplay();
      };
      const handleError = () => {
        const err = video.error;
        setError(`Playback error: ${err?.message || 'Unknown error'}`);
        setIsLoading(false);
        onErrorRef.current?.(err?.message || 'Playback failed');
      };
      video.addEventListener('loadedmetadata', handleLoadedMetadata);
      video.addEventListener('canplay', handleCanPlay);
      video.addEventListener('error', handleError);
      return () => {
        video.removeEventListener('loadedmetadata', handleLoadedMetadata);
        video.removeEventListener('canplay', handleCanPlay);
        video.removeEventListener('error', handleError);
        video.removeEventListener('playing', onPlaying);
        if (playbackStartTimeoutRef.current) {
          clearTimeout(playbackStartTimeoutRef.current);
          playbackStartTimeoutRef.current = null;
        }
      };
    }

    if (Hls.isSupported()) {
      const hls = new Hls(hlsConfig);
      hlsRef.current = hls;
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
      if (!showResumePrompt) startPlaybackTimeout();
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setIsLoading(false);
        if (playbackSpeed !== 1 && video) video.playbackRate = playbackSpeed;
        const checkAndPlay = () => {
          if (video.duration > 0) {
            checkResumeProgress();
            if (!hasShownResumePromptRef.current || !showResumePrompt) attemptAutoplay();
          } else {
            setTimeout(checkAndPlay, 100);
          }
        };
        checkAndPlay();
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            networkRetryCountRef.current++;
            if (networkRetryCountRef.current <= 2) {
              hls.startLoad();
            } else {
              const nextIndex = currentSourceIndex + 1;
              if (nextIndex < availableSources.length) {
                onSourceChangeRef.current?.(nextIndex, currentTime);
              } else {
                setError('Stream unavailable. Try another source.');
                setIsLoading(false);
                onErrorRef.current?.('All sources failed with network errors');
              }
            }
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          else {
            setError('Playback failed. Try another source.');
            setIsLoading(false);
            onErrorRef.current?.('Fatal playback error');
          }
        }
      });
      return () => {
        hls.destroy();
        hlsRef.current = null;
        video.removeEventListener('playing', onPlaying);
        if (playbackStartTimeoutRef.current) {
          clearTimeout(playbackStartTimeoutRef.current);
          playbackStartTimeoutRef.current = null;
        }
      };
    }

    video.src = streamUrl;
    if (!showResumePrompt) startPlaybackTimeout();
    video.addEventListener('loadedmetadata', () => {
      setIsLoading(false);
      if (playbackSpeed !== 1) video.playbackRate = playbackSpeed;
      attemptAutoplay();
    });
    return () => {
      video.removeEventListener('playing', onPlaying);
      if (playbackStartTimeoutRef.current) {
        clearTimeout(playbackStartTimeoutRef.current);
        playbackStartTimeoutRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamUrl, hlsConfig]);

  // Auto-hide controls after 3s when playing
  useEffect(() => {
    if (isPlaying && !isLoading && showControls) {
      const hideTimer = setTimeout(() => {
        if (isPlaying && !showSourceMenu && !showSpeedMenu && !showSettingsMenu && !isLocked) {
          setShowControls(false);
        }
      }, 3000);
      return () => clearTimeout(hideTimer);
    }
  }, [isPlaying, isLoading, showControls, showSourceMenu, showSpeedMenu, showSettingsMenu, isLocked]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let lastTimeUpdate = 0;

    const onPlay = () => {
      setIsPlaying(true);
      handleWatchResume(video.currentTime, video.duration);
      presenceContext?.setActivityType('watching', {
        contentId: tmdbId, contentTitle: title, contentType: mediaType,
        seasonNumber: season, episodeNumber: episode,
      });
    };
    const onPause = () => {
      setIsPlaying(false);
      setShowControls(true);
      handleWatchPause(video.currentTime, video.duration);
      presenceContext?.setActivityType('browsing');
    };
    const onWaiting = () => setIsBuffering(true);
    const onCanPlay = () => { setIsBuffering(false); setIsLoading(false); };
    const onTimeUpdate = () => {
      const now = Date.now();
      if (now - lastTimeUpdate < 250) return;
      lastTimeUpdate = now;
      if (!isGestureActive) {
        setCurrentTime(video.currentTime);
        if (video.duration > 0 && !showResumePrompt) handleProgress(video.currentTime, video.duration);
      }
      if (video.buffered.length > 0) {
        setBuffered((video.buffered.end(video.buffered.length - 1) / video.duration) * 100);
      }
      const currentSkipIntro = skipIntroRef.current;
      if (currentSkipIntro) {
        const [introStart, introEnd] = currentSkipIntro;
        setShowSkipIntroButton(video.currentTime >= introStart && video.currentTime < introEnd);
      }
      const currentSkipOutro = skipOutroRef.current;
      if (currentSkipOutro) {
        const [outroStart, outroEnd] = currentSkipOutro;
        setShowSkipOutroButton(video.currentTime >= outroStart && video.currentTime < outroEnd);
      }
    };
    const onDurationChange = () => setDuration(video.duration);
    const onEnded = () => { setIsPlaying(false); setShowControls(true); };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('durationchange', onDurationChange);
    video.addEventListener('ended', onEnded);
    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('durationchange', onDurationChange);
      video.removeEventListener('ended', onEnded);
    };
  }, [isGestureActive, resetControlsTimeout, handleProgress, handleWatchPause, handleWatchResume, showResumePrompt, presenceContext, tmdbId, title, mediaType, season, episode]);

  // Orientation detection
  useEffect(() => {
    const checkOrientation = () => {
      let isLand = false;
      if (screen.orientation) {
        isLand = screen.orientation.type.includes('landscape');
      } else if (typeof window !== 'undefined') {
        isLand = window.innerWidth > window.innerHeight;
      }
      setIsLandscape(isLand);
      if (!isLand && !localStorage.getItem('mobile-rotate-hint-seen')) {
        setShowRotateHint(true);
        setTimeout(() => {
          setShowRotateHint(false);
          localStorage.setItem('mobile-rotate-hint-seen', 'true');
        }, 4000);
      }
    };
    checkOrientation();
    if (screen.orientation) screen.orientation.addEventListener('change', checkOrientation);
    window.addEventListener('resize', checkOrientation);
    window.addEventListener('orientationchange', checkOrientation);
    return () => {
      if (screen.orientation) screen.orientation.removeEventListener('change', checkOrientation);
      window.removeEventListener('resize', checkOrientation);
      window.removeEventListener('orientationchange', checkOrientation);
    };
  }, []);

  // Fullscreen handling
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isNowFullscreen = !!(
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        (videoRef.current as any)?.webkitDisplayingFullscreen
      );
      setIsFullscreen(isNowFullscreen);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    const video = videoRef.current;
    if (video) {
      video.addEventListener('webkitbeginfullscreen', handleFullscreenChange);
      video.addEventListener('webkitendfullscreen', handleFullscreenChange);
    }
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      if (video) {
        video.removeEventListener('webkitbeginfullscreen', handleFullscreenChange);
        video.removeEventListener('webkitendfullscreen', handleFullscreenChange);
      }
    };
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container) return;
    try {
      if (!isFullscreen) {
        if ((video as any).webkitEnterFullscreen) (video as any).webkitEnterFullscreen();
        else if ((container as any).webkitRequestFullscreen) await (container as any).webkitRequestFullscreen();
        else if (container.requestFullscreen) await container.requestFullscreen();
      } else {
        if ((video as any).webkitExitFullscreen) (video as any).webkitExitFullscreen();
        else if ((document as any).webkitExitFullscreen) (document as any).webkitExitFullscreen();
        else if (document.exitFullscreen) await document.exitFullscreen();
      }
    } catch (e) { console.error('[MobilePlayer] Fullscreen error:', e); }
    triggerHaptic('light');
  }, [isFullscreen]);

  const toggleLock = useCallback(() => {
    setIsLocked(prev => !prev);
    triggerHaptic('medium');
    if (!isLocked) setShowControls(false);
  }, [isLocked]);

  const changeSpeed = useCallback((speed: number) => {
    setPlaybackSpeed(speed);
    if (videoRef.current) videoRef.current.playbackRate = speed;
    setShowSpeedMenu(false);
    triggerHaptic('light');
  }, []);

  const handleResumePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = savedProgress;
    video.play().catch(() => { video.muted = true; setIsMuted(true); video.play().catch(() => {}); });
    setShowResumePrompt(false);
    handleWatchResume(savedProgress, video.duration);
    triggerHaptic('light');
  }, [savedProgress, handleWatchResume]);

  const handleStartOver = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = 0;
    video.play().catch(() => { video.muted = true; setIsMuted(true); video.play().catch(() => {}); });
    setShowResumePrompt(false);
    handleWatchStart(0, video.duration);
    triggerHaptic('light');
  }, [handleWatchStart]);

  const handleProgressTouch = useCallback((e: React.TouchEvent) => {
    e.stopPropagation();
    if (isLocked) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const touch = e.touches[0] || e.changedTouches[0];
    const pos = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
    seekTo(pos * duration);
    triggerHaptic('light');
  }, [duration, seekTo, isLocked]);

  // Fetch subtitles
  const fetchSubtitles = useCallback(async () => {
    if (!imdbId) return;
    setSubtitlesLoading(true);
    try {
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
    } catch {
      setAvailableSubtitles([]);
    } finally {
      setSubtitlesLoading(false);
    }
  }, [imdbId, mediaType, season, episode]);

  const loadSubtitle = useCallback((subtitle: SubtitleTrack | null) => {
    const video = videoRef.current;
    if (!video) return;
    const tracks = video.querySelectorAll('track');
    tracks.forEach(track => track.remove());
    if (subtitle) {
      const langCode = subtitle.iso639 || subtitle.langCode || '';
      const subtitleUrl = `/api/subtitle-proxy?url=${encodeURIComponent(subtitle.url)}&lang=${encodeURIComponent(langCode)}&_t=${Date.now()}`;
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = subtitle.language || 'Subtitles';
      track.srclang = subtitle.iso639 || 'en';
      track.src = subtitleUrl;
      track.default = true;
      track.addEventListener('load', () => {
        if (video.textTracks) {
          for (let i = 0; i < video.textTracks.length; i++) video.textTracks[i].mode = 'showing';
        }
      });
      video.appendChild(track);
      setCurrentSubtitle(subtitle.id);
    } else {
      setCurrentSubtitle(null);
    }
    setShowSubtitleMenu(false);
    triggerHaptic('light');
  }, []);

  useEffect(() => {
    if (imdbId) { fetchSubtitles(); return; }
    const getImdbIdAndFetchSubtitles = async () => {
      try {
        if (tmdbId === '0') return;
        const apiKey = process.env.NEXT_PUBLIC_TMDB_API_KEY;
        if (!apiKey || !tmdbId) return;
        const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/external_ids?api_key=${apiKey}`;
        const response = await fetch(url);
        const data = await response.json();
        if (data.imdb_id) {
          setSubtitlesLoading(true);
          const params = new URLSearchParams({ imdbId: data.imdb_id });
          if (mediaType === 'tv' && season && episode) {
            params.append('season', season.toString());
            params.append('episode', episode.toString());
          }
          const subResponse = await fetch(`/api/subtitles?${params}`);
          const subData = await subResponse.json();
          if (subData.success && subData.subtitles && Array.isArray(subData.subtitles)) {
            setAvailableSubtitles(subData.subtitles);
          }
          setSubtitlesLoading(false);
        }
      } catch {
        setSubtitlesLoading(false);
      }
    };
    getImdbIdAndFetchSubtitles();
  }, [imdbId, tmdbId, mediaType, season, episode, fetchSubtitles]);

  const speedOptions = [0.5, 0.75, 1, 1.25, 1.5, 2];

  // ─── Copy stream URL helper ────────────────────────────────────────
  const handleCopyUrl = useCallback(async () => {
    let fullUrl = streamUrl;
    if (streamUrl.startsWith('/')) fullUrl = `${window.location.origin}${streamUrl}`;
    try { await navigator.clipboard.writeText(fullUrl); } catch {}
    triggerHaptic('light');
  }, [streamUrl]);

  // ══════════════════════════════════════════════════════════════════════
  // JSX
  // ══════════════════════════════════════════════════════════════════════
  return (
    <div
      ref={containerRef}
      className={`${styles.container} ${isFullscreen ? styles.fullscreen : ''} ${isLandscape ? styles.landscape : styles.portrait}`}
      style={{ filter: `brightness(${brightnessLevel})` }}
    >
      <video
        ref={videoRef}
        className={styles.video}
        playsInline
        autoPlay={false}
        controls={false}
        preload="metadata"
        webkit-playsinline="true"
        x-webkit-airplay="allow"
      />

      {/* ── Loading / Buffering ─────────────────────────────────────── */}
      {(isLoading || isBuffering) && (
        <div className={styles.loadingOverlay}>
          <div className={styles.spinner} />
          <p>{isLoading ? 'Loading...' : 'Buffering...'}</p>
        </div>
      )}

      {/* ── Error ───────────────────────────────────────────────────── */}
      {error && (
        <div className={styles.errorOverlay}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#e50914" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <p>{error}</p>
          <button className={styles.retryButton} onClick={() => { setError(null); setIsLoading(true); videoRef.current?.load(); }}>
            Retry
          </button>
        </div>
      )}

      {/* ── Cast Error Toast ────────────────────────────────────────── */}
      {castError && (
        <div className={styles.castErrorToast}>
          <IconCast />
          <p>{castError}</p>
        </div>
      )}

      {/* ── Cast Overlay ────────────────────────────────────────────── */}
      {isCastOverlayVisible && (cast.isCasting || cast.isAirPlayActive) && (
        <div className={styles.castOverlay}>
          <div className={styles.castOverlayContent}>
            <div className={styles.castingIndicator}>
              {cast.isAirPlayAvailable ? <IconAirPlay /> : <IconCast />}
            </div>
            <h3 className={styles.castTitle}>
              {cast.isAirPlayActive ? 'AirPlaying to TV' : 'Casting to TV'}
            </h3>
            <p className={styles.castSubtitle}>{title}</p>
            {mediaType === 'tv' && season && episode && (
              <p className={styles.castEpisode}>S{season} E{episode}</p>
            )}
            <button
              className={styles.stopCastButton}
              onClick={(e) => { e.stopPropagation(); cast.stop(); setIsCastOverlayVisible(false); triggerHaptic('light'); }}
            >
              Stop {cast.isAirPlayActive ? 'AirPlay' : 'Casting'}
            </button>
            <button
              className={styles.castTipsLink}
              onClick={(e) => { e.stopPropagation(); setShowCastTips(true); }}
            >
              Having trouble? View cast tips
            </button>
          </div>
        </div>
      )}

      {/* ── Resume Playback Prompt ──────────────────────────────────── */}
      {showResumePrompt && (
        <div className={styles.resumePromptOverlay} onClick={(e) => e.stopPropagation()}>
          <div className={styles.resumePromptContent}>
            <h3>Resume Playback?</h3>
            <p>Continue from {formatTime(savedProgress)}</p>
            <div className={styles.resumePromptButtons}>
              <button className={styles.resumeButton} onClick={handleResumePlayback}>
                <IconPlay /> Resume
              </button>
              <button className={styles.startOverButton} onClick={handleStartOver}>
                Start Over
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Double Tap Indicator ────────────────────────────────────── */}
      {doubleTapIndicator?.show && (
        <div className={`${styles.doubleTapIndicator} ${styles[doubleTapIndicator.side]}`} style={{ left: doubleTapIndicator.x, top: doubleTapIndicator.y }}>
          <div className={styles.doubleTapRipple} />
          <span className={styles.doubleTapIcon}>
            {doubleTapIndicator.side === 'left' ? <IconSkipBack /> : <IconSkipForward />}
          </span>
          <span>10s</span>
        </div>
      )}

      {/* ── Seek Preview ────────────────────────────────────────────── */}
      {seekPreview?.show && (
        <div className={styles.seekPreview}>
          <span className={styles.seekPreviewTime}>{formatTime(seekPreview.time)}</span>
          <span className={styles.seekPreviewDelta}>{seekPreview.delta >= 0 ? '+' : ''}{formatTime(Math.abs(seekPreview.delta))}</span>
          <div className={styles.seekPreviewBar}>
            <div className={styles.seekPreviewProgress} style={{ width: `${(seekPreview.time / duration) * 100}%` }} />
          </div>
        </div>
      )}

      {/* ── Brightness Overlay ──────────────────────────────────────── */}
      {showBrightnessOverlay && (
        <div className={styles.gestureOverlay}>
          <IconBrightness />
          <div className={styles.gestureBar}>
            <div className={styles.gestureFill} style={{ height: `${(brightnessLevel / 1.5) * 100}%` }} />
          </div>
          <span>{Math.round((brightnessLevel / 1.5) * 100)}%</span>
        </div>
      )}

      {/* ── Volume Overlay ──────────────────────────────────────────── */}
      {showVolumeOverlay && (
        <div className={styles.gestureOverlay}>
          <IconVolume level={volumeLevel} />
          <div className={styles.gestureBar}>
            <div className={styles.gestureFill} style={{ height: `${volumeLevel * 100}%` }} />
          </div>
          <span>{Math.round(volumeLevel * 100)}%</span>
        </div>
      )}

      {/* ── Long-Press Speed ────────────────────────────────────────── */}
      {longPressActive && (
        <div className={styles.speedIndicator}>
          <IconSkipForward />
          <span>2x Speed</span>
        </div>
      )}

      {/* ── Rotate Hint ─────────────────────────────────────────────── */}
      {showRotateHint && !isLandscape && (
        <div className={styles.rotateHint}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="2" width="16" height="20" rx="2" /><path d="M12 18h.01" />
          </svg>
          <span>Rotate for fullscreen</span>
        </div>
      )}

      {/* ── Gesture Hints Overlay ───────────────────────────────────── */}
      {showGestureHint && (
        <div className={styles.gestureHintOverlay} onClick={() => setShowGestureHint(false)}>
          <div className={styles.gestureHintContent} onClick={(e) => e.stopPropagation()}>
            <div className={styles.gestureHintHeader}>
              <h3>Gesture Controls</h3>
              <button className={styles.gestureHintClose} onClick={() => setShowGestureHint(false)}><IconClose /></button>
            </div>
            <div className={styles.gestureHintList}>
              {[
                { icon: 'Tap', action: 'Tap', desc: 'Show/hide controls' },
                { icon: '2x Tap', action: 'Double tap sides', desc: 'Skip ±10 seconds' },
                { icon: '2x Tap', action: 'Double tap center', desc: 'Play/Pause' },
                { icon: 'Hold', action: 'Long press', desc: '2x speed while held' },
                { icon: '↔', action: 'Swipe horizontal', desc: 'Seek through video' },
                { icon: '↕ L', action: 'Swipe up/down (left)', desc: 'Adjust brightness' },
                { icon: '↕ R', action: 'Swipe up/down (right)', desc: 'Adjust volume' },
              ].map((g) => (
                <div className={styles.gestureHintItem} key={g.action}>
                  <span className={styles.gestureHintIcon}>{g.icon}</span>
                  <div className={styles.gestureHintText}>
                    <span className={styles.gestureHintAction}>{g.action}</span>
                    <span className={styles.gestureHintDesc}>{g.desc}</span>
                  </div>
                </div>
              ))}
            </div>
            <button className={styles.gestureHintDismiss} onClick={() => setShowGestureHint(false)}>
              Got it!
            </button>
          </div>
        </div>
      )}

      {/* ── Lock Indicator ──────────────────────────────────────────── */}
      {isLocked && showControls && (
        <div
          className={styles.lockIndicator}
          onClick={(e) => { e.stopPropagation(); setIsLocked(false); triggerHaptic('medium'); }}
        >
          <IconLock />
          <span>Tap to unlock</span>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* ── Player Controls ─────────────────────────────────────────── */}
      {/* ══════════════════════════════════════════════════════════════ */}
      <div className={`${styles.controls} ${showControls && !isLocked ? styles.visible : ''}`}>

        {/* ── Top Bar ───────────────────────────────────────────────── */}
        <div className={styles.topBar}>
          <button className={styles.iconButton} onClick={(e) => { e.stopPropagation(); onBack?.(); }}>
            <IconBack />
          </button>
          <div className={styles.titleArea}>
            <h2 className={styles.title}>{title}</h2>
            {mediaType === 'tv' && season && episode && (
              <span className={styles.episodeInfo}>S{season} E{episode}</span>
            )}
          </div>
          <div className={styles.topButtons}>
            {/* Sub/Dub Toggle for Anime */}
            {isAnime && (
              <button
                className={styles.subDubToggle}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!onAudioPrefChange) return;
                  onAudioPrefChange(audioPref === 'sub' ? 'dub' : 'sub', currentTime);
                  triggerHaptic('light');
                }}
              >
                <span className={audioPref === 'sub' ? styles.activeLabel : styles.inactiveLabel}>SUB</span>
                <div className={styles.toggleTrack} data-active={audioPref}>
                  <div className={styles.toggleThumb} />
                </div>
                <span className={audioPref === 'dub' ? styles.activeLabel : styles.inactiveLabel}>DUB</span>
              </button>
            )}
            {/* Subtitles */}
            <button
              className={`${styles.iconButton} ${currentSubtitle ? styles.activeIcon : ''}`}
              onClick={(e) => { e.stopPropagation(); setShowSubtitleMenu(true); triggerHaptic('light'); }}
              title="Subtitles"
            >
              <IconSubtitles />
            </button>
            {/* Cast / AirPlay */}
            <button
              className={`${styles.iconButton} ${cast.isCasting || cast.isAirPlayActive ? styles.activeIcon : ''}`}
              onClick={handleCastClick}
              title={cast.isAirPlayAvailable ? 'AirPlay' : 'Cast to TV'}
            >
              {cast.isAirPlayAvailable ? <IconAirPlay /> : <IconCast />}
            </button>
            {/* Settings (lock, gestures, cast tips, copy URL) */}
            <button
              className={styles.iconButton}
              onClick={(e) => { e.stopPropagation(); setShowSettingsMenu(true); triggerHaptic('light'); }}
              title="Settings"
            >
              <IconSettings />
            </button>
            {/* Server / Source */}
            <button
              className={styles.iconButton}
              onClick={(e) => { e.stopPropagation(); setShowSourceMenu(true); }}
              title="Sources"
            >
              <IconServer />
            </button>
          </div>
        </div>

        {/* ── Center Controls ───────────────────────────────────────── */}
        <div className={styles.centerControls}>
          <button className={styles.skipButton} onClick={(e) => { e.stopPropagation(); skip(-10); }}>
            <IconSkipBack />
            <span className={styles.skipText}>10</span>
          </button>
          <button className={styles.playButton} onClick={(e) => { e.stopPropagation(); togglePlay(); }}>
            {isPlaying ? <IconPause /> : <IconPlay />}
          </button>
          <button className={styles.skipButton} onClick={(e) => { e.stopPropagation(); skip(10); }}>
            <IconSkipForward />
            <span className={styles.skipText}>10</span>
          </button>
        </div>

        {/* ── Bottom Bar ────────────────────────────────────────────── */}
        <div className={styles.bottomBar}>
          <div className={styles.progressContainer} onTouchStart={handleProgressTouch} onTouchMove={handleProgressTouch}>
            <div className={styles.progressTrack}>
              <div className={styles.progressBuffered} style={{ width: `${buffered}%` }} />
              <div className={styles.progressFilled} style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }} />
            </div>
            <div className={styles.progressThumb} style={{ left: `${duration ? (currentTime / duration) * 100 : 0}%` }} />
          </div>
          <div className={styles.bottomControls}>
            <span className={styles.timeDisplay}>
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
            <div className={styles.bottomButtons}>
              <button className={styles.speedButton} onClick={(e) => { e.stopPropagation(); setShowSpeedMenu(true); }}>
                {playbackSpeed}x
              </button>
              {nextEpisode && onNextEpisode && (
                <button
                  className={styles.nextEpisodeButton}
                  onClick={(e) => { e.stopPropagation(); onNextEpisode(); triggerHaptic('light'); }}
                >
                  <span>Next</span>
                  <IconNextTrack />
                </button>
              )}
            </div>
            <button className={styles.iconButton} onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }}>
              {isFullscreen ? <IconFullscreenExit /> : <IconFullscreenEnter />}
            </button>
          </div>
        </div>
      </div>

      {/* ── Skip Intro Button ───────────────────────────────────────── */}
      {showSkipIntroButton && skipIntroProp && (
        <button
          className={styles.skipIntroOutroButton}
          onClick={(e) => {
            e.stopPropagation();
            if (videoRef.current && skipIntroProp) {
              videoRef.current.currentTime = skipIntroProp[1];
              setShowSkipIntroButton(false);
              triggerHaptic('light');
            }
          }}
        >
          <span>Skip Intro</span>
          <IconSkipForwardSmall />
        </button>
      )}

      {/* ── Skip Outro Button ───────────────────────────────────────── */}
      {showSkipOutroButton && skipOutroProp && (
        <button
          className={styles.skipIntroOutroButton}
          onClick={(e) => {
            e.stopPropagation();
            if (videoRef.current && skipOutroProp) {
              videoRef.current.currentTime = skipOutroProp[1];
              setShowSkipOutroButton(false);
              triggerHaptic('light');
            }
          }}
        >
          <span>Skip Outro</span>
          <IconSkipForwardSmall />
        </button>
      )}

      {/* ── Source Menu ──────────────────────────────────────────────── */}
      {showSourceMenu && (
        <div className={styles.menuOverlay} onClick={() => setShowSourceMenu(false)}>
          <div className={styles.menuContent} onClick={e => e.stopPropagation()}>
            <div className={styles.menuHeader}>
              <h3>Select Source</h3>
              <button className={styles.menuClose} onClick={() => setShowSourceMenu(false)}><IconClose /></button>
            </div>
            {availableProviders.length > 1 && (
              <div className={styles.providerTabs}>
                {availableProviders.map(provider => (
                  <button
                    key={provider}
                    className={`${styles.providerTab} ${provider === currentProvider ? styles.active : ''}`}
                    onClick={() => {
                      if (provider !== currentProvider && onProviderChange) {
                        onProviderChange(provider, currentTime);
                        triggerHaptic('light');
                      }
                    }}
                    disabled={loadingProvider}
                  >
                    {PROVIDER_NAMES[provider]}
                  </button>
                ))}
              </div>
            )}
            {loadingProvider && (
              <div className={styles.loadingIndicator}><span>Loading sources...</span></div>
            )}
            <div className={styles.menuList}>
              {!loadingProvider && availableSources.length === 0 ? (
                <div className={styles.noSources}>
                  No sources available from {currentProvider ? PROVIDER_NAMES[currentProvider] : 'this provider'}
                </div>
              ) : (
                availableSources.map((source, index) => (
                  <button
                    key={index}
                    className={`${styles.menuItem} ${index === currentSourceIndex ? styles.active : ''}`}
                    onClick={() => { onSourceChange?.(index, currentTime); setShowSourceMenu(false); triggerHaptic('light'); }}
                  >
                    <span>{source.title || `Source ${index + 1}`}</span>
                    {source.quality && <span className={styles.quality}>{source.quality}</span>}
                    {index === currentSourceIndex && <span className={styles.checkmark}>&#10003;</span>}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Speed Menu ──────────────────────────────────────────────── */}
      {showSpeedMenu && (
        <div className={styles.menuOverlay} onClick={() => setShowSpeedMenu(false)}>
          <div className={styles.menuContent} onClick={e => e.stopPropagation()}>
            <div className={styles.menuHeader}>
              <h3>Playback Speed</h3>
              <button className={styles.menuClose} onClick={() => setShowSpeedMenu(false)}><IconClose /></button>
            </div>
            <div className={styles.menuList}>
              {speedOptions.map(speed => (
                <button
                  key={speed}
                  className={`${styles.menuItem} ${speed === playbackSpeed ? styles.active : ''}`}
                  onClick={() => changeSpeed(speed)}
                >
                  <span>{speed}x</span>
                  {speed === 1 && <span className={styles.normalLabel}>Normal</span>}
                  {speed === playbackSpeed && <span className={styles.checkmark}>&#10003;</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Subtitle Menu ───────────────────────────────────────────── */}
      {showSubtitleMenu && (
        <div className={styles.menuOverlay} onClick={() => setShowSubtitleMenu(false)}>
          <div className={styles.menuContent} onClick={e => e.stopPropagation()}>
            <div className={styles.menuHeader}>
              <h3>Subtitles</h3>
              <button className={styles.menuClose} onClick={() => setShowSubtitleMenu(false)}><IconClose /></button>
            </div>
            <div className={styles.menuList}>
              <button
                className={`${styles.menuItem} ${!currentSubtitle ? styles.active : ''}`}
                onClick={() => loadSubtitle(null)}
              >
                <span>Off</span>
                {!currentSubtitle && <span className={styles.checkmark}>&#10003;</span>}
              </button>
              {subtitlesLoading ? (
                <div className={styles.menuLoading}>Loading subtitles...</div>
              ) : availableSubtitles.length > 0 ? (
                availableSubtitles.map((subtitle) => (
                  <button
                    key={subtitle.id}
                    className={`${styles.menuItem} ${currentSubtitle === subtitle.id ? styles.active : ''}`}
                    onClick={() => loadSubtitle(subtitle)}
                  >
                    <span>{subtitle.language}</span>
                    {currentSubtitle === subtitle.id && <span className={styles.checkmark}>&#10003;</span>}
                  </button>
                ))
              ) : (
                <div className={styles.menuEmpty}>No subtitles available</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Settings Menu ───────────────────────────────────────────── */}
      {showSettingsMenu && (
        <div className={styles.menuOverlay} onClick={() => setShowSettingsMenu(false)}>
          <div className={styles.menuContent} onClick={e => e.stopPropagation()}>
            <div className={styles.menuHeader}>
              <h3>Settings</h3>
              <button className={styles.menuClose} onClick={() => setShowSettingsMenu(false)}><IconClose /></button>
            </div>
            <div className={styles.menuList}>
              <button className={styles.menuItem} onClick={() => { toggleLock(); setShowSettingsMenu(false); }}>
                <span>{isLocked ? 'Unlock Screen' : 'Lock Screen'}</span>
                <span className={styles.settingsIcon}>{isLocked ? <IconUnlock /> : <IconLock />}</span>
              </button>
              <button className={styles.menuItem} onClick={() => { setShowSettingsMenu(false); setShowGestureHint(true); }}>
                <span>Gesture Controls</span>
                <span className={styles.settingsIcon}><IconInfo /></span>
              </button>
              <button className={styles.menuItem} onClick={() => { setShowSettingsMenu(false); setShowCastTips(true); }}>
                <span>Cast Tips</span>
                <span className={styles.settingsIcon}><IconCast /></span>
              </button>
              <button className={styles.menuItem} onClick={() => { handleCopyUrl(); setShowSettingsMenu(false); }}>
                <span>Copy Stream URL</span>
                <span className={styles.settingsIcon}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Cast Tips Modal ─────────────────────────────────────────── */}
      {showCastTips && (
        <div className={styles.menuOverlay} onClick={() => setShowCastTips(false)}>
          <div className={styles.menuContent} onClick={e => e.stopPropagation()} style={{ maxHeight: '85vh' }}>
            <div className={styles.menuHeader}>
              <h3 className={styles.castTipsTitle}><IconCast /> Cast Tips</h3>
              <button className={styles.menuClose} onClick={() => setShowCastTips(false)}><IconClose /></button>
            </div>
            <div className={styles.castTipsList}>
              <div className={styles.castTipSection}>
                <h4>iPhone / iPad</h4>
                <ol>
                  <li>Tap the AirPlay button above</li>
                  <li>Select your Apple TV or AirPlay TV</li>
                  <li>Video plays directly on your TV</li>
                </ol>
              </div>
              <div className={styles.castTipSection}>
                <h4>Android</h4>
                <p><strong>Option 1:</strong> Tap the Cast button above (Chromecast)</p>
                <p><strong>Option 2:</strong> Screen Mirroring — swipe down for Quick Settings, tap Smart View / Screen Cast</p>
              </div>
              <div className={styles.castTipSection}>
                <h4>Windows PC</h4>
                <p>Press <kbd>Win + K</kbd> and select your TV from wireless displays.</p>
              </div>
              <div className={`${styles.castTipSection} ${styles.castTipWarning}`}>
                <h4>LG / Samsung Smart TVs</h4>
                <p>These TVs do NOT support native Chromecast. Use screen mirroring (Android: Smart View, Windows: Win+K, Chrome: Menu → Cast → Cast tab).</p>
              </div>
              <div className={styles.castTipSection}>
                <h4>Tips</h4>
                <ul>
                  <li>Same WiFi network required</li>
                  <li>Use the cast button for best quality</li>
                  <li>For smooth casting, consider a Chromecast device</li>
                </ul>
              </div>
            </div>
            <div className={styles.castTipsDismiss}>
              <button className={styles.gestureHintDismiss} onClick={() => setShowCastTips(false)}>Got it!</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Unlock Button (shown when locked) ───────────────────────── */}
      {isLocked && showControls && (
        <button className={styles.unlockButton} onClick={(e) => { e.stopPropagation(); setIsLocked(false); triggerHaptic('medium'); }}>
          <IconUnlock />
        </button>
      )}
    </div>
  );
}
