/**
 * VidSrc Provider Module
 *
 * Wraps the existing vidsrc-extractor.ts logic behind the unified Provider interface.
 * Requirements: 1.1, 1.6, 1.7, 2.1
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
import {
  extractVidSrcStreams,
  VIDSRC_ENABLED,
} from '../../services/vidsrc-extractor';

const SUPPORTED_CONTENT: ContentCategory[] = ['movie', 'tv'];

export class VidSrcProvider implements Provider {
  readonly name = 'vidsrc';
  readonly priority = 45; // Upstream API dead (v1.2embed.stream)
  readonly enabled = VIDSRC_ENABLED;

  supportsContent(mediaType: MediaType, _metadata?: { isAnime?: boolean; isLive?: boolean }): boolean {
    if (mediaType === 'movie') return SUPPORTED_CONTENT.includes('movie');
    if (mediaType === 'tv') return SUPPORTED_CONTENT.includes('tv');
    return false;
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const start = Date.now();
    try {
      const result = await extractVidSrcStreams(
        request.tmdbId,
        request.mediaType,
        request.season,
        request.episode,
      );
      return {
        success: result.success,
        sources: (result.sources || []).map(s => this.normalizeSource(s)),
        subtitles: [],
        provider: this.name,
        error: result.error,
        timing: Date.now() - start,
      };
    } catch (err: any) {
      return {
        success: false,
        sources: [],
        subtitles: [],
        provider: this.name,
        error: err.message || 'VidSrc extraction failed',
        timing: Date.now() - start,
      };
    }
  }

  async fetchSourceByName(_sourceName: string, request: ExtractionRequest): Promise<StreamSource | null> {
    // VidSrc doesn't support fetching by name — re-extract and return first
    try {
      const result = await this.extract(request);
      return result.sources[0] || null;
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
      requiresSegmentProxy: s.requiresSegmentProxy ?? true,
      skipOrigin: s.skipOrigin,
      ...(s.status && { status: s.status }),
    };
  }
}
