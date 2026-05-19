/**
 * Miruro Proxy — Anime Sub+Dub Stream Extraction
 *
 * Miruro (miruro.to) uses an encrypted API pipe for all requests:
 *   GET /api/secure/pipe?e={encrypted_envelope}
 *
 * The encryption is XOR + gzip with a known obfuscation key.
 * This worker handles the pipe encryption/decryption so the frontend
 * gets clean JSON responses.
 *
 * Routes:
 *   GET /miruro/episodes?anilistId=X    - Episode list with sub/dub arrays
 *   GET /miruro/sources?episodeId=X&provider=Y&category=sub|dub - Stream URLs
 *   GET /miruro/info?anilistId=X        - Anime metadata
 *   GET /miruro/search?q=X              - Search anime
 *   GET /miruro/browse?type=X&sort=Y... - Filtered browse
 *   GET /miruro/config                  - Site config
 *   GET /miruro/stream?url=X            - Proxy M3U8 stream (adds Referer)
 *   GET /miruro/segment?url=X           - Proxy TS segment
 *   GET /miruro/health                  - Health check
 */

import { createLogger, type LogLevel } from './logger';
import {
  corsHeaders,
  jsonResponse,
  buildStreamResponse,
  buildStreamResponseFromFetch,
} from './shared';

