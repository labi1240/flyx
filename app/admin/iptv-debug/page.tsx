'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { 
  Wifi, 
  Play, 
  Tv, 
  Radio, 
  Film, 
  AlertCircle,
  CheckCircle,
  Loader2,
  Copy,
  ExternalLink,
  Upload,
  Star,
  Trash2,
  RotateCcw,
  Square,
  Zap,
  Server,
  Globe,
  Search
} from 'lucide-react';
import type Hls from 'hls.js';
import type mpegts from 'mpegts.js';

// Proxy URLs for IPTV streams
const RPI_PROXY_URL = process.env.NEXT_PUBLIC_RPI_PROXY_URL;
const CF_PROXY_URL = process.env.NEXT_PUBLIC_CF_TV_PROXY_URL || process.env.NEXT_PUBLIC_CF_PROXY_URL || 'https://media-proxy.vynx-3b3.workers.dev';

// Tab types
type DebugTab = 'cdn-live' | 'stalker';

// CDN-Live types
interface CDNLiveChannel {
  name: string;
  code: string;
  url: string;
  image: string;
  status: string;
  viewers: number;
}

// Stalker types
interface SavedAccount {
  portal: string;
  mac: string;
  channels: number;
  status: number | string;
  blocked: string | number;
  addedAt: string;
}

interface TestResult {
  success: boolean;
  token?: string;
  profile?: any;
  content?: { itv: number; radio: number; vod: number };
  error?: string;
}

interface Channel {
  id: string;
  name: string;
  number: number;
  cmd: string;
  logo?: string;
  tv_genre_id?: string;
  genre_title?: string;
  genre_id?: string;
}

interface Genre {
  id: string;
  title: string;
  alias?: string;
}

interface AutoCycleResult {
  portal: string;
  mac: string;
  success: boolean;
  canStream: boolean;
  channels: number;
  error?: string;
  testedAt: string;
}

