/**
 * DLHD Stream Pipeline — May 2026
 *
 * Clean, centralized pipeline for DLHD stream extraction.
 * Replaces the scattered logic across routes.ts, fast-extractor.ts, dlhd-backend.ts.
 *
 * Pipeline:
 *   1. Server discovery (server_lookup API → static map fallback)
 *   2. Auth token generation (player page → EPlayerAuth or JWT)
 *   3. M3U8 fetch (race primary + fallback servers)
 *   4. M3U8 rewrite (browser-direct keys, proxied segments)
 *
 * Key fetching is handled browser-side — the browser's residential IP
 * gets real keys from DLHD's key servers (CORS *). See dlhd-config.ts.
 */

import {
  BACKEND_DOMAINS, ALL_SERVERS, ORIGIN_IP, ORIGIN_HOSTS,
  m3u8Url, serverLookupUrl, originM3U8Url, originServerLookupUrl,
  upstreamHeaders, originHeaders,
} from './dlhd-config';
import { fetchAuthData, DLHDAuthDataV5 } from './dlhd-auth-v5';

// =============================================================================
// Proxy-aware fetch
// =============================================================================

export interface ProxyConfig {
  url: string;   // RPI proxy base URL
  key: string;   // RPI proxy API key
}

let proxyConfig: ProxyConfig | null = null;

export function setPipelineProxyConfig(config: ProxyConfig | null): void {
  proxyConfig = config;
}

/**
 * Fetch a URL with multiple fallback strategies:
 *   1. Direct (Cloudflare-fronted HTTPS) — fast path
 *   2. Origin IP HTTP (bypasses Cloudflare WAF) — tries multiple vhosts
 *   3. RPI proxy — residential IP fallback
 */
async function proxyFetch(
  url: string,
  headers: Record<string, string>,
  timeout = 8000,
  originPath?: string,
): Promise<Response> {
  // Strategy 1: Direct HTTPS (works if CF edge IP not WAF-blocked)
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
    if (resp.ok) return resp;
    if (resp.status !== 403 && resp.status !== 503) return resp;
    console.log(`[DLHD] Direct blocked (${resp.status}), trying origin IP...`);
  } catch (e) {
    console.log(`[DLHD] Direct failed: ${e}, trying origin IP...`);
  }

  // Strategy 2: Origin IP HTTP (bypasses Cloudflare WAF entirely)
  if (originPath) {
    for (const vhost of ORIGIN_HOSTS) {
      try {
        const originUrl = `http://${ORIGIN_IP}${originPath}`;
        const resp = await fetch(originUrl, {
          headers: originHeaders(vhost),
          signal: AbortSignal.timeout(timeout),
        });
        if (resp.ok) {
          console.log(`[DLHD] Origin IP HIT: vhost=${vhost} path=${originPath}`);
          return resp;
        }
        console.log(`[DLHD] Origin IP ${vhost}: ${resp.status}`);
      } catch (e) {
        // try next vhost
      }
    }
  }

  // Strategy 3: RPI proxy
  if (proxyConfig?.url && proxyConfig?.key) {
    const proxyUrl = `${proxyConfig.url.replace(/\/+$/, '')}/proxy?url=${encodeURIComponent(url)}`;
    console.log(`[DLHD] Trying RPI proxy...`);
    try {
      const resp = await fetch(proxyUrl, {
        headers: { 'X-API-Key': proxyConfig.key },
        signal: AbortSignal.timeout(timeout + 5000),
      });
      return resp;
    } catch (e) {
      console.log(`[DLHD] RPI proxy failed: ${e}`);
    }
  }

  throw new Error(`All fetch strategies exhausted for ${url}`);
}

// =============================================================================
// Server lookup cache
// =============================================================================

const lookupCache = new Map<number, { server: string; expires: number }>();
const LOOKUP_TTL = 2 * 60 * 1000; // 2 min

/**
 * Look up which server hosts a channel via the server_lookup API.
 * Races all backend domains — first valid response wins.
 */
