/**
 * GlobeTV Extractor — Live TV via iptv-org API
 *
 * GlobeTV (globetv.app) wraps the public iptv-org API for channel
 * metadata and stream URLs. All extraction goes through the CF Worker
 * which proxies iptv-org GitHub Pages API and adds CORS headers.
 */

import type { StreamSource } from '../providers/types';

interface GlobeTVChannel {
  id: string;
  name: string;
  country: string;
  categories: string[];
  website: string | null;
  network: string | null;
  logo?: string;
}

interface ExtractionResult {
  success: boolean;
  sources: StreamSource[];
  error?: string;
}

function getWorkerBaseUrl(): string {
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL ||
    process.env.CF_STREAM_PROXY_URL ||
    'https://media-proxy.vynx-3b3.workers.dev/stream';
  return cfProxyUrl.replace(/\/stream\/?$/, '');
}

export async function getGlobeTVChannels(
  country?: string,
  category?: string,
): Promise<GlobeTVChannel[]> {
  const baseUrl = getWorkerBaseUrl();
  const params = new URLSearchParams();
  if (country) params.set('country', country);
  if (category) params.set('category', category);

  const url = `${baseUrl}/globetv/channels?${params.toString()}`;
  console.log(`[GlobeTV] Fetching channels: ${url}`);

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    console.error(`[GlobeTV] Channels fetch failed: ${res.status}`);
    return [];
  }

  const data = await res.json();
  return data.channels || [];
}

export async function getGlobeTVStreamUrls(
  channelId: string,
): Promise<Array<{ url: string; quality: string; source: string }>> {
  const baseUrl = getWorkerBaseUrl();
  const url = `${baseUrl}/globetv/streams?channelId=${encodeURIComponent(channelId)}`;
  console.log(`[GlobeTV] Fetching streams for ${channelId}: ${url}`);

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    console.error(`[GlobeTV] Streams fetch failed: ${res.status}`);
    return [];
  }

  const data = await res.json();
  return data.streams || [];
}

export function globeTVChannelToStreamSource(
  channel: GlobeTVChannel,
  streamUrl?: string,
): StreamSource {
  const baseUrl = getWorkerBaseUrl();

  return {
    url: streamUrl
      ? `${baseUrl}/globetv/stream?url=${encodeURIComponent(streamUrl)}`
      : `${baseUrl}/globetv/stream?url=${encodeURIComponent(`https://iptv-org.github.io/api/streams/${channel.id}`)}`,
    quality: 'auto',
    type: 'hls',
    title: channel.name,
    server: channel.id,
    language: 'en',
    requiresSegmentProxy: true,
  };
}

export async function extractGlobeTVStream(
  channelId: string,
): Promise<ExtractionResult> {
  const streams = await getGlobeTVStreamUrls(channelId);

  if (streams.length === 0) {
    return { success: false, sources: [], error: `No streams found for channel ${channelId}` };
  }

  // Get the channel info for the title
  const channels = await getGlobeTVChannels();
  const channel = channels.find(c => c.id === channelId);

  const sources: StreamSource[] = streams.map(s =>
    globeTVChannelToStreamSource(
      { id: channelId, name: channel?.name || channelId, country: '', categories: [], website: null, network: null },
      s.url,
    )
  );

  return { success: true, sources };
}