export interface Env {
  LOG_LEVEL?: string;
  RPI_PROXY_URL?: string;
  RPI_PROXY_KEY?: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const MIRURO_BASE = 'https://miruro.to';
const PIPE_OBF_KEY = '71951034f8fbcf53d89db52ceb3dc22c';
const MIRURO_REFERER = 'https://kwik.cx/';

// ============================================================================
// PIPE ENCRYPTION — XOR + gzip
// ============================================================================

/**
 * XOR a string with a repeating key, returning the XOR'd string.
 */
function xorString(input: string, key: string): string {
  let result = '';
  for (let i = 0; i < input.length; i++) {
    result += String.fromCharCode(input.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return result;
}

/**
 * Convert a string to a Uint8Array
 */
function stringToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/**
 * Convert a Uint8Array to a string
 */
function bytesToString(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return str;
}

/**
 * Base64url encode (URL-safe base64 without padding)
 */
function base64urlEncode(str: string): string {
  const base64 = btoa(str);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Base64url decode
 */
function base64urlDecode(str: string): string {
  // Restore padding
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return atob(base64);
}

/**
 * Gzip compress a Uint8Array using CompressionStream
 */
async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream();
  const compressed = stream.pipeThrough(new CompressionStream('gzip'));
  const blob = await new Response(compressed).blob();
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Gunzip decompress a Uint8Array using DecompressionStream
 */
async function gunzipDecompress(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream();
  const decompressed = stream.pipeThrough(new DecompressionStream('gzip'));
  const blob = await new Response(decompressed).blob();
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Encode a request envelope through the Miruro pipe:
 * JSON.stringify → base64url → XOR → gzip → base64url
 */
async function encodePipeEnvelope(envelope: Record<string, unknown>): Promise<string> {
  const json = JSON.stringify(envelope);
  const b64 = base64urlEncode(json);
  const xored = xorString(b64, PIPE_OBF_KEY);
  const bytes = stringToBytes(xored);
  const compressed = await gzipCompress(bytes);
  // Convert compressed bytes to base64url (via string conversion)
  const compressedStr = bytesToString(compressed);
  return base64urlEncode(compressedStr);
}

/**
 * Decode a Miruro pipe response:
 * base64url → gunzip → XOR → base64url → JSON.parse
 */
async function decodePipeResponse(data: string): Promise<any> {
  // Step 1: base64url decode the response
  const compressed = base64urlDecode(data);
  const compressedBytes = stringToBytes(compressed);

  // Step 2: gunzip
  const decompressedBytes = await gunzipDecompress(compressedBytes);
  const decompressedStr = bytesToString(decompressedBytes);

  // Step 3: XOR decrypt
  const unxored = xorString(decompressedStr, PIPE_OBF_KEY);

  // Step 4: base64url decode → JSON
  const json = base64urlDecode(unxored);
  return JSON.parse(json);
}

// ============================================================================
// MIRURO API CALLS
// ============================================================================

/**
 * Make an encrypted GET request to Miruro's API
 */
async function miruroGet(
  path: string,
  params: Record<string, string>,
  logger: ReturnType<typeof createLogger>,
): Promise<any> {
  const envelope = {
    path,
    method: 'GET',
    query: params,
    body: null,
    version: '0.2.0',
  };

  const encrypted = await encodePipeEnvelope(envelope);
  const apiUrl = `${MIRURO_BASE}/api/secure/pipe?e=${encodeURIComponent(encrypted)}`;

  logger.info(`Miruro API call: ${path}`, { params });

  const res = await fetch(apiUrl, {
    headers: {
      'User-Agent': UA,
      'Accept': '*/*',
      'Origin': MIRURO_BASE,
      'Referer': `${MIRURO_BASE}/`,
    },
  });

  if (!res.ok) {
    throw new Error(`Miruro ${path} returned ${res.status}`);
  }

  const responseText = await res.text();

  try {
    const data = await decodePipeResponse(responseText);
    return data;
  } catch (err) {
    logger.error(`Miruro ${path} decode failed`, err as Error);
    // Raw response might be helpful for debugging
    throw new Error(`Miruro pipe decode failed for ${path}: ${responseText.substring(0, 200)}`);
  }
}

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

/**
 * Main Miruro request handler — dispatches to sub-routes
 */
export async function handleMiruroRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/miruro\/?/, '');
  const logLevel = (env.LOG_LEVEL || 'info') as LogLevel;
  const logger = createLogger(request, logLevel);

  logger.info('Miruro proxy request', { path, search: url.search });

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  try {
    switch (true) {
      case path === 'health' || path === '':
        return handleHealth();
      case path === 'episodes':
        return await handleEpisodes(url.searchParams, logger);
      case path === 'sources':
        return await handleSources(url.searchParams, logger);
      case path === 'info':
        return await handleInfo(url.searchParams, logger);
      case path === 'search':
        return await handleSearch(url.searchParams, logger);
      case path === 'browse':
        return await handleBrowse(url.searchParams, logger);
      case path === 'config':
        return await handleConfig(logger);
      case path === 'stream':
        return await handleStreamProxy(url.searchParams, logger, request.url);
      case path === 'segment':
        return await handleSegmentProxy(url.searchParams, logger);
      default:
        return jsonResponse({ error: 'Unknown Miruro route', path }, 404);
    }
  } catch (error) {
    const err = error as Error;
    logger.error('Miruro proxy error', err);
    return jsonResponse({ error: 'Miruro proxy error', details: err.message }, 502);
  }
}

function handleHealth(): Response {
  return jsonResponse({ status: 'ok', provider: 'miruro', baseUrl: MIRURO_BASE });
}

/**
 * GET /miruro/episodes?anilistId=21
 * Returns episode list with sub and dub arrays per provider.
 */
async function handleEpisodes(
  params: URLSearchParams,
  logger: ReturnType<typeof createLogger>,
): Promise<Response> {
  const anilistId = params.get('anilistId');
  if (!anilistId) {
    return jsonResponse({ error: 'Missing required parameter: anilistId' }, 400);
  }

  const data = await miruroGet('episodes', { anilistId }, logger);
  return jsonResponse(data);
}

/**
 * GET /miruro/sources?episodeId=X&provider=kiwi&category=sub
 * Returns stream URLs for an episode from a specific provider.
 */
async function handleSources(
  params: URLSearchParams,
  logger: ReturnType<typeof createLogger>,
): Promise<Response> {
  const episodeId = params.get('episodeId');
  const provider = params.get('provider') || 'kiwi';
  const category = params.get('category') || 'sub';

  if (!episodeId) {
    return jsonResponse({ error: 'Missing required parameter: episodeId' }, 400);
  }

  const data = await miruroGet('sources', { episodeId, provider, category }, logger);
  return jsonResponse(data);
}

/**
 * GET /miruro/info?anilistId=21
 * Returns anime metadata from AniList.
 */
async function handleInfo(
  params: URLSearchParams,
  logger: ReturnType<typeof createLogger>,
): Promise<Response> {
  const anilistId = params.get('anilistId');
  if (!anilistId) {
    return jsonResponse({ error: 'Missing anilistId' }, 400);
  }

  const data = await miruroGet(`info/${anilistId}`, { live: '', _t: Date.now().toString() }, logger);
  return jsonResponse(data);
}

/**
 * GET /miruro/search?q=naruto
 */
async function handleSearch(
  params: URLSearchParams,
  logger: ReturnType<typeof createLogger>,
): Promise<Response> {
  const q = params.get('q');
  if (!q) {
    return jsonResponse({ error: 'Missing query' }, 400);
  }

  const data = await miruroGet('search', { query: q }, logger);
  return jsonResponse(data);
}

/**
 * GET /miruro/browse?type=ANIME&sort=TRENDING_DESC&page=1&perPage=20
 */
async function handleBrowse(
  params: URLSearchParams,
  logger: ReturnType<typeof createLogger>,
): Promise<Response> {
  const browseParams: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    if (value) browseParams[key] = value;
  }

  const data = await miruroGet('search/browse', browseParams, logger);
  return jsonResponse(data);
}

/**
 * GET /miruro/config
 * Returns the SSR config with provider info and ad configuration.
 */
async function handleConfig(
  logger: ReturnType<typeof createLogger>,
): Promise<Response> {
  const data = await miruroGet('config', {}, logger);
  return jsonResponse(data);
}

/**
 * GET /miruro/stream?url={encoded_m3u8_url}
 * Proxies HLS playlist with Referer header set to kwik.cx
 */
async function handleStreamProxy(
  params: URLSearchParams,
  logger: ReturnType<typeof createLogger>,
  requestUrl: string,
): Promise<Response> {
  const encodedUrl = params.get('url');
  if (!encodedUrl) {
    return jsonResponse({ error: 'Missing url parameter' }, 400);
  }

  const streamUrl = decodeURIComponent(encodedUrl);
  logger.info('Proxying Miruro stream', { url: streamUrl.substring(0, 120) });

  const res = await fetch(streamUrl, {
    headers: {
      'User-Agent': UA,
      'Referer': MIRURO_REFERER,
      'Origin': MIRURO_BASE,
      'Accept': '*/*',
    },
  });

  if (!res.ok) {
    return jsonResponse({ error: `Stream fetch failed: ${res.status}` }, 502);
  }

  const proxyOrigin = new URL(requestUrl).origin;
  return await buildStreamResponseFromFetch(res, streamUrl, proxyOrigin, '/miruro/segment', 'miruro');
}

/**
 * GET /miruro/segment?url={encoded_ts_url}
 * Proxies TS segments with Referer header.
 */
async function handleSegmentProxy(
  params: URLSearchParams,
  logger: ReturnType<typeof createLogger>,
): Promise<Response> {
  const encodedUrl = params.get('url');
  if (!encodedUrl) {
    return jsonResponse({ error: 'Missing url parameter' }, 400);
  }

  const segmentUrl = decodeURIComponent(encodedUrl);

  const res = await fetch(segmentUrl, {
    headers: {
      'User-Agent': UA,
      'Referer': MIRURO_REFERER,
      'Origin': MIRURO_BASE,
    },
  });

  if (!res.ok) {
    return jsonResponse({ error: `Segment fetch failed: ${res.status}` }, 502);
  }

  // Return binary segment directly
  const body = await res.arrayBuffer();
  const contentType = res.headers.get('content-type') || 'video/mp2t';

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': body.byteLength.toString(),
      'Cache-Control': 'public, max-age=3600',
      ...corsHeaders(),
    },
  });
}