export async function discoverServer(channelId: number): Promise<string | null> {
  const cached = lookupCache.get(channelId);
  if (cached && cached.expires > Date.now()) return cached.server;

  const channelKey = `premium${channelId}`;

  try {
    const originPath = `/server_lookup?channel_id=${encodeURIComponent(channelKey)}`;
    const result = await Promise.any(
      BACKEND_DOMAINS.map(async (domain) => {
        const url = serverLookupUrl(domain, channelKey);
        const resp = await proxyFetch(url, upstreamHeaders(), 3000, originPath);
        if (!resp.ok) throw new Error(`${resp.status}`);
        const data = await resp.json() as { server_key?: string };
        if (!data.server_key) throw new Error('no server_key');
        return { server: data.server_key, domain };
      })
    );

    lookupCache.set(channelId, { server: result.server, expires: Date.now() + LOOKUP_TTL });
    console.log(`[DLHD] server_lookup: ch${channelId} → ${result.server} (via ${result.domain})`);
    return result.server;
  } catch {
    console.log(`[DLHD] server_lookup failed for ch${channelId}`);
    return null;
  }
}

// =============================================================================
// Auth token
// =============================================================================

/**
 * Generate an auth token for M3U8 access.
 * Fetches EPlayerAuth data from the player page, falls back to minimal JWT.
 */
export async function generateAuth(channelId: string): Promise<{
  token: string;
  channelKey: string;
  channelSalt?: string;
}> {
  const chNum = parseInt(channelId, 10);
  const channelKey = `premium${chNum}`;

  const authData = await fetchAuthData(channelId);
  if (authData?.authToken) {
    console.log(`[DLHD] auth: got EPlayerAuth token for ch${channelId}`);
    return {
      token: authData.authToken,
      channelKey: authData.channelKey || channelKey,
      channelSalt: authData.channelSalt,
    };
  }

  // Fallback: minimal token — works for M3U8 but not for server-side keys
  const ts = Math.floor(Date.now() / 1000);
  console.log(`[DLHD] auth: fallback token for ch${channelId}`);
  return {
    token: `${channelKey}|US|${ts}|${ts + 86400}|fallback`,
    channelKey,
  };
}

// =============================================================================
// M3U8 Fetch
// =============================================================================

interface M3U8Result {
  content: string;
  server: string;
  domain: string;
  url: string;
}

/**
 * Fetch M3U8 playlist for a channel.
 * Phase 1: Try primary server on primary domain (fast path).
 * Phase 2: Race all server×domain combos.
 */
export async function fetchM3U8(
  channelId: string,
  token: string,
  channelKey: string,
  primaryServer?: string | null,
): Promise<M3U8Result | null> {
  const headers = upstreamHeaders({ 'Authorization': `Bearer ${token}` });

  // Build candidate list: primary first, then all others
  const candidates: Array<{ server: string; domain: string }> = [];

  if (primaryServer) {
    candidates.push({ server: primaryServer, domain: BACKEND_DOMAINS[0] });
  }

  for (const server of ALL_SERVERS) {
    for (const domain of BACKEND_DOMAINS) {
      const key = `${server}.${domain}`;
      if (!candidates.some(c => `${c.server}.${c.domain}` === key)) {
        candidates.push({ server, domain });
      }
    }
  }

  if (candidates.length === 0) return null;

  // Phase 1: Try first candidate with tight timeout
  const primary = candidates[0];
  const primaryUrl = m3u8Url(primary.server, primary.domain, channelId);
  const primaryOriginPath = `/proxy/${primary.server}/premium${channelId}/mono.css`;
  try {
    const resp = await proxyFetch(primaryUrl, headers, 4000, primaryOriginPath);
    if (resp.ok) {
      const content = await resp.text();
      if (content.includes('#EXTM3U') || content.includes('#EXT-X-')) {
        console.log(`[DLHD] M3U8 Phase 1 HIT: ${primary.server}.${primary.domain}`);
        return { content, server: primary.server, domain: primary.domain, url: primaryUrl };
      }
    }
  } catch { /* fall through to Phase 2 */ }

  // Phase 2: Race all candidates
  console.log(`[DLHD] M3U8 Phase 2: racing ${candidates.length} candidates...`);
  return new Promise((resolve) => {
    let settled = false;
    let pending = candidates.length;

    for (const c of candidates) {
      const url = m3u8Url(c.server, c.domain, channelId);
      const originPath = `/proxy/${c.server}/premium${channelId}/mono.css`;
      proxyFetch(url, headers, 6000, originPath)
        .then(async (resp) => {
          if (settled) return;
          if (!resp.ok) { pending--; if (pending === 0) resolve(null); return; }
          const content = await resp.text();
          if (settled) return;
          if (content.includes('#EXTM3U') || content.includes('#EXT-X-')) {
            settled = true;
            console.log(`[DLHD] M3U8 Phase 2 winner: ${c.server}.${c.domain}`);
            resolve({ content, server: c.server, domain: c.domain, url });
          } else {
            pending--;
            if (pending === 0) resolve(null);
          }
        })
        .catch(() => {
          if (settled) return;
          pending--;
          if (pending === 0) resolve(null);
        });
    }
  });
}

