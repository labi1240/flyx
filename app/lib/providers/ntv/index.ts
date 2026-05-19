/**
 * NTV Provider Module
 *
 * NTV (ntv.cx) is a live TV & sports aggregator sourcing from:
 *   embedsports.top (Kobra), dlhd.pk (Phoenix), cdnlivetv.tv (Titan), hesgoales.com (Falcon)
 *
 * 2052 channels across 3 active upstream servers, 7 match categories.
 * No Cloudflare, no CAPTCHA, no rate limiting.
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

const SUPPORTED_CONTENT: ContentCategory[] = ['live-tv', 'live-sports'];

function getWorkerBaseUrl(): string {
  if (typeof process !== 'undefined' && process.env) {
    const url = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL ||
      (process.env as any).CF_STREAM_PROXY_URL ||
      'https://media-proxy.vynx-3b3.workers.dev/stream';
    return url.replace(/\/stream\/?$/, '');
  }
  return 'https://media-proxy.vynx-3b3.workers.dev';
}

export class NTVProvider implements Provider {
  readonly name = 'ntv';
  readonly priority = 90; // After DLHD (100), before other live sources
  readonly enabled = true;

  supportsContent(_mediaType: MediaType, metadata?: { isAnime?: boolean; isLive?: boolean }): boolean {
    return metadata?.isLive === true;
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const start = Date.now();
    try {
      // For NTV, tmdbId serves as a channel/match token reference
      // Format: "ntv:{server}:{matchOrChannelId}" or just a channel number
      const token = request.tmdbId;
      const baseUrl = getWorkerBaseUrl();

      // Try resolving as an embed token first
      const resolveUrl = `${baseUrl}/ntv/stream?t=${encodeURIComponent(token)}`;
      const res = await fetch(resolveUrl, {
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        return {
          success: false,
          sources: [],
          subtitles: [],
          provider: this.name,
          error: `NTV stream resolution failed: ${res.status}`,
          timing: Date.now() - start,
        };
      }

      const data = await res.json();
      if (data.error || !data.streamUrl) {
        return {
          success: false,
          sources: [],
          subtitles: [],
          provider: this.name,
          error: data.error || 'No stream URL resolved',
          timing: Date.now() - start,
        };
      }

      return {
        success: true,
        sources: [{
          url: data.streamUrl,
          quality: 'auto',
          type: 'hls',
          title: `NTV (${data.upstream || 'unknown'})`,
          server: data.upstream,
          requiresSegmentProxy: true,
        }],
        subtitles: [],
        provider: this.name,
        timing: Date.now() - start,
      };
    } catch (err: any) {
      return {
        success: false,
        sources: [],
        subtitles: [],
        provider: this.name,
        error: err.message || 'NTV extraction failed',
        timing: Date.now() - start,
      };
    }
  }

  async fetchSourceByName(_sourceName: string, request: ExtractionRequest): Promise<StreamSource | null> {
    const result = await this.extract(request);
    return result.sources[0] || null;
  }

  getConfig(): ProviderConfig {
    return {
      name: this.name,
      priority: this.priority,
      enabled: this.enabled,
      supportedContent: [...SUPPORTED_CONTENT],
    };
  }
}
