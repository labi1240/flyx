/**
 * Videasy outbound proxy pool (server-side only)
 *
 * Videasy/shegu.org block Cloudflare Worker egress, so videasy must be fetched
 * from real servers. At scale you want a POOL of datacenter IPs and rotate the
 * outbound IP per request to avoid per-IP rate limits.
 *
 * Set VIDEASY_PROXY_POOL to a comma-separated list of proxy URLs, e.g.:
 *   VIDEASY_PROXY_POOL="http://user:pass@ip1:port,http://user:pass@ip2:port"
 *
 * If unset, fetches go directly from the host's own IP (current behaviour).
 * Round-robins across the pool; ProxyAgents are cached per URL (each keeps its
 * own connection pool).
 */

import { ProxyAgent } from 'undici';

let cursor = 0;
const agentCache = new Map<string, ProxyAgent>();

function getPool(): string[] {
  return (process.env.VIDEASY_PROXY_POOL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Returns an undici dispatcher (ProxyAgent) for the next proxy in the pool,
 * or undefined when no pool is configured (= direct fetch from this host's IP).
 * Pass the result as `dispatcher` on a fetch() call.
 */
export function nextVideasyDispatcher(): ProxyAgent | undefined {
  const pool = getPool();
  if (pool.length === 0) return undefined;
  const url = pool[cursor++ % pool.length];
  let agent = agentCache.get(url);
  if (!agent) {
    agent = new ProxyAgent(url);
    agentCache.set(url, agent);
  }
  return agent;
}

export function videasyPoolSize(): number {
  return getPool().length;
}
