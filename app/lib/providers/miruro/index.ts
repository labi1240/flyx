/**
 * Miruro Provider Module
 *
 * Anime streaming provider with sub+dub support.
 * Miruro uses an encrypted API pipe (XOR+gzip) which the CF Worker handles.
 * This provider delegates to the worker for all extraction.
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

const SUPPORTED_CONTENT: ContentCategory[] = ['anime'];

export class MiruroProvider implements Provider {
  readonly name = 'miruro';
  readonly priority = 15; // After AnimeKai (10) and HiAnime (12)
  readonly enabled = true;

  supportsContent(_mediaType: MediaType, metadata?: { isAnime?: boolean; isLive?: boolean }): boolean {
    return metadata?.isAnime === true;
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const start = Date.now();

    try {
      // Dynamically import to avoid module-load issues on CF Pages
      const { extractMiruroStreams } = await import('../../services/miruro-extractor');

      if (!request.malId && !request.title) {
        return {
          success: false,
          sources: [],
          subtitles: [],
          provider: this.name,
          error: 'Miruro requires malId or title',
          timing: Date.now() - start,
        };
      }

      // Determine best language: default to sub, use malTitle hints for dub preference
      const language: 'sub' | 'dub' = 'sub';

      // Use malId if available, otherwise try title-based search
      // For now, malId is used as AniList ID (they're often aligned via MAL→AniList mapping)
      const anilistId = request.malId;
      if (!anilistId) {
        return {
          success: false,
          sources: [],
          subtitles: [],
          provider: this.name,
          error: 'Miruro requires an AniList ID (passed as malId)',
          timing: Date.now() - start,
        };
      }

      const result = await extractMiruroStreams(
        anilistId,
        request.malTitle || request.title || '',
        request.episode,
        language,
      );

      if (!result.success || result.sources.length === 0) {
        return {
          success: false,
          sources: [],
          subtitles: [],
          provider: this.name,
          error: result.error || 'Miruro returned no sources',
          timing: Date.now() - start,
        };
      }

      return {
        success: true,
        sources: result.sources,
        subtitles: result.subtitles || [],
        provider: this.name,
        timing: Date.now() - start,
      };
    } catch (err: any) {
      return {
        success: false,
        sources: [],
        subtitles: [],
        provider: this.name,
        error: err.message || 'Miruro extraction failed',
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
