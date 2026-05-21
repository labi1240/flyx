/**
 * uFreeTV Provider Module
 *
 * uFreeTV (ufreetv.com) is a WordPress-based live TV site with
 * thousands of channels across 3 streaming systems.
 * Zero auth, zero rate limiting, zero anti-scraping.
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

export class UFreeTVProvider implements Provider {
  readonly name = 'ufreetv';
  readonly priority = 70;
  readonly enabled = true;

  supportsContent(_mediaType: MediaType, metadata?: { isAnime?: boolean; isLive?: boolean }): boolean {
    return metadata?.isLive === true;
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const start = Date.now();
    try {
      const { getUFreeTVChannels, uFreeTVChannelToStreamSource } = await import('../../services/ufreetv-extractor');

      const channels = await getUFreeTVChannels('all');
      const channel = channels.find(c => c.id === request.tmdbId || c.slug === request.tmdbId);

      if (!channel) {
        return {
          success: false,
          sources: [],
          subtitles: [],
          provider: this.name,
          error: `Channel not found: ${request.tmdbId}`,
          timing: Date.now() - start,
        };
      }

      const source = uFreeTVChannelToStreamSource(channel);
      return {
        success: true,
        sources: [source],
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
        error: err.message || 'uFreeTV extraction failed',
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
