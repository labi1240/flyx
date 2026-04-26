/**
 * PrimeSrc Provider Module
 *
 * Wraps the primesrc-extractor service behind the unified Provider interface.
 * Extracts PrimeVid streams via cloudnestra chain (bypasses Turnstile).
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
  extractPrimeSrcStreams,
  fetchPrimeSrcSourceByName,
  PRIMESRC_ENABLED,
} from '../../services/primesrc-extractor';

const SUPPORTED_CONTENT: ContentCategory[] = ['movie', 'tv'];

export class PrimeSrcProvider implements Provider {
  readonly name = 'primesrc';
  readonly priority = 5; // Primary provider — no RPI needed, pure CF Worker
  readonly enabled = PRIMESRC_ENABLED;

  supportsContent(mediaType: MediaType, _metadata?: { isAnime?: boolean; isLive?: boolean }): boolean {
    if (mediaType === 'movie') return SUPPORTED_CONTENT.includes('movie');
    if (mediaType === 'tv') return SUPPORTED_CONTENT.includes('tv');
    return false;
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const start = Date.now();
    try {
      const result = await extractPrimeSrcStreams(
        request.tmdbId,
        request.mediaType,
        request.season,
        request.episode,
      );
      return {
        success: result.success,
        sources: (result.sources || []).map(s => this.normalizeSource(s)),
        subtitles: result.subtitles || [],
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
        error: err.message || 'PrimeSrc extraction failed',
        timing: Date.now() - start,
      };
    }
  }

  async fetchSourceByName(sourceName: string, request: ExtractionRequest): Promise<StreamSource | null> {
    try {
      const source = await fetchPrimeSrcSourceByName(
        sourceName,
        request.tmdbId,
        request.mediaType,
        request.season,
        request.episode,
      );
      return source ? this.normalizeSource(source) : null;
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
