/**
 * StreamNinja Provider
 *
 * Browser-side extraction: loads streamninja.xyz's BHMWs0S_.js bundle
 * and calls j() directly from the user's browser to fetch + decrypt
 * stream data. No Playwright, no external service, no Browser Rendering.
 *
 * The CF Worker is not involved — the browser's native fetch + TLS
 * stack passes the StreamNinja API's fingerprinting checks.
 */

import type {
  Provider,
  ProviderConfig,
  ExtractionRequest,
  ExtractionResult,
  StreamSource,
  MediaType,
  ContentCategory,
} from '../types';

const SUPPORTED_CONTENT: ContentCategory[] = ['live-sports', 'live-tv'];

const BUNDLE_URL = 'https://streamninja.xyz/assets/BHMWs0S_.js';

const WORKERS = [
  'https://ninja-data.getsugatensho.workers.dev',
  'https://ninja-data.kuroigetsuga.workers.dev',
  'https://ninja-data.getsugachirashi.workers.dev',
];

let jFunction: ((url: string, provider: string, name: string) => Promise<any>) | null = null;
let initPromise: Promise<void> | null = null;

async function initBundle(): Promise<void> {
  if (jFunction) return;
  if (initPromise) return initPromise;

  // Only works in browser (needs eval, window, DOM)
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('StreamNinja provider requires a browser environment');
  }

  initPromise = (async () => {
    const resp = await fetch(BUNDLE_URL);
    let source = await resp.text();
    source = source.replace(
      /export\{hQ0VQk as j,jJfxvqG as m\};/,
      'window.__j=hQ0VQk;window.__m=jJfxvqG;'
    );
    (0, eval)(source);
    if (typeof (window as any).__j !== 'function') {
      throw new Error('Bundle init failed');
    }
    jFunction = (window as any).__j;
  })();

  return initPromise;
}

async function fanOut(path: string, provider: string, name: string): Promise<any> {
  await initBundle();
  const results = await Promise.allSettled(
    WORKERS.map(w => jFunction!(`${w}/${path}`, provider, name))
  );
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      return Array.isArray(r.value) ? r.value : r.value?.channels || r.value;
    }
  }
  return [];
}

export class StreamNinjaProvider implements Provider {
  readonly name = 'streamninja';
  readonly priority = 85;
  readonly enabled = true;

  supportsContent(_mediaType: MediaType, metadata?: { isAnime?: boolean; isLive?: boolean }): boolean {
    return metadata?.isLive === true;
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const start = Date.now();
    try {
      const [providerKey, streamId] = (request.tmdbId || '').split(':');
      const provider = providerKey || 'admin';
      const name = provider.toUpperCase();

      let data: any;
      if (streamId) {
        const path = `${provider}?id=${encodeURIComponent(streamId)}`;
        data = await fanOut(path, provider, name);
        if (!data || data.error) {
          return { success: false, sources: [], subtitles: [], provider: this.name, error: 'Stream not found', timing: Date.now() - start };
        }
        const streams: any[] = data.streams || [];
        return {
          success: true,
          sources: streams.map((s: any) => ({
            url: s.stream_url || s.embed_url || '',
            quality: s.source_name || 'Unknown',
            type: (s.stream_url || '').includes('.m3u8') ? 'hls' : 'mp4',
            title: s.source_name,
            server: 'streamninja',
            requiresSegmentProxy: false,
            referer: 'https://sportsembed.su.getsugatensho.sbs/',
          })),
          subtitles: [],
          provider: this.name,
          timing: Date.now() - start,
        };
      } else {
        data = await fanOut(provider, provider, name);
        const events = Array.isArray(data) ? data : [];
        return {
          success: true,
          sources: events.map((e: any) => ({
            url: `streamninja://${provider}/${e.stream_id}`,
            quality: e.event_name || e.stream_id,
            type: 'hls',
            title: `${e.event_name || e.stream_id} | ${e.league || ''} | ${e.time_et || ''}`,
            server: 'streamninja',
            requiresSegmentProxy: false,
          })),
          subtitles: [],
          provider: this.name,
          timing: Date.now() - start,
        };
      }
    } catch (err: any) {
      return { success: false, sources: [], subtitles: [], provider: this.name, error: err.message, timing: Date.now() - start };
    }
  }

  async fetchSourceByName(_sourceName: string, _request: ExtractionRequest): Promise<StreamSource | null> {
    return null;
  }

  getConfig(): ProviderConfig {
    return { name: this.name, priority: this.priority, enabled: this.enabled, supportedContent: SUPPORTED_CONTENT };
  }
}