// =============================================================================
// M3U8 Rewrite
// =============================================================================

/**
 * Rewrite M3U8 for browser playback.
 * - Key URIs → absolute URLs pointing directly at DLHD key servers (browser fetches)
 * - Segment URIs → proxied through /segment for CORS
 */
export function rewriteM3U8(
  content: string,
  m3u8BaseUrl: string,
  workerBaseUrl: string,
): string {
  const lines = content.split('\n');
  const out: string[] = [];
  const basePath = m3u8BaseUrl.substring(0, m3u8BaseUrl.lastIndexOf('/') + 1);

  let keyServerOrigin: string;
  try {
    keyServerOrigin = new URL(m3u8BaseUrl).origin;
  } catch {
    keyServerOrigin = `https://chevy.${BACKEND_DOMAINS[0]}`;
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // Key URIs: resolve to absolute on DLHD's key server (browser fetches directly)
    if (trimmed.startsWith('#EXT-X-KEY') && trimmed.includes('URI="')) {
      const uriMatch = trimmed.match(/URI="([^"]+)"/);
      if (uriMatch) {
        const uri = uriMatch[1];
        const absoluteKeyUrl = uri.startsWith('http')
          ? uri
          : uri.startsWith('/') ? `${keyServerOrigin}${uri}` : `${basePath}${uri}`;
        out.push(trimmed.replace(/URI="[^"]+"/, `URI="${absoluteKeyUrl}"`));
        continue;
      }
    }

    // Pass through empty lines and comments
    if (trimmed === '' || trimmed.startsWith('#')) {
      out.push(line);
      continue;
    }

    // Segment URLs: make absolute, proxy through /segment
    let segUrl = trimmed;
    if (!segUrl.startsWith('http')) {
      segUrl = basePath + segUrl;
    }
    out.push(`${workerBaseUrl}/segment?url=${encodeURIComponent(segUrl)}`);
  }

  return out.join('\n');
}

// =============================================================================
// Main pipeline entry point
// =============================================================================

export interface PipelineResult {
  m3u8: string;
  server: string;
  domain: string;
  m3u8Url: string;
}

/**
 * Full DLHD pipeline: server → auth → M3U8 → rewrite.
 * Returns a rewritten M3U8 ready for browser playback.
 */
export async function runPipeline(
  channelId: string,
  workerBaseUrl: string,
): Promise<PipelineResult | null> {
  const chNum = parseInt(channelId, 10);
  if (isNaN(chNum) || chNum < 1 || chNum > 1000) return null;

  // 1. Server discovery
  const server = await discoverServer(chNum);
  console.log(`[DLHD] pipeline ch${channelId}: server=${server || 'unknown'}`);

  // 2. Auth token
  const auth = await generateAuth(channelId);

  // 3. M3U8 fetch
  const m3u8 = await fetchM3U8(channelId, auth.token, auth.channelKey, server);
  if (!m3u8) {
    console.log(`[DLHD] pipeline ch${channelId}: M3U8 fetch failed`);
    return null;
  }

  // 4. Rewrite
  const rewritten = rewriteM3U8(m3u8.content, m3u8.url, workerBaseUrl);

  return {
    m3u8: rewritten,
    server: m3u8.server,
    domain: m3u8.domain,
    m3u8Url: m3u8.url,
  };
}
