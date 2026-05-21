/**
 * uFreeTV Extractor — Live TV Stream Extraction
 *
 * Calls the CF Worker's /ufreetv endpoints for channel listings
 * and stream proxying.
 */

import type { StreamSource } from '../providers/types';

export interface UFreeTVChannel {
  id: string;
  name: string;
  slug: string;
  url: string;
  category: string;
  source: 'wordpress' | 'all_channels_json';
}

function getWorkerBaseUrl(): string {
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL ||
    process.env.CF_STREAM_PROXY_URL ||
    'https://media-proxy.vynx-3b3.workers.dev/stream';
  return cfProxyUrl.replace(/\/stream\/?$/, '');
}

export async function getUFreeTVChannels(source?: string): Promise<UFreeTVChannel[]> {
  const baseUrl = getWorkerBaseUrl();
  const params = source ? `?source=${encodeURIComponent(source)}` : '';
  const url = `${baseUrl}/ufreetv/channels${params}`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) throw new Error(`uFreeTV channels fetch failed: ${res.status}`);

  const data = await res.json();
  return data.channels || [];
}

export function uFreeTVChannelToStreamSource(channel: UFreeTVChannel): StreamSource {
  return {
    url: `${getWorkerBaseUrl()}/ufreetv/stream?url=${encodeURIComponent(channel.url)}`,
    quality: 'auto',
    type: 'hls',
    title: `uFreeTV - ${channel.name}`,
    server: channel.source,
    language: 'en',
    requiresSegmentProxy: true,
  };
}