export default function IPTVDebugPage() {
  // Tab state
  const [activeTab, setActiveTab] = useState<DebugTab>('cdn-live');
  
  // CDN-Live state
  const [cdnChannels, setCdnChannels] = useState<CDNLiveChannel[]>([]);
  const [cdnCountries, setCdnCountries] = useState<string[]>([]);
  const [cdnByCountry, setCdnByCountry] = useState<Record<string, CDNLiveChannel[]>>({});
  const [cdnSelectedCountry, setCdnSelectedCountry] = useState<string>('us');
  const [cdnSearch, setCdnSearch] = useState('');
  const [cdnLoading, setCdnLoading] = useState(false);
  const [cdnStreamLoading, setCdnStreamLoading] = useState(false);
  const [cdnSelectedChannel, setCdnSelectedChannel] = useState<CDNLiveChannel | null>(null);
  const [cdnStreamUrl, setCdnStreamUrl] = useState<string | null>(null);
  const [cdnStreamDebug, setCdnStreamDebug] = useState<any>(null);
  
  // Stalker state (existing)
  const [portalUrl, setPortalUrl] = useState('');
  const [macAddress, setMacAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [_genres, setGenres] = useState<Genre[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [totalChannels, setTotalChannels] = useState(0);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [loadingStream, setLoadingStream] = useState(false);
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [rawStreamUrl, setRawStreamUrl] = useState<string | null>(null);
  const [streamDebug, setStreamDebug] = useState<any>(null);
  const [savedAccounts, setSavedAccounts] = useState<SavedAccount[]>([]);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [autoCycleRunning, setAutoCycleRunning] = useState(false);
  const [autoCycleResults, setAutoCycleResults] = useState<AutoCycleResult[]>([]);
  const [autoCycleProgress, setAutoCycleProgress] = useState({ current: 0, total: 0, currentAccount: '' });
  const [testStreamDuringCycle, setTestStreamDuringCycle] = useState(false);
  const [debugSourcesResult, setDebugSourcesResult] = useState<any>(null);
  const [debugSourcesLoading, setDebugSourcesLoading] = useState(false);
  const [channelSearch, setChannelSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [availableCategories, setAvailableCategories] = useState<{id: string, title: string}[]>([]);
  const autoCycleAbortRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const mpegtsRef = useRef<mpegts.Player | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load saved accounts from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('iptv-debug-accounts');
    if (saved) {
      try {
        setSavedAccounts(JSON.parse(saved));
      } catch {}
    }
  }, []);

  // Save accounts to localStorage when they change
  useEffect(() => {
    if (savedAccounts.length > 0) {
      localStorage.setItem('iptv-debug-accounts', JSON.stringify(savedAccounts));
    }
  }, [savedAccounts]);

  // ============================================
  // CDN-LIVE.TV FUNCTIONS
  // ============================================
  
  const loadCdnChannels = useCallback(async () => {
    setCdnLoading(true);
    try {
      const response = await fetch('/api/livetv/cdn-live-channels');
      const data = await response.json();
      
      if (data.channels) {
        setCdnChannels(data.channels);
        setCdnCountries(data.countries || []);
        setCdnByCountry(data.byCountry || {});
      }
    } catch (error) {
      console.error('Failed to load CDN-Live channels:', error);
    } finally {
      setCdnLoading(false);
    }
  }, []);

  const loadCdnStream = useCallback(async (channel: CDNLiveChannel) => {
    setCdnStreamLoading(true);
    setCdnSelectedChannel(channel);
    setCdnStreamUrl(null);
    setCdnStreamDebug(null);
    setPlayerError(null);
    
    try {
      const response = await fetch(`/api/livetv/cdn-live-stream?name=${encodeURIComponent(channel.name)}&code=${channel.code}`);
      const data = await response.json();
      
      setCdnStreamDebug(data);
      
      if (data.success && data.streamUrl) {
        // Proxy the stream through Cloudflare worker
        // The raw URL from edge.cdn-live-tv.ru requires Referer header
        // Strip /tv suffix if present (CF_TV_PROXY_URL may include it)
        const cfBaseUrl = CF_PROXY_URL.replace(/\/tv\/?$/, '').replace(/\/+$/, '');
        const proxiedUrl = `${cfBaseUrl}/cdn-live/stream?url=${encodeURIComponent(data.streamUrl)}`;
        setCdnStreamUrl(proxiedUrl);
      }
    } catch (error) {
      console.error('Failed to get CDN-Live stream:', error);
      setCdnStreamDebug({ error: String(error) });
    } finally {
      setCdnStreamLoading(false);
    }
  }, []);

  // Load CDN channels on tab switch
  useEffect(() => {
    if (activeTab === 'cdn-live' && cdnChannels.length === 0) {
      loadCdnChannels();
    }
  }, [activeTab, cdnChannels.length, loadCdnChannels]);

  // ============================================
  // PLAYER SETUP (shared across all tabs)
  // ============================================
  
  const currentStreamUrl = activeTab === 'cdn-live' ? cdnStreamUrl : streamUrl;
  
  useEffect(() => {
    if (!currentStreamUrl || !videoRef.current) return;

    // Cleanup previous instances
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (mpegtsRef.current) {
      mpegtsRef.current.destroy();
      mpegtsRef.current = null;
    }
    setPlayerError(null);

    const video = videoRef.current;
    const isHLS = currentStreamUrl.includes('.m3u8') || currentStreamUrl.includes('m3u8');

    const setupPlayer = async () => {
      if (isHLS) {
        const HlsModule = await import('hls.js');
        const Hls = HlsModule.default;
        
        if (Hls.isSupported()) {
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: true,
          });
          
          hls.loadSource(currentStreamUrl);
          hls.attachMedia(video);
          
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            video.play().catch((e) => console.error('Play failed:', e));
          });
          
          hls.on(Hls.Events.ERROR, (_event, data) => {
            setPlayerError(`HLS Error: ${data.type} - ${data.details}`);
            if (data.fatal) {
              switch (data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                  hls.startLoad();
                  break;
                case Hls.ErrorTypes.MEDIA_ERROR:
                  hls.recoverMediaError();
                  break;
                default:
                  hls.destroy();
                  break;
              }
            }
          });
          
          hlsRef.current = hls;
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = currentStreamUrl;
          video.play().catch(console.error);
        }
      } else {
        // Try mpegts.js for TS streams
        const mpegtsModule = await import('mpegts.js');
        const mpegtsLib = mpegtsModule.default;
        
        if (mpegtsLib.isSupported()) {
          const player = mpegtsLib.createPlayer({
            type: 'mpegts',
            isLive: true,
            url: currentStreamUrl,
          }, {
            enableWorker: true,
            enableStashBuffer: true,
            stashInitialSize: 384 * 1024,
          });
          
          player.attachMediaElement(video);
          player.load();
          
          player.on(mpegtsLib.Events.ERROR, (errorType: string, errorDetail: string) => {
            setPlayerError(`MPEG-TS Error: ${errorType} - ${errorDetail}`);
          });
          
          video.play().catch((err) => {
            setPlayerError(`Play failed: ${err.message}`);
          });
          
          mpegtsRef.current = player;
        }
      }
    };

    setupPlayer().catch((err) => {
      setPlayerError(`Failed to load player: ${err?.message || String(err)}`);
    });

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (mpegtsRef.current) {
        mpegtsRef.current.destroy();
        mpegtsRef.current = null;
      }
    };
  }, [currentStreamUrl]);


  // ============================================
  // STALKER PORTAL FUNCTIONS (existing)
  // ============================================

  const handleFileImport = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        const accounts = data.accounts || data;
        
        const usable = accounts
          .filter((acc: any) => {
            const notBlocked = acc.profile?.blocked !== '1' && acc.profile?.blocked !== 1;
            const hasChannels = (acc.content?.itv || 0) > 0;
            return acc.success && notBlocked && hasChannels;
          })
          .map((acc: any) => ({
            portal: acc.portal,
            mac: acc.mac,
            channels: acc.content?.itv || 0,
            status: acc.profile?.status,
            blocked: acc.profile?.blocked,
            addedAt: new Date().toISOString(),
          }))
          .sort((a: SavedAccount, b: SavedAccount) => b.channels - a.channels);

        if (usable.length > 0) {
          setSavedAccounts(prev => {
            const existing = new Set(prev.map(a => `${a.portal}|${a.mac}`));
            const newAccounts = usable.filter((a: SavedAccount) => !existing.has(`${a.portal}|${a.mac}`));
            return [...prev, ...newAccounts];
          });
          alert(`Imported ${usable.length} usable accounts.`);
        } else {
          alert('No usable accounts found in file.');
        }
      } catch (err) {
        alert('Failed to parse JSON file');
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const loadAccount = useCallback((account: SavedAccount) => {
    setPortalUrl(account.portal);
    setMacAddress(account.mac);
    setTestResult(null);
    setGenres([]);
    setChannels([]);
    setStreamUrl(null);
  }, []);

  const removeAccount = useCallback((portal: string, mac: string) => {
    setSavedAccounts(prev => prev.filter(a => !(a.portal === portal && a.mac === mac)));
  }, []);

  const saveCurrentAccount = useCallback(() => {
    if (!testResult?.success || !portalUrl || !macAddress) return;
    
    const notBlocked = testResult.profile?.blocked !== '1' && testResult.profile?.blocked !== 1;
    const hasChannels = (testResult.content?.itv || 0) > 0;
    
    if (!notBlocked || !hasChannels) {
      alert('Cannot save: Account must not be blocked and have channels');
      return;
    }

    const newAccount: SavedAccount = {
      portal: portalUrl,
      mac: macAddress,
      channels: testResult.content?.itv || 0,
      status: testResult.profile?.status,
      blocked: testResult.profile?.blocked,
      addedAt: new Date().toISOString(),
    };

    setSavedAccounts(prev => {
      const exists = prev.some(a => a.portal === portalUrl && a.mac === macAddress);
      if (exists) return prev;
      return [...prev, newAccount];
    });
  }, [testResult, portalUrl, macAddress]);

  const startAutoCycle = useCallback(async () => {
    if (savedAccounts.length === 0) {
      alert('No saved accounts to test');
      return;
    }

    setAutoCycleRunning(true);
    setAutoCycleResults([]);
    autoCycleAbortRef.current = false;
    setAutoCycleProgress({ current: 0, total: savedAccounts.length, currentAccount: '' });

    const results: AutoCycleResult[] = [];

    for (let i = 0; i < savedAccounts.length; i++) {
      if (autoCycleAbortRef.current) break;

      const account = savedAccounts[i];
      setAutoCycleProgress({ 
        current: i + 1, 
        total: savedAccounts.length, 
        currentAccount: `${account.mac} @ ${new URL(account.portal).hostname}` 
      });

      const result: AutoCycleResult = {
        portal: account.portal,
        mac: account.mac,
        success: false,
        canStream: false,
        channels: 0,
        testedAt: new Date().toISOString(),
      };

      try {
        const response = await fetch('/api/admin/iptv-debug', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'test', portalUrl: account.portal, macAddress: account.mac })
        });
        
        const data = await response.json();
        
        if (data.success && data.token) {
          result.success = true;
          result.channels = data.content?.itv || 0;
          
          if (testStreamDuringCycle && result.channels > 0) {
            try {
              const channelsRes = await fetch('/api/admin/iptv-debug', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                  action: 'channels', 
                  portalUrl: account.portal, 
                  macAddress: account.mac, 
                  token: data.token,
                  genre: '*',
                  page: 0
                })
              });
              const channelsData = await channelsRes.json();
              
              if (channelsData.success && channelsData.channels?.data?.length > 0) {
                const firstChannel = channelsData.channels.data[0];
                
                const streamRes = await fetch('/api/admin/iptv-debug', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ 
                    action: 'stream', 
                    portalUrl: account.portal, 
                    macAddress: account.mac, 
                    token: data.token,
                    cmd: firstChannel.cmd
                  })
                });
                const streamData = await streamRes.json();
                
                if (streamData.success && streamData.streamUrl) {
                  result.canStream = true;
                }
              }
            } catch (streamErr) {
              // Stream test failed
            }
          } else if (!testStreamDuringCycle) {
            result.canStream = result.channels > 0;
          }
        } else {
          result.error = data.error || 'Connection failed';
        }
      } catch (err: any) {
        result.error = err.message || 'Request failed';
      }

      results.push(result);
      setAutoCycleResults([...results]);

      if (i < savedAccounts.length - 1 && !autoCycleAbortRef.current) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    setAutoCycleRunning(false);
  }, [savedAccounts, testStreamDuringCycle]);

  const stopAutoCycle = useCallback(() => {
    autoCycleAbortRef.current = true;
  }, []);

  const loadAllChannels = useCallback(async (tokenOverride?: string, usOnly: boolean = true, category?: string) => {
    const token = tokenOverride || testResult?.token;
    if (!token) return;
    
    setLoadingChannels(true);
    setChannels([]);
    
    try {
      const response = await fetch('/api/admin/iptv-debug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'all_channels', 
          portalUrl, 
          macAddress, 
          token,
          usOnly,
          selectedGenre: category
        })
      });
      
      const data = await response.json();
      if (data.success) {
        setChannels(data.channels || []);
        setTotalChannels(data.total || 0);
        if (data.genres && data.genres.length > 0) {
          setAvailableCategories(data.genres);
        }
      }
    } catch (error) {
      console.error('Failed to load all channels:', error);
    } finally {
      setLoadingChannels(false);
    }
  }, [testResult?.token, portalUrl, macAddress]);

  const testConnection = useCallback(async () => {
    if (!portalUrl || !macAddress) return;
    
    setLoading(true);
    setTestResult(null);
    setGenres([]);
    setChannels([]);
    setStreamUrl(null);
    
    try {
      const response = await fetch('/api/admin/iptv-debug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', portalUrl, macAddress })
      });
      
      const data = await response.json();
      setTestResult(data);
      
      if (data.success && data.token) {
        const genresRes = await fetch('/api/admin/iptv-debug', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'genres', portalUrl, macAddress, token: data.token })
        });
        const genresData = await genresRes.json();
        if (genresData.success) {
          setGenres(genresData.genres || []);
        }
        
        await loadAllChannels(data.token, true, selectedCategory);
      }
    } catch (error: any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setLoading(false);
    }
  }, [portalUrl, macAddress, loadAllChannels, selectedCategory]);

  const getStreamViaCF = useCallback(async (channel: Channel) => {
    if (!portalUrl || !macAddress) return;
    
    setLoadingStream(true);
    setSelectedChannel(channel);
    setStreamUrl(null);
    setRawStreamUrl(null);
    setStreamDebug(null);
    
    try {
      let baseUrl = portalUrl.trim();
      if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
        baseUrl = 'http://' + baseUrl;
      }
      baseUrl = baseUrl.replace(/\/+$/, '');
      if (baseUrl.endsWith('/c')) baseUrl = baseUrl.slice(0, -2);
      
      const handshakeUrl = new URL('/portal.php', baseUrl);
      handshakeUrl.searchParams.set('type', 'stb');
      handshakeUrl.searchParams.set('action', 'handshake');
      handshakeUrl.searchParams.set('token', '');
      handshakeUrl.searchParams.set('JsHttpRequest', '1-xml');
      
      const cfBaseUrl = CF_PROXY_URL.replace(/\/tv\/?$/, '').replace(/\/+$/, '');
      
      const tokenParams = new URLSearchParams({ url: handshakeUrl.toString(), mac: macAddress });
      const tokenRes = await fetch(`${cfBaseUrl}/iptv/api?${tokenParams.toString()}`);
      const tokenText = await tokenRes.text();
      const tokenClean = tokenText.replace(/^\/\*-secure-\s*/, '').replace(/\s*\*\/$/, '');
      const tokenData = JSON.parse(tokenClean);
      
      if (!tokenData?.js?.token) {
        throw new Error('Failed to get token from CF proxy');
      }
      
      const cfToken = tokenData.js.token;
      
      const createLinkUrl = new URL('/portal.php', baseUrl);
      createLinkUrl.searchParams.set('type', 'itv');
      createLinkUrl.searchParams.set('action', 'create_link');
      createLinkUrl.searchParams.set('cmd', channel.cmd);
      createLinkUrl.searchParams.set('series', '');
      createLinkUrl.searchParams.set('forced_storage', 'undefined');
      createLinkUrl.searchParams.set('disable_ad', '0');
      createLinkUrl.searchParams.set('download', '0');
      createLinkUrl.searchParams.set('JsHttpRequest', '1-xml');
      
      const streamParams = new URLSearchParams({ 
        url: createLinkUrl.toString(), 
        mac: macAddress,
        token: cfToken
      });
      const streamRes = await fetch(`${cfBaseUrl}/iptv/api?${streamParams.toString()}`);
      const streamText = await streamRes.text();
      const streamClean = streamText.replace(/^\/\*-secure-\s*/, '').replace(/\s*\*\/$/, '');
      const streamData = JSON.parse(streamClean);
      
      let streamUrlResult = streamData?.js?.cmd || null;
      if (streamUrlResult) {
        const prefixes = ['ffmpeg ', 'ffrt ', 'ffrt2 ', 'ffrt3 ', 'ffrt4 '];
        for (const prefix of prefixes) {
          if (streamUrlResult.startsWith(prefix)) {
            streamUrlResult = streamUrlResult.substring(prefix.length);
            break;
          }
        }
        streamUrlResult = streamUrlResult.trim();
      }
      
      setStreamDebug({ 
        success: !!streamUrlResult,
        streamUrl: streamUrlResult,
        channelCmd: channel.cmd, 
        channelName: channel.name,
        note: 'Stream obtained via Cloudflare proxy'
      });
      
      if (streamUrlResult) {
        setRawStreamUrl(streamUrlResult);
        const playbackParams = new URLSearchParams({ url: streamUrlResult, mac: macAddress });
        const proxiedUrl = `${cfBaseUrl}/iptv/stream?${playbackParams.toString()}`;
        setStreamUrl(proxiedUrl);
      }
    } catch (error) {
      setStreamDebug({ error: String(error), note: 'CF stream test failed' });
    } finally {
      setLoadingStream(false);
    }
  }, [portalUrl, macAddress]);

  const debugSources = useCallback(async () => {
    if (!portalUrl || !macAddress) return;
    
    setDebugSourcesLoading(true);
    setDebugSourcesResult(null);
    
    try {
      const response = await fetch('/api/admin/iptv-debug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'debug_sources', 
          portalUrl, 
          macAddress 
        })
      });
      
      const data = await response.json();
      setDebugSourcesResult(data);
    } catch (error) {
      setDebugSourcesResult({ error: String(error) });
    } finally {
      setDebugSourcesLoading(false);
    }
  }, [portalUrl, macAddress]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };


  // ============================================
  // RENDER
  // ============================================

  return (
    <div>
      {/* Header */}
      <div style={{
        marginBottom: '32px',
        paddingBottom: '20px',
        borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
      }}>
        <h2 style={{
          margin: 0,
          color: '#f8fafc',
          fontSize: '24px',
          fontWeight: '600',
          display: 'flex',
          alignItems: 'center',
          gap: '12px'
        }}>
          <Tv size={28} />
          IPTV Stream Debugger
        </h2>
        <p style={{ margin: '8px 0 0 0', color: '#94a3b8', fontSize: '16px' }}>
          Test and debug streams from CDN-Live.tv and Stalker portals
        </p>
      </div>

      {/* Tab Navigation */}
      <div style={{
        display: 'flex',
        gap: '8px',
        marginBottom: '24px',
        borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
        paddingBottom: '16px'
      }}>
        <button
          onClick={() => setActiveTab('cdn-live')}
          style={{
            padding: '12px 24px',
            background: activeTab === 'cdn-live' ? 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)' : 'rgba(30, 41, 59, 0.5)',
            border: activeTab === 'cdn-live' ? 'none' : '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '8px',
            color: '#fff',
            fontSize: '14px',
            fontWeight: '600',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}
        >
          <Globe size={18} />
          CDN-Live.tv ({cdnChannels.length || '...'})
        </button>
        <button
          onClick={() => setActiveTab('stalker')}
          style={{
            padding: '12px 24px',
            background: activeTab === 'stalker' ? 'linear-gradient(135deg, #7877c6 0%, #9333ea 100%)' : 'rgba(30, 41, 59, 0.5)',
            border: activeTab === 'stalker' ? 'none' : '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '8px',
            color: '#fff',
            fontSize: '14px',
            fontWeight: '600',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}
        >
          <Server size={18} />
          Stalker Portal
        </button>
      </div>

      {/* ============================================ */}
      {/* CDN-LIVE.TV TAB */}
      {/* ============================================ */}
      {activeTab === 'cdn-live' && (
        <div>
          {/* Controls */}
          <div style={{
            background: 'rgba(30, 41, 59, 0.5)',
            borderRadius: '16px',
            padding: '24px',
            marginBottom: '24px',
            border: '1px solid rgba(255, 255, 255, 0.1)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <h3 style={{ color: '#f8fafc', margin: 0, fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Globe size={18} color="#22c55e" />
                CDN-Live.tv Channels
              </h3>
              <button
                onClick={loadCdnChannels}
                disabled={cdnLoading}
                style={{
                  padding: '8px 16px',
                  background: cdnLoading ? 'rgba(34, 197, 94, 0.3)' : 'rgba(34, 197, 94, 0.2)',
                  border: '1px solid rgba(34, 197, 94, 0.3)',
                  borderRadius: '8px',
                  color: '#22c55e',
                  fontSize: '13px',
                  cursor: cdnLoading ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                {cdnLoading ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <RotateCcw size={14} />}
                Refresh
              </button>
            </div>

            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              {/* Country Filter */}
              <select
                value={cdnSelectedCountry}
                onChange={(e) => setCdnSelectedCountry(e.target.value)}
                style={{
                  padding: '10px 14px',
                  background: 'rgba(15, 23, 42, 0.6)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '8px',
                  color: '#f8fafc',
                  fontSize: '14px',
                  minWidth: '180px',
                  outline: 'none',
                  cursor: 'pointer'
                }}
              >
                <option value="all">All Countries ({cdnChannels.length})</option>
                {cdnCountries.map(country => (
                  <option key={country} value={country}>
                    {country.toUpperCase()} ({cdnByCountry[country]?.length || 0})
                  </option>
                ))}
              </select>

              {/* Search */}
              <div style={{ position: 'relative', flex: 1, minWidth: '200px' }}>
                <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
                <input
                  type="text"
                  placeholder="Search channels..."
                  value={cdnSearch}
                  onChange={(e) => setCdnSearch(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 14px 10px 38px',
                    background: 'rgba(15, 23, 42, 0.6)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '8px',
                    color: '#f8fafc',
                    fontSize: '14px',
                    outline: 'none'
                  }}
                />
              </div>
            </div>
          </div>

          {/* Channel Grid */}
          <div style={{
            background: 'rgba(30, 41, 59, 0.5)',
            borderRadius: '16px',
            padding: '24px',
            marginBottom: '24px',
            border: '1px solid rgba(255, 255, 255, 0.1)'
          }}>
            {cdnLoading ? (
              <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>
                <Loader2 size={32} style={{ margin: '0 auto 12px', animation: 'spin 1s linear infinite' }} />
                Loading channels...
              </div>
            ) : (
              (() => {
                let filtered = cdnSelectedCountry === 'all' 
                  ? cdnChannels 
                  : (cdnByCountry[cdnSelectedCountry] || []);
                
                if (cdnSearch) {
                  const searchLower = cdnSearch.toLowerCase();
                  filtered = filtered.filter(ch => ch.name.toLowerCase().includes(searchLower));
                }

                return (
                  <>
                    <div style={{ marginBottom: '12px', color: '#64748b', fontSize: '13px' }}>
                      {filtered.length} channels {cdnSearch ? `matching "${cdnSearch}"` : ''}
                    </div>
                    <div style={{ 
                      display: 'grid', 
                      gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', 
                      gap: '10px',
                      maxHeight: '500px',
                      overflowY: 'auto'
                    }}>
                      {filtered.map((channel) => (
                        <div
                          key={`${channel.code}-${channel.name}`}
                          style={{
                            background: cdnSelectedChannel?.name === channel.name 
                              ? 'rgba(34, 197, 94, 0.2)' 
                              : 'rgba(15, 23, 42, 0.6)',
                            border: cdnSelectedChannel?.name === channel.name 
                              ? '1px solid #22c55e' 
                              : '1px solid rgba(255, 255, 255, 0.1)',
                            borderRadius: '12px',
                            padding: '12px 16px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '12px'
                          }}
                        >
                          {channel.image ? (
                            <img 
                              src={channel.image} 
                              alt={channel.name}
                              style={{ width: '40px', height: '40px', borderRadius: '8px', objectFit: 'cover' }}
                              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                            />
                          ) : (
                            <div style={{
                              width: '40px',
                              height: '40px',
                              borderRadius: '8px',
                              background: 'rgba(34, 197, 94, 0.2)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center'
                            }}>
                              <Tv size={20} color="#22c55e" />
                            </div>
                          )}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ 
                              color: '#f8fafc', 
                              fontSize: '14px', 
                              fontWeight: '500',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis'
                            }}>
                              {channel.name}
                            </div>
                            <div style={{ color: '#64748b', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span>{channel.code.toUpperCase()}</span>
                              {channel.viewers > 0 && <span>• {channel.viewers} viewers</span>}
                            </div>
                          </div>
                          <button
                            onClick={() => loadCdnStream(channel)}
                            disabled={cdnStreamLoading}
                            style={{
                              padding: '8px 14px',
                              background: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
                              border: 'none',
                              borderRadius: '6px',
                              color: '#fff',
                              fontSize: '12px',
                              fontWeight: '500',
                              cursor: cdnStreamLoading ? 'not-allowed' : 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                              opacity: cdnStreamLoading ? 0.5 : 1
                            }}
                          >
                            <Play size={14} /> Test
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                );
              })()
            )}
          </div>

          {/* CDN-Live Player */}
          {(cdnStreamLoading || cdnStreamUrl) && (
            <div style={{
              background: 'rgba(30, 41, 59, 0.5)',
              borderRadius: '16px',
              padding: '24px',
              border: '1px solid rgba(34, 197, 94, 0.3)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
                <h3 style={{ color: '#f8fafc', margin: 0, fontSize: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <Play size={20} color="#22c55e" />
                  {cdnSelectedChannel?.name || 'Stream'}
                </h3>
                <span style={{ color: '#22c55e', fontSize: '12px', background: 'rgba(34, 197, 94, 0.2)', padding: '4px 10px', borderRadius: '6px' }}>
                  CDN-Live.tv
                </span>
              </div>

              {cdnStreamLoading ? (
                <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>
                  <Loader2 size={32} style={{ margin: '0 auto 12px', animation: 'spin 1s linear infinite' }} />
                  Extracting stream URL...
                </div>
              ) : cdnStreamUrl ? (
                <>
                  <div style={{
                    background: '#000',
                    borderRadius: '12px',
                    overflow: 'hidden',
                    marginBottom: '16px',
                    aspectRatio: '16/9',
                    position: 'relative'
                  }}>
                    <video
                      ref={videoRef}
                      controls
                      autoPlay
                      playsInline
                      muted
                      style={{ width: '100%', height: '100%' }}
                    />
                    {playerError && (
                      <div style={{
                        position: 'absolute',
                        bottom: '10px',
                        left: '10px',
                        right: '10px',
                        background: 'rgba(239, 68, 68, 0.9)',
                        color: '#fff',
                        padding: '8px 12px',
                        borderRadius: '6px',
                        fontSize: '12px'
                      }}>
                        {playerError}
                      </div>
                    )}
                  </div>

                  <div style={{ 
                    background: 'rgba(15, 23, 42, 0.6)', 
                    padding: '12px 16px', 
                    borderRadius: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px'
                  }}>
                    <code style={{ 
                      color: '#22c55e', 
                      fontSize: '11px',
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}>
                      {cdnStreamUrl}
                    </code>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        onClick={() => copyToClipboard(cdnStreamUrl)}
                        style={{
                          background: 'rgba(34, 197, 94, 0.2)',
                          border: 'none',
                          color: '#22c55e',
                          cursor: 'pointer',
                          padding: '8px',
                          borderRadius: '6px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          fontSize: '12px'
                        }}
                      >
                        <Copy size={14} /> Copy
                      </button>
                      <a
                        href={cdnStreamUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          background: 'rgba(34, 197, 94, 0.2)',
                          border: 'none',
                          color: '#22c55e',
                          cursor: 'pointer',
                          padding: '8px',
                          borderRadius: '6px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          fontSize: '12px',
                          textDecoration: 'none'
                        }}
                      >
                        <ExternalLink size={14} /> Open
                      </a>
                    </div>
                  </div>

                  {/* Debug Info */}
                  {cdnStreamDebug && (
                    <details style={{ marginTop: '12px' }}>
                      <summary style={{ color: '#64748b', fontSize: '12px', cursor: 'pointer' }}>Debug Info</summary>
                      <pre style={{ 
                        color: '#94a3b8', 
                        fontSize: '11px', 
                        background: 'rgba(0,0,0,0.3)',
                        padding: '12px',
                        borderRadius: '8px',
                        marginTop: '8px',
                        overflow: 'auto',
                        maxHeight: '200px'
                      }}>
                        {JSON.stringify(cdnStreamDebug, null, 2)}
                      </pre>
                    </details>
                  )}
                </>
              ) : cdnStreamDebug?.error && (
                <div style={{
                  background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  borderRadius: '8px',
                  padding: '16px',
                  color: '#ef4444'
                }}>
                  <div style={{ fontWeight: '600', marginBottom: '8px' }}>Failed to extract stream</div>
                  <div style={{ fontSize: '13px' }}>{cdnStreamDebug.error}</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}



      {/* ============================================ */}
      {/* STALKER PORTAL TAB */}
      {/* ============================================ */}
      {activeTab === 'stalker' && (
        <div>
          {/* Connection Form */}
          <div style={{
            background: 'rgba(30, 41, 59, 0.5)',
            borderRadius: '16px',
            padding: '24px',
            marginBottom: '24px',
            border: '1px solid rgba(255, 255, 255, 0.1)'
          }}>
            <h3 style={{ color: '#f8fafc', margin: '0 0 20px 0', fontSize: '16px' }}>
              Portal Connection
            </h3>
            
            <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
              <div style={{ flex: '1', minWidth: '250px' }}>
                <label style={{ display: 'block', color: '#94a3b8', fontSize: '14px', marginBottom: '8px' }}>
                  Portal URL
                </label>
                <input
                  type="text"
                  value={portalUrl}
                  onChange={(e) => setPortalUrl(e.target.value)}
                  placeholder="http://example.com/c"
                  style={{
                    width: '100%',
                    padding: '12px 16px',
                    background: 'rgba(15, 23, 42, 0.6)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '8px',
                    color: '#f8fafc',
                    fontSize: '14px',
                    outline: 'none'
                  }}
                />
              </div>
              
              <div style={{ flex: '1', minWidth: '200px' }}>
                <label style={{ display: 'block', color: '#94a3b8', fontSize: '14px', marginBottom: '8px' }}>
                  MAC Address
                </label>
                <input
                  type="text"
                  value={macAddress}
                  onChange={(e) => setMacAddress(e.target.value)}
                  placeholder="00:1A:79:XX:XX:XX"
                  style={{
                    width: '100%',
                    padding: '12px 16px',
                    background: 'rgba(15, 23, 42, 0.6)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '8px',
                    color: '#f8fafc',
                    fontSize: '14px',
                    outline: 'none'
                  }}
                />
              </div>
              
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px' }}>
                <button
                  onClick={testConnection}
                  disabled={loading || !portalUrl || !macAddress}
                  style={{
                    padding: '12px 24px',
                    background: loading ? 'rgba(120, 119, 198, 0.3)' : 'linear-gradient(135deg, #7877c6 0%, #9333ea 100%)',
                    border: 'none',
                    borderRadius: '8px',
                    color: '#fff',
                    fontSize: '14px',
                    fontWeight: '600',
                    cursor: loading ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px'
                  }}
                >
                  {loading ? <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /> : <Wifi size={18} />}
                  {loading ? 'Testing...' : 'Test Connection'}
                </button>
                <button
                  onClick={debugSources}
                  disabled={debugSourcesLoading || !portalUrl || !macAddress}
                  style={{
                    padding: '12px 16px',
                    background: debugSourcesLoading ? 'rgba(251, 191, 36, 0.3)' : 'rgba(251, 191, 36, 0.2)',
                    border: '1px solid rgba(251, 191, 36, 0.3)',
                    borderRadius: '8px',
                    color: '#fbbf24',
                    fontSize: '14px',
                    fontWeight: '600',
                    cursor: debugSourcesLoading ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px'
                  }}
                  title="Test which IP sources can connect to this portal"
                >
                  {debugSourcesLoading ? <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /> : <Server size={18} />}
                  Debug Sources
                </button>
              </div>
            </div>
          </div>

          {/* Debug Sources Results */}
          {debugSourcesResult && (
            <div style={{
              background: 'rgba(30, 41, 59, 0.5)',
              borderRadius: '16px',
              padding: '24px',
              marginBottom: '24px',
              border: '1px solid rgba(251, 191, 36, 0.3)'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <h3 style={{ color: '#fbbf24', margin: 0, fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Server size={18} />
                  IP Source Debug Results
                </h3>
                <button
                  onClick={() => setDebugSourcesResult(null)}
                  style={{
                    padding: '4px 8px',
                    background: 'transparent',
                    border: 'none',
                    color: '#64748b',
                    cursor: 'pointer',
                    fontSize: '18px'
                  }}
                >
                  ×
                </button>
              </div>
              
              {debugSourcesResult.summary && (
                <div style={{
                  background: 'rgba(0, 0, 0, 0.2)',
                  padding: '12px 16px',
                  borderRadius: '8px',
                  marginBottom: '16px',
                  color: '#f8fafc',
                  fontSize: '14px'
                }}>
                  <strong>Recommendation:</strong> {debugSourcesResult.summary.recommendation}
                </div>
              )}
              
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '12px' }}>
                {debugSourcesResult.results && Object.entries(debugSourcesResult.results).map(([key, result]: [string, any]) => (
                  <div 
                    key={key}
                    style={{
                      background: result.success ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                      border: `1px solid ${result.success ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                      borderRadius: '8px',
                      padding: '12px 16px'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <span style={{ color: '#f8fafc', fontWeight: '600', fontSize: '13px' }}>{result.source}</span>
                      <span style={{ 
                        color: result.success ? '#22c55e' : '#ef4444',
                        fontSize: '12px',
                        fontWeight: '600'
                      }}>
                        {result.success ? '✓ Works' : '✗ Blocked'}
                      </span>
                    </div>
                    {result.latency && (
                      <div style={{ color: '#94a3b8', fontSize: '12px' }}>
                        Latency: {result.latency}ms
                      </div>
                    )}
                    {result.error && (
                      <div style={{ color: '#ef4444', fontSize: '12px' }}>
                        Error: {result.error}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Saved Accounts */}
          <div style={{
            background: 'rgba(30, 41, 59, 0.5)',
            borderRadius: '16px',
            padding: '24px',
            marginBottom: '24px',
            border: '1px solid rgba(255, 255, 255, 0.1)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ color: '#f8fafc', margin: 0, fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Star size={18} />
                Saved Accounts ({savedAccounts.length})
              </h3>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  onChange={handleFileImport}
                  style={{ display: 'none' }}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  style={{
                    padding: '8px 16px',
                    background: 'rgba(120, 119, 198, 0.2)',
                    border: '1px solid rgba(120, 119, 198, 0.3)',
                    borderRadius: '8px',
                    color: '#7877c6',
                    fontSize: '13px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}
                >
                  <Upload size={14} /> Import JSON
                </button>
                {testResult?.success && (testResult.content?.itv || 0) > 0 && (
                  <button
                    onClick={saveCurrentAccount}
                    style={{
                      padding: '8px 16px',
                      background: 'rgba(34, 197, 94, 0.2)',
                      border: '1px solid rgba(34, 197, 94, 0.3)',
                      borderRadius: '8px',
                      color: '#22c55e',
                      fontSize: '13px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}
                  >
                    <Star size={14} /> Save Current
                  </button>
                )}
              </div>
            </div>

            {/* Auto-Cycle Controls */}
            {savedAccounts.length > 0 && (
              <div style={{
                background: 'rgba(15, 23, 42, 0.4)',
                borderRadius: '12px',
                padding: '16px',
                marginBottom: '16px',
                border: '1px solid rgba(255, 255, 255, 0.05)'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <Zap size={18} color="#fbbf24" />
                    <span style={{ color: '#f8fafc', fontSize: '14px', fontWeight: '500' }}>Auto-Cycle Test</span>
                  </div>
                  
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={testStreamDuringCycle}
                        onChange={(e) => setTestStreamDuringCycle(e.target.checked)}
                        disabled={autoCycleRunning}
                        style={{ cursor: 'pointer' }}
                      />
                      <span style={{ color: '#94a3b8', fontSize: '13px' }}>Test stream access</span>
                    </label>
                    
                    {!autoCycleRunning ? (
                      <button
                        onClick={startAutoCycle}
                        style={{
                          padding: '8px 16px',
                          background: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)',
                          border: 'none',
                          borderRadius: '8px',
                          color: '#000',
                          fontSize: '13px',
                          fontWeight: '600',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px'
                        }}
                      >
                        <RotateCcw size={14} /> Start Cycle Test
                      </button>
                    ) : (
                      <button
                        onClick={stopAutoCycle}
                        style={{
                          padding: '8px 16px',
                          background: 'rgba(239, 68, 68, 0.8)',
                          border: 'none',
                          borderRadius: '8px',
                          color: '#fff',
                          fontSize: '13px',
                          fontWeight: '600',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px'
                        }}
                      >
                        <Square size={14} /> Stop
                      </button>
                    )}
                  </div>
                </div>
                
                {autoCycleRunning && (
                  <div style={{ marginTop: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                      <Loader2 size={14} color="#fbbf24" style={{ animation: 'spin 1s linear infinite' }} />
                      <span style={{ color: '#fbbf24', fontSize: '13px' }}>
                        Testing {autoCycleProgress.current}/{autoCycleProgress.total}: {autoCycleProgress.currentAccount}
                      </span>
                    </div>
                    <div style={{
                      height: '4px',
                      background: 'rgba(255, 255, 255, 0.1)',
                      borderRadius: '2px',
                      overflow: 'hidden'
                    }}>
                      <div style={{
                        height: '100%',
                        width: `${(autoCycleProgress.current / autoCycleProgress.total) * 100}%`,
                        background: 'linear-gradient(90deg, #fbbf24, #f59e0b)',
                        transition: 'width 0.3s ease'
                      }} />
                    </div>
                  </div>
                )}
                
                {autoCycleResults.length > 0 && !autoCycleRunning && (
                  <div style={{ marginTop: '12px', display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <CheckCircle size={14} color="#22c55e" />
                      <span style={{ color: '#22c55e', fontSize: '13px' }}>
                        {autoCycleResults.filter(r => r.canStream).length} working
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <AlertCircle size={14} color="#f59e0b" />
                      <span style={{ color: '#f59e0b', fontSize: '13px' }}>
                        {autoCycleResults.filter(r => r.success && !r.canStream).length} connected (no stream)
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <AlertCircle size={14} color="#ef4444" />
                      <span style={{ color: '#ef4444', fontSize: '13px' }}>
                        {autoCycleResults.filter(r => !r.success).length} failed
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {savedAccounts.length === 0 ? (
              <p style={{ color: '#64748b', fontSize: '14px', margin: 0 }}>
                No saved accounts. Import a results JSON file or save a working account.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '200px', overflowY: 'auto' }}>
                {savedAccounts.map((account, idx) => (
                  <div
                    key={`${account.portal}-${account.mac}-${idx}`}
                    style={{
                      background: 'rgba(15, 23, 42, 0.6)',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      borderRadius: '8px',
                      padding: '12px 16px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '12px'
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: '#f8fafc', fontSize: '13px', fontWeight: '500' }}>
                        {account.mac}
                      </div>
                      <div style={{ color: '#64748b', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {account.portal} • {account.channels.toLocaleString()} channels
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        onClick={() => loadAccount(account)}
                        style={{
                          padding: '6px 12px',
                          background: 'rgba(120, 119, 198, 0.2)',
                          border: 'none',
                          borderRadius: '6px',
                          color: '#7877c6',
                          fontSize: '12px',
                          cursor: 'pointer'
                        }}
                      >
                        Load
                      </button>
                      <button
                        onClick={() => removeAccount(account.portal, account.mac)}
                        style={{
                          padding: '6px',
                          background: 'rgba(239, 68, 68, 0.2)',
                          border: 'none',
                          borderRadius: '6px',
                          color: '#ef4444',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center'
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>


          {/* Test Result */}
          {testResult && (
            <div style={{
              background: testResult.success 
                ? 'rgba(34, 197, 94, 0.1)' 
                : 'rgba(239, 68, 68, 0.1)',
              borderRadius: '16px',
              padding: '24px',
              marginBottom: '24px',
              border: `1px solid ${testResult.success ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                {testResult.success ? (
                  <CheckCircle size={24} color="#22c55e" />
                ) : (
                  <AlertCircle size={24} color="#ef4444" />
                )}
                <h3 style={{ 
                  color: testResult.success ? '#22c55e' : '#ef4444', 
                  margin: 0, 
                  fontSize: '18px' 
                }}>
                  {testResult.success ? 'Connection Successful' : 'Connection Failed'}
                </h3>
              </div>

              {testResult.error && (
                <p style={{ color: '#ef4444', margin: '0 0 16px 0' }}>{testResult.error}</p>
              )}

              {testResult.success && testResult.profile && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
                  <div style={{ background: 'rgba(15, 23, 42, 0.4)', padding: '16px', borderRadius: '12px' }}>
                    <div style={{ color: '#94a3b8', fontSize: '12px', marginBottom: '4px' }}>Status</div>
                    <div style={{ 
                      color: (testResult.profile.status === 1 || testResult.profile.status === '1') ? '#22c55e' : '#ef4444',
                      fontSize: '16px',
                      fontWeight: '600'
                    }}>
                      {(testResult.profile.status === 1 || testResult.profile.status === '1') ? 'Active' : `Inactive (${testResult.profile.status})`}
                    </div>
                  </div>
                  
                  <div style={{ background: 'rgba(15, 23, 42, 0.4)', padding: '16px', borderRadius: '12px' }}>
                    <div style={{ color: '#94a3b8', fontSize: '12px', marginBottom: '4px' }}>Blocked</div>
                    <div style={{ 
                      color: (testResult.profile.blocked === '1' || testResult.profile.blocked === 1) ? '#ef4444' : '#22c55e',
                      fontSize: '16px',
                      fontWeight: '600'
                    }}>
                      {(testResult.profile.blocked === '1' || testResult.profile.blocked === 1) ? 'Yes' : 'No'}
                    </div>
                  </div>

                  <div style={{ background: 'rgba(15, 23, 42, 0.4)', padding: '16px', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <Tv size={20} color="#7877c6" />
                    <div>
                      <div style={{ color: '#94a3b8', fontSize: '12px' }}>Live TV</div>
                      <div style={{ color: '#f8fafc', fontSize: '16px', fontWeight: '600' }}>
                        {testResult.content?.itv?.toLocaleString() || 0}
                      </div>
                    </div>
                  </div>

                  <div style={{ background: 'rgba(15, 23, 42, 0.4)', padding: '16px', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <Radio size={20} color="#7877c6" />
                    <div>
                      <div style={{ color: '#94a3b8', fontSize: '12px' }}>Radio</div>
                      <div style={{ color: '#f8fafc', fontSize: '16px', fontWeight: '600' }}>
                        {testResult.content?.radio?.toLocaleString() || 0}
                      </div>
                    </div>
                  </div>

                  <div style={{ background: 'rgba(15, 23, 42, 0.4)', padding: '16px', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <Film size={20} color="#7877c6" />
                    <div>
                      <div style={{ color: '#94a3b8', fontSize: '12px' }}>VOD</div>
                      <div style={{ color: '#f8fafc', fontSize: '16px', fontWeight: '600' }}>
                        {testResult.content?.vod?.toLocaleString() || 0}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {testResult.success && testResult.token && (
                <div style={{ marginTop: '16px' }}>
                  <div style={{ 
                    background: 'rgba(15, 23, 42, 0.4)', 
                    padding: '12px 16px', 
                    borderRadius: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                  }}>
                    <div>
                      <span style={{ color: '#94a3b8', fontSize: '12px' }}>Token: </span>
                      <code style={{ color: '#7877c6', fontSize: '12px' }}>{testResult.token}</code>
                    </div>
                    <button
                      onClick={() => copyToClipboard(testResult.token!)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#94a3b8',
                        cursor: 'pointer',
                        padding: '4px'
                      }}
                    >
                      <Copy size={16} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Channels Browser */}
          {testResult?.success && (
            <div style={{
              background: 'rgba(30, 41, 59, 0.5)',
              borderRadius: '16px',
              padding: '24px',
              marginBottom: '24px',
              border: '1px solid rgba(255, 255, 255, 0.1)'
            }}>
              <h3 style={{ color: '#f8fafc', margin: '0 0 20px 0', fontSize: '16px' }}>
                Channel Browser ({totalChannels} channels loaded)
              </h3>

              <div style={{ marginBottom: '16px', display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                <select
                  value={selectedCategory}
                  onChange={(e) => {
                    setSelectedCategory(e.target.value);
                    if (testResult?.token) {
                      loadAllChannels(testResult.token, true, e.target.value);
                    }
                  }}
                  style={{
                    padding: '8px 12px',
                    background: 'rgba(15, 23, 42, 0.6)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '8px',
                    color: '#f8fafc',
                    fontSize: '13px',
                    minWidth: '200px',
                    outline: 'none',
                    cursor: 'pointer'
                  }}
                >
                  <option value="all">All US/NA/CA Categories</option>
                  {availableCategories.map(cat => (
                    <option key={cat.id} value={cat.id}>{cat.title}</option>
                  ))}
                </select>
                
                <input
                  type="text"
                  placeholder="Search channels..."
                  value={channelSearch}
                  onChange={(e) => setChannelSearch(e.target.value)}
                  style={{
                    padding: '8px 12px',
                    background: 'rgba(15, 23, 42, 0.6)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '8px',
                    color: '#f8fafc',
                    fontSize: '13px',
                    width: '200px',
                    outline: 'none'
                  }}
                />
                
                <button
                  onClick={() => loadAllChannels(undefined, true, selectedCategory)}
                  disabled={loadingChannels}
                  style={{
                    padding: '6px 12px',
                    background: loadingChannels ? 'rgba(120, 119, 198, 0.3)' : 'rgba(120, 119, 198, 0.2)',
                    border: '1px solid rgba(120, 119, 198, 0.3)',
                    borderRadius: '6px',
                    color: '#7877c6',
                    fontSize: '12px',
                    cursor: loadingChannels ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}
                >
                  {loadingChannels ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <RotateCcw size={12} />}
                  Reload
                </button>
              </div>

              {loadingChannels ? (
                <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>
                  <Loader2 size={32} style={{ margin: '0 auto 12px', animation: 'spin 1s linear infinite' }} />
                  Loading channels...
                </div>
              ) : channels.length > 0 ? (
                (() => {
                  let filteredChannels = channels;
                  
                  if (channelSearch) {
                    const searchLower = channelSearch.toLowerCase();
                    filteredChannels = filteredChannels.filter(ch => 
                      ch.name.toLowerCase().includes(searchLower)
                    );
                  }
                  
                  filteredChannels.sort((a, b) => {
                    const genreCompare = (a.genre_title || '').localeCompare(b.genre_title || '');
                    if (genreCompare !== 0) return genreCompare;
                    return a.name.localeCompare(b.name);
                  });
                  
                  return (
                    <>
                      <div style={{ marginBottom: '12px', color: '#64748b', fontSize: '13px' }}>
                        🇺🇸 {filteredChannels.length} channels {channelSearch ? `matching "${channelSearch}"` : ''}
                      </div>
                      <div style={{ 
                        display: 'grid', 
                        gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', 
                        gap: '10px',
                        maxHeight: '500px',
                        overflowY: 'auto'
                      }}>
                        {filteredChannels.map((channel) => (
                          <div
                            key={channel.id}
                            style={{
                              background: selectedChannel?.id === channel.id 
                                ? 'rgba(120, 119, 198, 0.2)' 
                                : 'rgba(15, 23, 42, 0.6)',
                              border: selectedChannel?.id === channel.id 
                                ? '1px solid #7877c6' 
                                : '1px solid rgba(255, 255, 255, 0.1)',
                              borderRadius: '12px',
                              padding: '12px 16px',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '12px'
                            }}
                          >
                            <div style={{
                              width: '40px',
                              height: '40px',
                              borderRadius: '8px',
                              background: 'rgba(120, 119, 198, 0.2)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center'
                            }}>
                              <Tv size={20} color="#7877c6" />
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ 
                                color: '#f8fafc', 
                                fontSize: '14px', 
                                fontWeight: '500',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis'
                              }}>
                                {channel.name}
                              </div>
                              <div style={{ color: '#64748b', fontSize: '12px' }}>
                                #{channel.number}
                              </div>
                            </div>
                            <button
                              onClick={() => getStreamViaCF(channel)}
                              disabled={loadingStream}
                              style={{
                                padding: '8px 14px',
                                background: 'linear-gradient(135deg, #7877c6 0%, #9333ea 100%)',
                                border: 'none',
                                borderRadius: '6px',
                                color: '#fff',
                                fontSize: '12px',
                                fontWeight: '500',
                                cursor: loadingStream ? 'not-allowed' : 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '4px',
                                opacity: loadingStream ? 0.5 : 1
                              }}
                            >
                              <Play size={14} /> Play
                            </button>
                          </div>
                        ))}
                      </div>
                    </>
                  );
                })()
              ) : (
                <div style={{ textAlign: 'center', padding: '40px', color: '#64748b' }}>
                  Click "Reload" to load channels
                </div>
              )}
            </div>
          )}

          {/* Stalker Stream Player */}
          {(loadingStream || streamUrl) && (
            <div style={{
              background: 'rgba(30, 41, 59, 0.5)',
              borderRadius: '16px',
              padding: '24px',
              border: '1px solid rgba(120, 119, 198, 0.3)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
                <h3 style={{ color: '#f8fafc', margin: 0, fontSize: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <Play size={20} />
                  {selectedChannel?.name || 'Stream'}
                </h3>
                <div style={{
                  padding: '4px 10px',
                  borderRadius: '6px',
                  fontSize: '11px',
                  fontWeight: '500',
                  background: RPI_PROXY_URL ? 'rgba(34, 197, 94, 0.2)' : 'rgba(251, 191, 36, 0.2)',
                  color: RPI_PROXY_URL ? '#22c55e' : '#fbbf24'
                }}>
                  {RPI_PROXY_URL ? '🏠 RPi Proxy' : '☁️ CF Proxy'}
                </div>
              </div>

              {loadingStream ? (
                <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>
                  <Loader2 size={32} style={{ margin: '0 auto 12px', animation: 'spin 1s linear infinite' }} />
                  Getting stream URL...
                </div>
              ) : streamUrl ? (
                <>
                  <div style={{
                    background: '#000',
                    borderRadius: '12px',
                    overflow: 'hidden',
                    marginBottom: '16px',
                    aspectRatio: '16/9',
                    position: 'relative'
                  }}>
                    <video
                      ref={videoRef}
                      controls
                      autoPlay
                      playsInline
                      muted
                      style={{ width: '100%', height: '100%' }}
                    />
                    {playerError && (
                      <div style={{
                        position: 'absolute',
                        bottom: '10px',
                        left: '10px',
                        right: '10px',
                        background: 'rgba(239, 68, 68, 0.9)',
                        color: '#fff',
                        padding: '8px 12px',
                        borderRadius: '6px',
                        fontSize: '12px'
                      }}>
                        {playerError}
                      </div>
                    )}
                  </div>

                  <div style={{ 
                    background: 'rgba(15, 23, 42, 0.6)', 
                    padding: '12px 16px', 
                    borderRadius: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px'
                  }}>
                    <code style={{ 
                      color: '#7877c6', 
                      fontSize: '11px',
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}>
                      {rawStreamUrl || streamUrl}
                    </code>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        onClick={() => copyToClipboard(rawStreamUrl || streamUrl || '')}
                        style={{
                          background: 'rgba(120, 119, 198, 0.2)',
                          border: 'none',
                          color: '#7877c6',
                          cursor: 'pointer',
                          padding: '8px',
                          borderRadius: '6px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          fontSize: '12px'
                        }}
                      >
                        <Copy size={14} /> Copy
                      </button>
                      <a
                        href={rawStreamUrl || streamUrl || ''}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          background: 'rgba(120, 119, 198, 0.2)',
                          border: 'none',
                          color: '#7877c6',
                          cursor: 'pointer',
                          padding: '8px',
                          borderRadius: '6px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          fontSize: '12px',
                          textDecoration: 'none'
                        }}
                      >
                        <ExternalLink size={14} /> Open
                      </a>
                    </div>
                  </div>

                  {/* VLC Help */}
                  <div style={{ 
                    background: 'rgba(251, 191, 36, 0.1)', 
                    border: '1px solid rgba(251, 191, 36, 0.3)',
                    borderRadius: '8px',
                    padding: '12px 16px',
                    marginTop: '12px'
                  }}>
                    <p style={{ color: '#fbbf24', fontSize: '13px', margin: '0 0 8px 0', fontWeight: '500' }}>
                      ⚠️ Stream not playing?
                    </p>
                    <p style={{ color: '#94a3b8', fontSize: '12px', margin: 0 }}>
                      Most IPTV streams are raw MPEG-TS. Copy the URL and paste into VLC (File → Open Network Stream).
                    </p>
                  </div>

                  {/* Debug Info */}
                  {streamDebug && (
                    <details style={{ marginTop: '12px' }}>
                      <summary style={{ color: '#64748b', fontSize: '12px', cursor: 'pointer' }}>Debug Info</summary>
                      <pre style={{ 
                        color: '#94a3b8', 
                        fontSize: '11px', 
                        background: 'rgba(0,0,0,0.3)',
                        padding: '12px',
                        borderRadius: '8px',
                        marginTop: '8px',
                        overflow: 'auto',
                        maxHeight: '200px'
                      }}>
                        {JSON.stringify(streamDebug, null, 2)}
                      </pre>
                    </details>
                  )}
                </>
              ) : null}
            </div>
          )}
        </div>
      )}

      {/* CSS for spin animation */}
      <style jsx global>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
