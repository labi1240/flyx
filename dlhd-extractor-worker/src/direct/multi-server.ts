/**
 * DLHD Multi-Server Discovery Module
 *
 * Discovers ALL working servers for a channel — not just the primary
 * returned by server_lookup. DLHD mirrors channels across 2-4 servers
 * simultaneously for redundancy. This module finds every one of them.
 *
 * Bypasses:
 *   1. Direct M3U8 probe — no auth needed (just Referer/Origin)
 *   2. Server enumeration — probe all 7 servers × 3 domains in parallel
 *   3. Race-mode — fastest response wins, remainder collected for map
 *   4. Dynamic discovery — uncached channels probed on-demand
 *
 * The server_lookup API only returns ONE server per channel.
 * But probing reveals channels are typically on 2-4 servers at once.
 */

import { lookupServer } from './fast-extractor';
import { ALL_SERVERS, BACKEND_DOMAINS, upstreamHeaders } from './dlhd-config';

const ALL_DOMAINS = BACKEND_DOMAINS;

export interface ServerProbeResult {
  server: string;
  domain: string;
  working: boolean;
  status: number;
  elapsed: number;
  bodyLen: number;
  error?: string;
}

export interface MultiServerResult {
  channelId: string;
  channelKey: string;
  primaryServer: string | null;    // From server_lookup API
  allWorkingServers: string[];     // All servers with valid M3U8
  allWorkingDomains: string[];     // All domains with valid M3U8
  probes: ServerProbeResult[];     // Full probe results
  totalProbed: number;
  totalWorking: number;
  elapsed: number;
}

// In-memory multi-server cache (5 min TTL — M3U8s are live, servers rotate)
const multiServerCache = new Map<string, { data: MultiServerResult; expires: number }>();
const MULTI_CACHE_TTL = 5 * 60 * 1000;

/**
 * Build M3U8 URL for server×domain probe.
 */
function buildProbeUrl(channelId: string, server: string, domain: string): string {
  return `https://chevy.${domain}/proxy/${server}/premium${channelId}/mono.css`;
}

/**
 * Probe a single server×domain. No auth needed — just Referer/Origin headers.
 */
async function probeOne(
  channelId: string,
  server: string,
  domain: string,
  signal?: AbortSignal,
): Promise<ServerProbeResult> {
  const url = buildProbeUrl(channelId, server, domain);
  const start = Date.now();

  try {
    const resp = await fetch(url, { headers: upstreamHeaders(), signal });

    const text = await resp.text();
    const elapsed = Date.now() - start;
    const valid = text.includes('#EXTM3U') || text.includes('#EXT-X-');

    return {
      server,
      domain,
      working: valid,
      status: resp.status,
      elapsed,
      bodyLen: text.length,
    };
  } catch (e) {
    return {
      server,
      domain,
      working: false,
      status: 0,
      elapsed: Date.now() - start,
      bodyLen: 0,
      error: (e as Error).message,
    };
  }
}

/**
 * Discover ALL working servers for a channel.
 *
 * Phase 1: Race all 21 combos — first valid M3U8 wins (fast path).
 * Phase 2: Collect remaining probe results to build complete map.
 *
 * @param channelId - Numeric channel ID (e.g., "51")
 * @param timeout - Per-channel timeout in ms (default 8000)
 */
export async function discoverAllServers(
  channelId: string,
  timeout = 8000,
): Promise<MultiServerResult> {
  const cacheKey = `ch${channelId}`;
  const cached = multiServerCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.data;
  }

  const startTime = Date.now();
  const chNum = parseInt(channelId, 10);

  // Phase 1: Get primary from server_lookup (runs in parallel with probes)
  const lookupPromise = lookupServer(chNum).catch(() => null);

  // Phase 2: Probe ALL server×domain combos
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  const probePromises: Promise<ServerProbeResult>[] = [];
  for (const server of ALL_SERVERS) {
    for (const domain of ALL_DOMAINS) {
      probePromises.push(probeOne(channelId, server, domain, controller.signal));
    }
  }

  const [primaryServer, probes] = await Promise.all([
    lookupPromise,
    Promise.all(probePromises),
  ]);
  clearTimeout(timeoutId);

  const workingProbes = probes.filter(p => p.working);
  const allWorkingServers = [...new Set(workingProbes.map(p => p.server))];
  const allWorkingDomains = [...new Set(workingProbes.map(p => p.domain))];

  const result: MultiServerResult = {
    channelId,
    channelKey: `premium${channelId}`,
    primaryServer,
    allWorkingServers,
    allWorkingDomains,
    probes,
    totalProbed: probes.length,
    totalWorking: workingProbes.length,
    elapsed: Date.now() - startTime,
  };

  // Cache the result
  multiServerCache.set(cacheKey, { data: result, expires: Date.now() + MULTI_CACHE_TTL });

  return result;
}

