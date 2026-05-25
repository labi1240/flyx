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

      // Use malId if available, otherwise try title-based search
      // malId is used as AniList ID (they're often aligned via MAL→AniList mapping)
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

      // Try dub first, then sub — merge both for maximum coverage
      const title = request.malTitle || request.title || '';
      let allSources: import('../types').StreamSource[] = [];
      let allSubtitles: import('../types').SubtitleTrack[] = [];
      let errors: string[] = [];

      for (const language of ['dub', 'sub'] as const) {
        try {
          const result = await extractMiruroStreams(
            anilistId,
            title,
            request.episode,
            language,
          );
          if (result.success && result.sources.length > 0) {
            // Tag sources with language
            allSources.push(...result.sources.map(s => ({
              ...s,
              language: s.language || language,
              title: `${s.title || 'Miruro'} [${language.toUpperCase()}]`,
            })));
            if (result.subtitles) allSubtitles.push(...result.subtitles);
          } else if (result.error) {
            errors.push(`${language}: ${result.error}`);
          }
        } catch (err: any) {
          errors.push(`${language}: ${err.message}`);
        }
      }

      if (allSources.length === 0) {
        return {
          success: false,
          sources: [],
          subtitles: [],
          provider: this.name,
          error: errors.join('; ') || 'Miruro returned no sources',
          timing: Date.now() - start,
        };
      }

      return {
        success: true,
        sources: allSources,
        subtitles: allSubtitles,
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
