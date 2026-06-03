/**
 * MovieBox Provider Module
 *
 * Movies/TV/Anime streaming provider.
 * Backend: h5-api.aoneroom.com — session-gated /subject/play endpoint.
 * All extraction goes through the CF Worker which handles session management.
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

const SUPPORTED_CONTENT: ContentCategory[] = ['movie', 'tv', 'anime'];

export class MovieBoxProvider implements Provider {
  readonly name = 'moviebox';
  readonly priority = 13; // Rate-limited upstream (h5-api.aoneroom.com 429)
  readonly enabled = true;

  supportsContent(_mediaType: MediaType, _metadata?: { isAnime?: boolean; isLive?: boolean }): boolean {
    return true; // MovieBox handles movies, TV, and anime
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const start = Date.now();

    try {
      const { extractMovieBoxStreams } = await import('../../services/moviebox-extractor');

      const result = await extractMovieBoxStreams(
        request.tmdbId,
        request.mediaType,
        request.season,
        request.episode,
        request.title,
      );

      if (!result.success || result.sources.length === 0) {
        return {
          success: false,
          sources: [],
          subtitles: [],
          provider: this.name,
          error: result.error || 'MovieBox returned no sources',
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
        error: err.message || 'MovieBox extraction failed',
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
