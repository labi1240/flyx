/**
 * NTV Extractor — Live TV & Sports Stream Extraction
 *
 * Calls the CF Worker's /ntv endpoints for channel listings,
 * match data, and stream resolution.
 */

import type { StreamSource } from '../providers/types';

interface NTVChannel {
  channel_id: string;
  channel_name: string;
  channel_code: string;
  channel_url: string;
  channel_image: string;
  viewers: number;
  server: 'cdnlive' | 'dlhd' | 'hesgoales';
  has_icon: boolean;
}

interface NTVMatch {
  id: string;
  title: string;
  category: string;
  date: number;
  poster: string;
  popular: boolean;
  teams: {
    home: { name: string; badge: string };
    away: { name: string; badge: string };
  };
  sources: Array<{ source: string; id: string; channelName?: string; channelId?: number; channelCode?: string }>;
  live: boolean;
}

interface NTVMatchesResponse {
  success: boolean;
  live: NTVMatch[];
  upcoming?: NTVMatch[];
  finished?: NTVMatch[];
}

interface NTVStreamResponse {
  streamUrl?: string;
  upstream?: string;
  embedPageUrl?: string;
  error?: string;
}

interface NTVEmbedResponse {
  embedUrl: string;
  iframeUrl: string | null;
  htmlLength: number;
}

function getWorkerBaseUrl(): string {
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL ||
    process.env.CF_STREAM_PROXY_URL ||
    'https://media-proxy.vynx-3b3.workers.dev/stream';
  return cfProxyUrl.replace(/\/stream\/?$/, '');
}

/**
 * Fetch all 2052 NTV channels from the CF Worker
 */
export async function getNTVChannels(): Promise<NTVChannel[]> {
  const baseUrl = getWorkerBaseUrl();
  const url = `${baseUrl}/ntv/channels`;

  console.log('[NTV] Fetching channels...');
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`NTV channels fetch failed: ${res.status}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(data.error);
  }

  // Response may be wrapped or direct array
  const channels = Array.isArray(data) ? data : data.channels || data.data || [];
  console.log(`[NTV] Got ${channels.length} channels`);
  return channels;
}

/**
 * Fetch sports matches from a specific server
 */
export async function getNTVMatches(server: string = 'kobra'): Promise<NTVMatchesResponse> {
  const baseUrl = getWorkerBaseUrl();
  const url = `${baseUrl}/ntv/matches?server=${encodeURIComponent(server)}&type=both`;

  console.log(`[NTV] Fetching matches for server=${server}...`);
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`NTV matches fetch failed: ${res.status}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(data.error);
  }

  return data as NTVMatchesResponse;
}

/**
 * Resolve an NTV embed token to the upstream stream URL
 */
export async function resolveNTVStream(token: string): Promise<NTVStreamResponse> {
  const baseUrl = getWorkerBaseUrl();
  const url = `${baseUrl}/ntv/stream?t=${encodeURIComponent(token)}`;

  console.log('[NTV] Resolving stream token...');
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`NTV stream resolution failed: ${res.status}`);
  }

  return await res.json();
}

/**
 * Fetch the NTV embed page and extract the iframe URL
 */
export async function getNTVEmbed(token: string): Promise<NTVEmbedResponse> {
  const baseUrl = getWorkerBaseUrl();
  const url = `${baseUrl}/ntv/embed?t=${encodeURIComponent(token)}`;

  console.log('[NTV] Fetching embed page...');
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`NTV embed fetch failed: ${res.status}`);
  }

  return await res.json();
}

/**
 * Search NTV matches
 */
export async function searchNTVMatches(query: string, server: string = 'kobra'): Promise<NTVMatchesResponse> {
  const baseUrl = getWorkerBaseUrl();
  const url = `${baseUrl}/ntv/search?q=${encodeURIComponent(query)}&server=${encodeURIComponent(server)}`;

  console.log(`[NTV] Searching: "${query}"`);
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`NTV search failed: ${res.status}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(data.error);
  }

  return data as NTVMatchesResponse;
}

/**
 * Convert NTV match sources to StreamSource objects for the player
 */
export function matchToStreamSources(match: NTVMatch): StreamSource[] {
  return match.sources.map(source => ({
    url: '', // Will be resolved lazily via the embed token
    quality: source.source.toUpperCase(),
    type: 'hls' as const,
    title: `${match.title} [${source.source.toUpperCase()}]`,
    server: source.source,
    language: 'en',
    requiresSegmentProxy: true,
  }));
}
