/**
 * Shared CORS/Cloudflare-free fetch transport via the Flyx Bypass extension.
 *
 * Network calls are relayed through the extension service worker (bridge.js →
 * SW corsFetch). The SW's background fetch runs as the real browser from the
 * user's residential IP with <all_urls> host access, so it:
 *   - is NOT subject to page CORS (servers without ACAO headers work), and
 *   - presents a genuine Chrome TLS fingerprint from a residential IP, which
 *     passes the bot scoring on Cloudflare-fronted APIs that block datacenter
 *     IPs / non-browser clients.
 * DNR rules (installed by the SW) inject any required Origin/Referer headers
 * transparently — fetch() can't set Referer itself, but DNR can.
 */

export function extensionAvailable(): boolean {
  return typeof window !== 'undefined' && !!(window as any).__FLYX_EXTENSION__?.installed;
}

export interface SwFetchResult {
  ok: boolean;
  status: number;
  body: string;
}

/**
 * Fetch a URL through the extension SW. Resolves null on transport failure
 * (relay error / timeout). Returns a result (possibly non-ok) on a completed
 * HTTP round-trip. Falls back to a direct page fetch when the extension isn't
 * installed (which may CORS-fail, but preserves behaviour without the ext).
 */
export interface SwFetchOpts {
  method?: string;
  body?: string;
  timeoutMs?: number;
}

export function swFetch(
  url: string,
  headers: Record<string, string> = {},
  opts: number | SwFetchOpts = 15000,
): Promise<SwFetchResult | null> {
  const o: SwFetchOpts = typeof opts === 'number' ? { timeoutMs: opts } : opts;
  const timeoutMs = o.timeoutMs ?? 15000;
  const method = o.method || 'GET';
  const body = o.body;

  if (!extensionAvailable()) {
    return fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) })
      .then(async (r) => ({ ok: r.ok, status: r.status, body: await r.text() }))
      .catch(() => null);
  }

  return new Promise((resolve) => {
    const id = 'swf_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs + 2000);
    function cleanup() { clearTimeout(timer); window.removeEventListener('message', onMsg); }
    function onMsg(e: MessageEvent) {
      if (e.source !== window || !e.data || e.data.__flyx !== 'corsFetchRes' || e.data.id !== id) return;
      cleanup();
      if (e.data.ok) {
        const status = e.data.status || 0;
        resolve({ ok: status >= 200 && status < 300, status, body: e.data.body || '' });
      } else {
        resolve(null);
      }
    }
    window.addEventListener('message', onMsg);
    window.postMessage({ __flyx: 'corsFetch', id, url, headers, method, body, timeoutMs }, '*');
  });
}
