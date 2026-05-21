/**
 * Provider Registry Index
 *
 * Instantiates all provider modules and registers them in a default ProviderRegistry.
 * Each provider import is wrapped in try/catch to prevent a single broken provider
 * from crashing the entire registry on CF Pages runtime.
 * Requirements: 2.4, 2.5
 */

import { ProviderRegistry } from './registry';

// Create the default registry
const registry = new ProviderRegistry();

// Helper to safely register a provider — logs errors instead of crashing
function safeRegister(name: string, factory: () => any) {
  try {
    const provider = factory();
    registry.register(provider);
  } catch (err) {
    console.error(`[ProviderRegistry] Failed to load ${name}:`, err instanceof Error ? err.message : err);
  }
}

// Register each provider with error isolation
try { const { FlixerProvider } = require('./flixer'); safeRegister('flixer', () => new FlixerProvider()); } catch (e: any) { console.error('[ProviderRegistry] flixer import failed:', e.message); }
try { const { VideasyProvider } = require('./videasy'); safeRegister('videasy', () => new VideasyProvider()); } catch (e: any) { console.error('[ProviderRegistry] videasy import failed:', e.message); }
try { const { UflixProvider } = require('./uflix'); safeRegister('uflix', () => new UflixProvider()); } catch (e: any) { console.error('[ProviderRegistry] uflix import failed:', e.message); }
try { const { AnimeKaiProvider } = require('./animekai'); safeRegister('animekai', () => new AnimeKaiProvider()); } catch (e: any) { console.error('[ProviderRegistry] animekai import failed:', e.message); }
try { const { HiAnimeProvider } = require('./hianime'); safeRegister('hianime', () => new HiAnimeProvider()); } catch (e: any) { console.error('[ProviderRegistry] hianime import failed:', e.message); }
try { const { MiruroProvider } = require('./miruro'); safeRegister('miruro', () => new MiruroProvider()); } catch (e: any) { console.error('[ProviderRegistry] miruro import failed:', e.message); }
try { const { VidSrcProvider } = require('./vidsrc'); safeRegister('vidsrc', () => new VidSrcProvider()); } catch (e: any) { console.error('[ProviderRegistry] vidsrc import failed:', e.message); }
try { const { PrimeSrcProvider } = require('./primesrc'); safeRegister('primesrc', () => new PrimeSrcProvider()); } catch (e: any) { console.error('[ProviderRegistry] primesrc import failed:', e.message); }
try { const { MultiEmbedProvider } = require('./multi-embed'); safeRegister('multi-embed', () => new MultiEmbedProvider()); } catch (e: any) { console.error('[ProviderRegistry] multi-embed import failed:', e.message); }
try { const { DLHDProvider } = require('./dlhd'); safeRegister('dlhd', () => new DLHDProvider()); } catch (e: any) { console.error('[ProviderRegistry] dlhd import failed:', e.message); }
try { const { VIPRowProvider } = require('./viprow'); safeRegister('viprow', () => new VIPRowProvider()); } catch (e: any) { console.error('[ProviderRegistry] viprow import failed:', e.message); }
try { const { PPVProvider } = require('./ppv'); safeRegister('ppv', () => new PPVProvider()); } catch (e: any) { console.error('[ProviderRegistry] ppv import failed:', e.message); }
try { const { CDNLiveProvider } = require('./cdn-live'); safeRegister('cdn-live', () => new CDNLiveProvider()); } catch (e: any) { console.error('[ProviderRegistry] cdn-live import failed:', e.message); }
try { const { IPTVProvider } = require('./iptv'); safeRegister('iptv', () => new IPTVProvider()); } catch (e: any) { console.error('[ProviderRegistry] iptv import failed:', e.message); }
try { const { NTVProvider } = require('./ntv'); safeRegister('ntv', () => new NTVProvider()); } catch (e: any) { console.error('[ProviderRegistry] ntv import failed:', e.message); }
try { const { MovieBoxProvider } = require('./moviebox'); safeRegister('moviebox', () => new MovieBoxProvider()); } catch (e: any) { console.error('[ProviderRegistry] moviebox import failed:', e.message); }
try { const { BingeBoxProvider } = require('./bingebox'); safeRegister('bingebox', () => new BingeBoxProvider()); } catch (e: any) { console.error('[ProviderRegistry] bingebox import failed:', e.message); }
try { const { UFreeTVProvider } = require('./ufreetv'); safeRegister('ufreetv', () => new UFreeTVProvider()); } catch (e: any) { console.error('[ProviderRegistry] ufreetv import failed:', e.message); }
try { const { GlobeTVProvider } = require('./globetv'); safeRegister('globetv', () => new GlobeTVProvider()); } catch (e: any) { console.error('[ProviderRegistry] globetv import failed:', e.message); }

console.log(`[ProviderRegistry] Loaded ${registry.getAllEnabled().length} providers: ${registry.getAllEnabled().map(p => p.name).join(', ')}`);

export { registry };
export { ProviderRegistry } from './registry';
export type {
  Provider,
  ProviderConfig,
  ExtractionRequest,
  ExtractionResult,
  StreamSource,
  SubtitleTrack,
  MediaType,
  ContentCategory,
} from './types';
