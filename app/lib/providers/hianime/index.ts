/**
 * HiAnime Provider Module
 *
 * Wraps the existing hianime-extractor.ts logic behind the unified Provider interface.
 * HiAnime is a thin client — all extraction happens on the Cloudflare Worker.
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
import { extractHiAnimeStreams } from '../../services/hianime-extractor';

const SUPPORTED_CONTENT: ContentCategory[] = ['anime'];

export class HiAnimeProvider implements Provider {
  readonly name = 'hianime';
  readonly priority = 35;
  readonly enabled = false; // HiAnime shut down March 2026

  supportsContent(_mediaType: MediaType, metadata?: { isAnime?: boolean; isLive?: boolean }): boolean {
    if (metadata?.isAnime) return true;
    return false;
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const start = Date.now();
    try {
      // HiAnime requires malId and title
      if (!request.malId || !request.title) {
        return {
          success: false,
          sources: [],
          subtitles: [],
          provider: this.name,
          error: 'HiAnime requires malId and title',
          timing: Date.now() - start,
        };
      }

      const result = await extractHiAnimeStreams(
        request.malId,
        request.title,
        request.episode,
      );
      return {
        success: result.success,
        sources: (result.sources || []).map(s => this.normalizeSource(s)),
        subtitles: (result.subtitles || []).map(sub => ({
          label: sub.label,
          url: sub.url,
          language: sub.language,
        })),
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
        error: err.message || 'HiAnime extraction failed',
        timing: Date.now() - start,
      };
    }
  }

  async fetchSourceByName(_sourceName: string, request: ExtractionRequest): Promise<StreamSource | null> {
    // HiAnime doesn't support fetching by name — re-extract and return first
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
      referer: s.referer || '',
      requiresSegmentProxy: s.requiresSegmentProxy ?? true,
      skipOrigin: s.skipOrigin,
      ...(s.status && { status: s.status }),
      ...(s.skipIntro && { skipIntro: s.skipIntro }),
      ...(s.skipOutro && { skipOutro: s.skipOutro }),
    };
  }
}
