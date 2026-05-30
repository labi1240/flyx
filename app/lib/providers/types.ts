/**
 * Shared Provider Types and Interfaces
 * 
 * Defines the unified contract that all streaming providers must implement.
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
 */

export type MediaType = 'movie' | 'tv';

export type ContentCategory =
  | 'movie'
  | 'tv'
  | 'anime'
  | 'live-tv'
  | 'live-sports'
  | 'ppv'
  | 'iptv';

export interface ExtractionRequest {
  tmdbId: string;
  mediaType: MediaType;
  season?: number;
  episode?: number;
  malId?: number;
  title?: string;
  malTitle?: string;
  /** Cap.js PoW token solved by the browser — forwarded to CF Worker for hexa.su */
  capToken?: string;
}

export interface StreamSource {
  url: string;
  quality: string;
  type: 'hls' | 'mp4';
  title?: string;
  language?: string;
  server?: string;
  referer?: string;
  requiresSegmentProxy: boolean;
  skipOrigin?: boolean;
  status?: 'working' | 'down' | 'unknown';
  skipIntro?: [number, number];
  skipOutro?: [number, number];
}

export interface SubtitleTrack {
  label: string;
  url: string;
  language: string;
}

export interface ExtractionResult {
  success: boolean;
  sources: StreamSource[];
  subtitles: SubtitleTrack[];
  provider: string;
  error?: string;
  timing?: number;
  /** Raw hex from CF proxy — set when server can't decrypt (CF Pages) */
  hexData?: string;
  /** True when the client (browser) must run WASM+AES decryption */
  needsClientDecrypt?: boolean;
}

export interface ProviderConfig {
  name: string;
  priority: number;
  enabled: boolean;
  supportedContent: ContentCategory[];
}

export interface Provider {
  readonly name: string;
  readonly priority: number;
  readonly enabled: boolean;

  supportsContent(mediaType: MediaType, metadata?: { isAnime?: boolean; isLive?: boolean }): boolean;
  extract(request: ExtractionRequest): Promise<ExtractionResult>;
  fetchSourceByName(sourceName: string, request: ExtractionRequest): Promise<StreamSource | null>;
  getConfig(): ProviderConfig;
}
