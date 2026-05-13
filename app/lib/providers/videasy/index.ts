/**
 * Videasy Provider Module
 *
 * Wraps the Videasy source extraction pipeline behind the unified Provider interface.
 * Primary streaming provider — zero-auth, direct HLS, 4K support.
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

// Avoid referencing process.env at import time on CF Pages
const VIDEASY_ENABLED = true;

const SUPPORTED_CONTENT: ContentCategory[] = ['movie', 'tv'];

export class VideasyProvider implements Provider {
  readonly name = 'videasy';
  readonly priority = 1; // Primary provider — zero-auth, no captcha needed
  readonly enabled = VIDEASY_ENABLED;

  supportsContent(mediaType: MediaType, _metadata?: { isAnime?: boolean; isLive?: boolean }): boolean {
    if (mediaType === 'movie') return SUPPORTED_CONTENT.includes('movie');
    if (mediaType === 'tv') return SUPPORTED_CONTENT.includes('tv');
    return false;
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const start = Date.now();
    try {
      // Dynamic import to avoid bundling server-side deps on client
      const { extractVideasyClient } = await import('../../services/videasy-client-extractor');

      const sources = await extractVideasyClient(
        request.tmdbId,
        request.mediaType,
        request.title || '',
        request.season,
        request.episode,
      );

      return {
        success: sources.length > 0,
        sources: sources.map(s => this.normalizeSource(s)),
        subtitles: [],
        provider: this.name,
        error: sources.length === 0 ? 'No sources found' : undefined,
        timing: Date.now() - start,
      };
    } catch (err: any) {
      return {
        success: false,
        sources: [],
        subtitles: [],
        provider: this.name,
        error: err.message || 'Videasy extraction failed',
        timing: Date.now() - start,
      };
    }
  }

  async fetchSourceByName(sourceName: string, request: ExtractionRequest): Promise<StreamSource | null> {
    // Videasy doesn't have named servers — re-extract all sources and find match
    try {
      const result = await this.extract(request);
      if (!result.success) return null;
      const match = result.sources.find(s =>
        s.title?.toLowerCase().includes(sourceName.toLowerCase())
      );
      return match || null;
    } catch {
      return null;
    }
  }

  getConfig(): ProviderConfig {
    return {
      name: this.name,
      priority: this.priority,
      enabled: this.enabled,
      supportedContent: [...SUPPORTED_CONTENT],
    };
  }

  private normalizeSource(s: any): StreamSource {
    return {
      url: s.url,
      quality: s.quality || 'auto',
      type: s.type || 'hls',
      title: s.title,
      language: s.language,
      server: s.server,
      referer: s.referer,
      requiresSegmentProxy: s.requiresSegmentProxy ?? false,
      ...(s.status && { status: s.status }),
    };
  }
}