/**
 * Fast check: does the channel work on ANY server? Returns first working one.
 * Much faster than discoverAllServers — returns as soon as any probe succeeds.
 */
export async function findAnyWorkingServer(
  channelId: string,
  timeout = 5000,
): Promise<{ server: string; domain: string } | null> {
  const cacheKey = `fast-ch${channelId}`;
  const cached = multiServerCache.get(cacheKey);
  if (cached && cached.expires > Date.now() && cached.data.allWorkingServers.length > 0) {
    const s = cached.data.allWorkingServers[0];
    const d = cached.data.allWorkingDomains[0];
    return { server: s, domain: d };
  }

  return new Promise((resolve) => {
    let settled = false;
    let pending = ALL_SERVERS.length * ALL_DOMAINS.length;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
      if (!settled) { settled = true; resolve(null); }
    }, timeout);

    for (const server of ALL_SERVERS) {
      for (const domain of ALL_DOMAINS) {
        probeOne(channelId, server, domain, controller.signal).then((result) => {
          if (settled) return;
          if (result.working) {
            settled = true;
            clearTimeout(timeoutId);
            // Quick-cache just this working combo
            const miniResult: MultiServerResult = {
              channelId,
              channelKey: `premium${channelId}`,
              primaryServer: null,
              allWorkingServers: [result.server],
              allWorkingDomains: [result.domain],
              probes: [result],
              totalProbed: ALL_SERVERS.length * ALL_DOMAINS.length,
              totalWorking: 1,
              elapsed: result.elapsed,
            };
            multiServerCache.set(cacheKey, { data: miniResult, expires: Date.now() + MULTI_CACHE_TTL });
            resolve({ server: result.server, domain: result.domain });
          } else {
            pending--;
            if (pending === 0 && !settled) {
              settled = true;
              clearTimeout(timeoutId);
              resolve(null);
            }
          }
        });
      }
    }
  });
}

/**
 * Get the ordered fallback server list for a channel.
 * Primary first (from lookup), then all working servers, then remaining known servers.
 */
export async function getOrderedServerList(channelId: string): Promise<string[]> {
  const result = await discoverAllServers(channelId);
  const servers = new Set<string>();

  // Primary first
  if (result.primaryServer) servers.add(result.primaryServer);

  // All working servers
  for (const s of result.allWorkingServers) servers.add(s);

  // Fill remaining known servers
  for (const s of ALL_SERVERS) servers.add(s);

  return [...servers];
}

/**
 * Batch discover: scan a range of channels and return the multi-server map.
 * Used for periodic infrastructure scans (runs in ctx.waitUntil).
 */
export async function batchDiscover(
  channelIds: number[],
  concurrency = 5,
): Promise<Map<number, MultiServerResult>> {
  const results = new Map<number, MultiServerResult>();

  for (let i = 0; i < channelIds.length; i += concurrency) {
    const batch = channelIds.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (ch) => {
        const result = await discoverAllServers(String(ch));
        return { ch, result };
      })
    );
    for (const { ch, result } of batchResults) {
      results.set(ch, result);
    }
  }

  return results;
}

/**
 * Build a SERVER_CHANNELS map (server → channel[]) from discovery results.
 * Compatible with the format used in fast-extractor.ts.
 */
export function buildServerChannelMap(
  results: Map<number, MultiServerResult>,
): Record<string, number[]> {
  const map: Record<string, number[]> = {};
  for (const server of ALL_SERVERS) {
    map[server] = [];
  }

  for (const [ch, result] of results) {
    for (const server of result.allWorkingServers) {
      if (map[server]) {
        map[server].push(ch);
      }
    }
  }

  // Remove empty servers
  for (const [key, value] of Object.entries(map)) {
    if (value.length === 0) delete map[key];
  }

  // Sort each array
  for (const key of Object.keys(map)) {
    map[key].sort((a, b) => a - b);
  }

  return map;
}

/**
 * Get cache stats for monitoring.
 */
export function getMultiServerCacheStats(): {
  size: number;
  entries: Array<{ channel: string; servers: string[]; expiresIn: number }>;
} {
  const now = Date.now();
  const entries: Array<{ channel: string; servers: string[]; expiresIn: number }> = [];
  for (const [key, val] of multiServerCache.entries()) {
    if (val.expires > now) {
      entries.push({
        channel: key,
        servers: val.data.allWorkingServers,
        expiresIn: Math.max(0, val.expires - now),
      });
    }
  }
  return { size: entries.length, entries: entries.slice(0, 50) };
}

/**
 * Invalidate cache for a specific channel or all channels.
 */
export function invalidateCache(channelId?: string): void {
  if (channelId) {
    multiServerCache.delete(`ch${channelId}`);
    multiServerCache.delete(`fast-ch${channelId}`);
  } else {
    multiServerCache.clear();
  }
}
