/**
 * GlobeTV Provider Module
 *
 * GlobeTV (globetv.app) is a live TV aggregator wrapping the
 * public iptv-org API for channel metadata and stream URLs.
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

const SUPPORTED_CONTENT: ContentCategory[] = ['live-tv'];

export class GlobeTVProvider implements Provider {
  readonly name = 'globetv';
  readonly priority = 71;
  readonly enabled = true;

  supportsContent(_mediaType: MediaType, metadata?: { isAnime?: boolean; isLive?: boolean }): boolean {
    return metadata?.isLive === true;
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const start = Date.now();
    try {
      const { extractGlobeTVStream } = await import('../../services/globetv-extractor');

      const result = await extractGlobeTVStream(request.tmdbId);

      if (!result.success || result.sources.length === 0) {
        return {
          success: false,
          sources: [],
          subtitles: [],
          provider: this.name,
          error: result.error || 'GlobeTV returned no sources',
          timing: Date.now() - start,
        };
      }

      return {
        success: true,
        sources: result.sources,
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
        error: err.message || 'GlobeTV extraction failed',
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
