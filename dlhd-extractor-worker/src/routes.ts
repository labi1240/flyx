import { Router } from './router';
import { Env, ChannelListResponse, ChannelDetails, ErrorResponse, TimingInfo, StreamResponse } from './types';
import { discoverChannels, buildChannelListResponse, ParseError } from './discovery';
import { fetchChannelPage, detectPlayers, PlayerDetectionError } from './players';
import { 
  extractFromPlayerId, 
  extractBestStream, 
  buildErrorMessage,
  aggregateErrors,
  StreamExtractionError 
} from './extraction';
import { 
  encodeProxyUrl, 
  handleProxyRequest, 
  ProxyError,
  addProxyCorsHeaders,
  decodeBase64Url
} from './proxy';
import { runPipeline, setPipelineProxyConfig } from './direct/dlhd-pipeline';
import { buildDLHDPlaylist } from './direct/dlhd-v8';
import { isFakeKey, toHex, parseKeyUrl, upstreamHeaders } from './direct/dlhd-config';
import { extractFast, getServerForChannel, getServersForChannel, extractWithFallback, getCacheStats, generateJWT, getAllServers, getAllDomains, channelExists, lookupServer, getServersForChannelDynamic, getLookupCacheStats, getAllWorkingServersForChannel, findWorkingServerQuick, getServersForChannelMultiServer } from './direct/fast-extractor';
import { getMultiServerCacheStats, invalidateCache } from './direct/multi-server';
import { getProxyConfig, setProxyConfig } from './discovery/fetcher';
import { fetchKeyWithAuth, extractChannelFromKeyUrl } from './direct/key-fetcher';
import { DLHDAuthDataV5 } from './direct/dlhd-auth-v5';
import { hasMoveonjoyChannel, fetchMoveonjoyPlaylist } from './direct/moveonjoy';
import { hasPlayer6Channel, fetchPlayer6Playlist } from './direct/player6';
import { fetchKeyViaSocks5, getProxyStats, fetchViaResidentialProxy, postViaResidentialProxy, createStickySession, ResidentialProxyConfig } from './direct/socks5-proxy';
import { solveDLHDRecaptcha } from './direct/recaptcha-v3';
import { extractKeyPath, getCachedKey, cacheKey, getActiveSession, saveSession, isSessionExpiringSoon, WhitelistSession } from './direct/key-cache';
import { 
  validateOrigin, 
  validateApiKey, 
  validateChannelId,
  validateProxyUrl,
  checkRateLimit,
  createSecurityErrorResponse 
} from './middleware/security';

// In-memory cache for decryption keys (faster than KV, no binding needed)
// Keys expire after 5 minutes
const keyCache = new Map<string, { data: Uint8Array; expires: number }>();

// NOTE (Mar 25 2026): EPlayerAuth is GONE from DLHD. Auth cache below is legacy
// and no longer populated — keys require only reCAPTCHA IP whitelist, no auth headers.
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const authCache = new Map<string, { authToken: string; channelSalt: string; expires: number }>();

function getCachedAuth(channel: string): { authToken: string; channelSalt: string } | null {
  const cached = authCache.get(channel);
  if (cached && cached.expires > Date.now()) {
    return { authToken: cached.authToken, channelSalt: cached.channelSalt };
  }
  if (cached) authCache.delete(channel);
  return null;
}

function setCachedAuth(channel: string, authToken: string, channelSalt: string): void {
  authCache.set(channel, { authToken, channelSalt, expires: Date.now() + AUTH_CACHE_TTL_MS });
  // Evict old entries if cache grows too large
  if (authCache.size > 200) {
    const now = Date.now();
    for (const [key, value] of authCache.entries()) {
      if (value.expires < now) authCache.delete(key);
    }
  }
}

// Helper to clean expired keys (called on-demand, not with setInterval)
function cleanExpiredKeys() {
  const now = Date.now();
  for (const [key, value] of keyCache.entries()) {
    if (value.expires < now) {
      keyCache.delete(key);
    }
  }
}

/**
 * Rewrite M3U8 content for the /play endpoint
 *
 * STRATEGY (May 2026): Browser-Direct Key Fetching
 * - Keys: resolved to absolute URLs pointing DIRECTLY at DLHD key servers.
 *   The browser fetches them client-side from its residential IP → real keys.
 *   DLHD key servers have CORS * and reCAPTCHA is reportedly disabled.
 *   NO server-side key proxy needed — eliminates the entire whitelist problem.
 * - Segments: routed through /segment proxy endpoint for CORS headers.
 *   DLHD CDNs don't set Access-Control-Allow-Origin.
 */
async function rewriteM3u8ForPlayEndpoint(
  m3u8Content: string,
  baseUrl: string,
  workerBaseUrl: string,
  _jwtToken: string,
  _channelSalt?: string,
  _rpiProxyUrl?: string,
  _rpiApiKey?: string,
  inlineKeyBase64?: string,
): Promise<string> {
  const lines = m3u8Content.split('\n');
  const rewrittenLines: string[] = [];

  const basePath = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
  const keyServerOrigin = (() => { try { return new URL(baseUrl).origin; } catch { return 'https://chevy.newkso.ru'; } })();

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('#EXT-X-KEY') && trimmed.includes('URI="')) {
      if (inlineKeyBase64) {
        const newLine = trimmed.replace(/URI="[^"]+"/, `URI="data:application/octet-stream;base64,${inlineKeyBase64}"`);
        rewrittenLines.push(newLine);
        continue;
      }
      // Browser-direct key fetching: resolve to absolute URL pointing at DLHD's key server.
      // The browser (on residential IP) fetches the real key directly — no proxy needed.
      const uriMatch = trimmed.match(/URI="([^"]+)"/);
      if (uriMatch) {
        const uri = uriMatch[1];
        let absoluteKeyUrl: string;
        if (uri.startsWith('http')) {
          absoluteKeyUrl = uri;
        } else {
          absoluteKeyUrl = uri.startsWith('/') ? `${keyServerOrigin}${uri}` : `${basePath}${uri}`;
        }
        const newLine = trimmed.replace(/URI="[^"]+"/, `URI="${absoluteKeyUrl}"`);
        rewrittenLines.push(newLine);
        continue;
      }
    }

    // Empty lines and comments — pass through
    if (trimmed === '' || trimmed.startsWith('#')) {
      rewrittenLines.push(line);
      continue;
    }

    // Segment URLs — make absolute, then proxy through /segment for CORS
    let segmentUrl = trimmed;
    if (!segmentUrl.startsWith('http')) {
      segmentUrl = basePath + segmentUrl;
    }
    const proxiedSegmentUrl = `${workerBaseUrl}/segment?url=${encodeURIComponent(segmentUrl)}`;
    rewrittenLines.push(proxiedSegmentUrl);
  }

  return rewrittenLines.join('\n');
}

/**
 * Background whitelist refresh via relay: solve reCAPTCHA + POST verify.
 * Called via ctx.waitUntil() when the current session is expiring soon.
 */
async function refreshWhitelistViaRelay(
  relayUrl: string,
  relayKey: string,
  baseUsername: string,
  channel: string,
  kv: KVNamespace | undefined,
): Promise<void> {
  console.log(`[/key] background whitelist refresh for ${channel}...`);

  const { username, sessionId } = createStickySession(baseUsername);

  const token = await solveDLHDRecaptcha(channel);
  if (!token) {
    console.log(`[/key] background refresh: reCAPTCHA solve failed`);
    return;
  }

  const verifyBody = JSON.stringify({ 'recaptcha-token': token, 'channel_id': channel });

  const resp = await fetch(`${relayUrl}/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': relayKey },
    body: JSON.stringify({
      url: 'https://chevy.newkso.ru/verify',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.newkso.ru', 'Referer': 'https://www.newkso.ru/' },
      body: verifyBody,
      username,
    }),
    signal: AbortSignal.timeout(25000),
  });

  if (!resp.ok) {
    console.log(`[/key] background refresh relay error: ${resp.status}`);
    return;
  }

  const data = await resp.json() as { status: number; body: string };
  const text = atob(data.body);
  let success = false;
  try { success = JSON.parse(text).success === true; } catch { /* */ }

  if (success) {
    await saveSession(kv, {
      proxySessionId: sessionId,
      proxyUsername: username,
      whitelistedAt: Date.now(),
      expiresAt: Date.now() + 18 * 60 * 1000,
    });
    console.log(`[/key] ✅ background whitelist refresh succeeded: ${sessionId}`);
  } else {
    console.log(`[/key] background whitelist refresh failed: ${text.substring(0, 100)}`);
  }
}

/**
 * Create all routes for the Worker
 */
export function createRoutes(router: Router): void {
  // Health check endpoint (public)
  router.get('/health', async (request, env, params) => {
    return new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  // Whitelist endpoint — browser solves reCAPTCHA, sends token to our relay,
  // relay POSTs to verify with correct Origin header, whitelisting the browser's IP.
  router.get('/whitelist/:channelId', async (request, env, params) => {
    const channelId = params.channelId;
    const channelKey = channelId.startsWith('premium') ? channelId : `premium${channelId}`;
    const workerUrl = new URL(request.url);
    const relayUrl = `${workerUrl.protocol}//${workerUrl.host}/whitelist-relay`;

    const html = `<!DOCTYPE html><html><head><script src="https://www.google.com/recaptcha/api.js?render=6LfJv4AsAAAAALTLEHKaQ7LN_VYfFqhLPrB2Tvgj"></script></head><body><script>
grecaptcha.ready(function(){
  grecaptcha.execute('6LfJv4AsAAAAALTLEHKaQ7LN_VYfFqhLPrB2Tvgj',{action:'verify_${channelKey}'}).then(function(token){
    fetch('${relayUrl}',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token:token,channel:'${channelKey}'})
    }).then(r=>r.json()).then(data=>{
      window.parent.postMessage({type:'dlhd-whitelist',success:data.success,channel:'${channelKey}'},'*');
      document.body.textContent=data.success?'OK':'FAIL';
    }).catch(e=>{
      window.parent.postMessage({type:'dlhd-whitelist',success:false,error:e.message},'*');
      document.body.textContent='ERR';
    });
  });
});
</script></body></html>`;

    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    });
  });

  // Whitelist relay — receives reCAPTCHA token from browser, POSTs to verify with correct Origin.
  // The CF Worker makes the verify request, which whitelists the CF EDGE IP (not browser IP).
  // Then the /key endpoint on the same edge can fetch real keys.
  router.post('/whitelist-relay', async (request, env, params) => {
    const origin = request.headers.get('origin') || '*';
    const corsHeaders = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

    try {
      const body = await request.json() as { token: string; channel: string };
      if (!body.token || !body.channel) {
        return new Response(JSON.stringify({ success: false, error: 'missing token or channel' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      // POST verify with correct Origin — whitelists THIS CF edge IP
      const verifyResp = await fetch('https://chevy.newkso.ru/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.newkso.ru', 'Referer': 'https://www.newkso.ru/' },
        body: JSON.stringify({ 'recaptcha-token': body.token, 'channel_id': body.channel }),
      });
      const verifyData = await verifyResp.json() as { success?: boolean; score?: number; error?: string };
      console.log(`[whitelist-relay] ${body.channel}: ${JSON.stringify(verifyData)}`);

      return new Response(JSON.stringify(verifyData), {
        status: verifyData.success ? 200 : 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: (e as Error).message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
  });

  // Key proxy endpoint — proxies key requests server-side
  // Browser calls this instead of hitting key servers directly
  // The M3U8 rewriter points EXT-X-KEY URIs here
  //
  // Strategy (March 2026):
  //   1. Check L1 (memory) + L2 (KV) cache
  //   2. If RESIDENTIAL_PROXY_HOST set: fetch via residential SOCKS5 proxy
  //      → on fake key: solve reCAPTCHA v3, POST verify, retry
  //   3. Fallback: RPI proxy (legacy) or direct fetch
  router.get('/key', async (request, env, params) => {
    const url = new URL(request.url);
    const keyUrlParam = url.searchParams.get('url');
    const origin = request.headers.get('origin');

    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };

    if (!keyUrlParam) {
      return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const keyUrl = decodeURIComponent(keyUrlParam);
    console.log(`[/key] Proxying key request: ${keyUrl.substring(0, 80)}...`);

    // Known fake keys that key servers return to non-whitelisted IPs
    const FAKE_KEYS = new Set([
      '45db13cfa0ed393fdb7da4dfe9b5ac81',
      '455806f8bc592fdacb6ed5e071a517b1',
      '4542956ed8680eaccb615f7faad4da8f',
      '45a542173e0b81d2a9c13cbc2bdcfd8c', // Discovered Mar 25 2026 — same for all key numbers
    ]);

    const keyPath = extractKeyPath(keyUrl);

    // Build list of key URLs to try (different servers, same key path)
    // UPDATED Apr 10 2026: sec.ai-hls.site is DEAD (403). All chevy.{domain} now.
    const keyServers = [keyUrl];
    if (keyPath) {
      const servers = [
        `https://chevy.newkso.ru${keyPath}`,
        `https://chevy.enviromentalanimal.horse${keyPath}`,
        `https://chevy.soyspace.cyou${keyPath}`,
      ];
      for (const s of servers) {
        if (!keyServers.includes(s)) keyServers.push(s);
      }
    }

    const dlhdHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      'Referer': 'https://www.newkso.ru/',
      'Origin': 'https://www.newkso.ru',
    };

    function toHex(data: Uint8Array): string {
      return Array.from(data).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function makeKeyResponse(data: Uint8Array, source: string): Response {
      return new Response(data as unknown as ArrayBuffer, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '16',
          ...corsHeaders,
          'Cache-Control': 'no-store',
          'X-Key-Source': source,
        },
      });
    }

    try {
      // ─── Step 1: Cache DISABLED — was caching fake keys from un-whitelisted IPs
      // TODO: Re-enable after adding decryption validation before caching
      // const cached = await getCachedKey(env.KEY_CACHE_KV, keyPath);
      // if (cached) return makeKeyResponse(cached, 'kv-cache');

      // ─── Step 1.5: Proxy relay path (disabled)
      const RELAY_ENABLED = false;
      if (RELAY_ENABLED && env.PROXY_RELAY_URL) {
        const relayUrl = env.PROXY_RELAY_URL.replace(/\/+$/, '');
        const relayKey = env.PROXY_RELAY_KEY || '';
        const baseUsername = env.RESIDENTIAL_PROXY_USER || '';
        console.log(`[/key] using relay: ${relayUrl} user=${baseUsername.substring(0, 8)}...`);

        // Helper: call the relay to fetch a URL through the residential proxy
        async function relayFetch(
          targetUrl: string,
          targetHeaders: Record<string, string>,
          stickyUsername?: string,
        ): Promise<{ status: number; body: Uint8Array } | null> {
          try {
            const resp = await fetch(`${relayUrl}/fetch`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-API-Key': relayKey },
              body: JSON.stringify({ url: targetUrl, method: 'GET', headers: targetHeaders, username: stickyUsername }),
              signal: AbortSignal.timeout(20000),
            });
            if (!resp.ok) return null;
            const data = await resp.json() as { status: number; body: string; bodyLength: number };
            const bodyBytes = Uint8Array.from(atob(data.body), c => c.charCodeAt(0));
            return { status: data.status, body: bodyBytes };
          } catch (e) {
            console.log(`[/key] relay fetch error: ${e}`);
            return null;
          }
        }

        // Helper: call the relay to POST through the residential proxy
        async function relayPost(
          targetUrl: string,
          targetHeaders: Record<string, string>,
          targetBody: string,
          stickyUsername?: string,
        ): Promise<{ status: number; body: Uint8Array } | null> {
          try {
            const resp = await fetch(`${relayUrl}/fetch`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-API-Key': relayKey },
              body: JSON.stringify({ url: targetUrl, method: 'POST', headers: targetHeaders, body: targetBody, username: stickyUsername }),
              signal: AbortSignal.timeout(20000),
            });
            if (!resp.ok) return null;
            const data = await resp.json() as { status: number; body: string; bodyLength: number };
            const bodyBytes = Uint8Array.from(atob(data.body), c => c.charCodeAt(0));
            return { status: data.status, body: bodyBytes };
          } catch (e) {
            console.log(`[/key] relay post error: ${e}`);
            return null;
          }
        }

        // Get or create a sticky session
        let session = await getActiveSession(env.KEY_CACHE_KV);
        let stickyUsername: string | undefined;

        if (session) {
          stickyUsername = session.proxyUsername;
          console.log(`[/key] reusing session ${session.proxySessionId}`);

          // Background refresh if expiring soon
          if (isSessionExpiringSoon(session) && router.ctx) {
            console.log(`[/key] session expiring soon — scheduling background refresh`);
            const channelMatch = keyUrl.match(/\/(premium\d+)\//);
            const channel = channelMatch ? channelMatch[1] : 'premium44';
            router.ctx.waitUntil(
              refreshWhitelistViaRelay(relayUrl, relayKey, baseUsername, channel, env.KEY_CACHE_KV)
                .catch(e => console.log(`[/key] background refresh failed: ${e}`))
            );
          }
        } else {
          const { username, sessionId } = createStickySession(baseUsername);
          stickyUsername = username;
          console.log(`[/key] new session ${sessionId}`);
          session = { proxySessionId: sessionId, proxyUsername: username, whitelistedAt: 0, expiresAt: 0 };
        }

        // Try fetching key via relay
        for (const serverUrl of keyServers.slice(0, 3)) {
          const result = await relayFetch(serverUrl, dlhdHeaders, stickyUsername);
          if (result && result.status === 200 && result.body.length === 16) {
            const hex = toHex(result.body);
            if (!FAKE_KEYS.has(hex)) {
              console.log(`[/key] ✅ real key via relay: ${hex.substring(0, 8)}...`);
              await cacheKey(env.KEY_CACHE_KV, keyPath, result.body);
              if (session && !session.whitelistedAt) {
                session.whitelistedAt = Date.now();
                session.expiresAt = Date.now() + 18 * 60 * 1000;
                await saveSession(env.KEY_CACHE_KV, session);
              }
              return makeKeyResponse(result.body, 'relay-proxy');
            }
            console.log(`[/key] fake key via relay: ${hex.substring(0, 8)}...`);
          }
        }

        // Got fake keys — solve reCAPTCHA + whitelist via relay
        console.log(`[/key] all keys fake — solving reCAPTCHA + whitelisting via relay...`);
        const channelMatch = keyUrl.match(/\/(premium\d+)\//);
        const channel = channelMatch ? channelMatch[1] : 'premium44';

        const token = await solveDLHDRecaptcha(channel);
        if (token) {
          console.log(`[/key] reCAPTCHA token obtained (${token.length}b), POSTing verify via relay...`);

          const verifyResult = await relayPost(
            'https://chevy.newkso.ru/verify',
            { 'Content-Type': 'application/json', 'Origin': 'https://www.newkso.ru', 'Referer': 'https://www.newkso.ru/' },
            JSON.stringify({ 'recaptcha-token': token, 'channel_id': channel }),
            stickyUsername,
          );

          if (verifyResult) {
            const verifyText = new TextDecoder().decode(verifyResult.body);
            console.log(`[/key] verify response: ${verifyResult.status} ${verifyText.substring(0, 100)}`);

            let verifySuccess = false;
            try { verifySuccess = JSON.parse(verifyText).success === true; } catch { /* */ }

            if (verifySuccess) {
              session!.whitelistedAt = Date.now();
              session!.expiresAt = Date.now() + 18 * 60 * 1000;
              await saveSession(env.KEY_CACHE_KV, session!);
              console.log(`[/key] ✅ proxy IP whitelisted, retrying key fetch via relay...`);

              for (const serverUrl of keyServers.slice(0, 3)) {
                const retryResult = await relayFetch(serverUrl, dlhdHeaders, stickyUsername);
                if (retryResult && retryResult.status === 200 && retryResult.body.length === 16) {
                  const hex = toHex(retryResult.body);
                  if (!FAKE_KEYS.has(hex)) {
                    console.log(`[/key] ✅ real key after whitelist: ${hex.substring(0, 8)}...`);
                    await cacheKey(env.KEY_CACHE_KV, keyPath, retryResult.body);
                    return makeKeyResponse(retryResult.body, 'relay-after-whitelist');
                  }
                }
              }
            }
          }
        } else {
          console.log(`[/key] reCAPTCHA solve failed`);
        }
      }

      // ─── Step 2: Self-whitelist + fetch (Mar 27 2026) ──────────────────
      // CRITICAL: verify and key fetch MUST hit the SAME server hostname.
      // The whitelist is PER-SERVER — whitelisting on chevy.newkso.ru doesn't
      // help if the key is fetched from chevy.soyspace.cyou.
      const channelMatch = keyUrl.match(/\/(premium\d+)\//);
      const channel = channelMatch ? channelMatch[1] : 'premium51';

      // Extract the hostname from the key URL — verify on THAT same host
      const keyHost = (() => { try { return new URL(keyUrl).origin; } catch { return 'https://chevy.newkso.ru'; } })();
      const verifyUrl = `${keyHost}/verify`;

      console.log(`[/key] Self-whitelist: verify=${verifyUrl} key=${keyUrl.substring(0, 60)}`);
      try {
        const rcToken = await solveDLHDRecaptcha(channel);
        if (rcToken && rcToken.length > 20) {
          const verifyResp = await fetch(verifyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.newkso.ru', 'Referer': 'https://www.newkso.ru/' },
            body: JSON.stringify({ 'recaptcha-token': rcToken, 'channel_id': channel }),
            signal: AbortSignal.timeout(8000),
          });
          const verifyText = await verifyResp.text();
          let verifyOk = false;
          try { verifyOk = JSON.parse(verifyText).success === true; } catch {}
          console.log(`[/key] Verify on ${new URL(verifyUrl).hostname}: ${verifyText.substring(0, 60)} ok=${verifyOk}`);

          if (verifyOk) {
            // Fetch key from the SAME host we just verified on
            const res = await fetch(keyUrl, { headers: dlhdHeaders, signal: AbortSignal.timeout(6000) });
            if (res.ok) {
              const buf = await res.arrayBuffer();
              if (buf.byteLength === 16) {
                const data = new Uint8Array(buf);
                console.log(`[/key] ✅ Key after verify: ${toHex(data).substring(0, 8)}... from ${new URL(keyUrl).hostname}`);
                return makeKeyResponse(data, 'cf-same-host-verified');
              }
            }
          }
        }
      } catch (e) {
        console.log(`[/key] Self-whitelist error: ${e}`);
      }

      // ─── Step 3: RPI fallback ──────────────────────────────────────
      const rpiProxyUrl = env.RPI_PROXY_URL;
      const rpiApiKey = env.RPI_PROXY_API_KEY;
      if (rpiProxyUrl && rpiApiKey) {
        console.log(`[/key] Falling back to RPI...`);
        try {
          const rpiUrl = `${rpiProxyUrl}/dlhd-key-v6?url=${encodeURIComponent(keyServers[0])}&key=${rpiApiKey}`;
          const res = await fetch(rpiUrl, {
            headers: { 'X-API-Key': rpiApiKey },
            signal: AbortSignal.timeout(25000),
          });
          if (res.ok) {
            const buf = await res.arrayBuffer();
            if (buf.byteLength === 16) {
              const data = new Uint8Array(buf);
              const hex = toHex(data);
              console.log(`[/key] RPI key: ${hex.substring(0, 8)}... (not caching — may be fake)`);
              return makeKeyResponse(data, 'rpi-fallback');
            }
          }
        } catch (e) {
          console.log(`[/key] RPI error: ${e}`);
        }
      }

      // ─── Step 4: Direct CF fetch (unwhitelisted, likely fake) ──────
      for (const serverUrl of keyServers.slice(0, 2)) {
        try {
          const res = await fetch(serverUrl, {
            headers: dlhdHeaders,
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) continue;
          const buf = await res.arrayBuffer();
          if (buf.byteLength !== 16) continue;
          const data = new Uint8Array(buf);
          console.log(`[/key] ⚠️ cf-direct (likely fake): ${toHex(data).substring(0, 8)}...`);
          return makeKeyResponse(data, 'cf-direct-uncached');
        } catch { /* try next */ }
      }

      console.log(`[/key] ❌ all key fetch attempts failed`);
      return new Response(JSON.stringify({ error: 'All key servers failed' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    } catch (e) {
      console.log(`[/key] Error: ${(e as Error).message}`);
      return new Response(JSON.stringify({ error: (e as Error).message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
  });

  // Segment proxy endpoint — proxies segment requests with CORS headers
  // DLHD switched to CDNs without CORS (gptimage15.com, stariicloud.com)
  // so browser can't fetch segments directly. This endpoint streams them through.
  router.get('/segment', async (request, env, params) => {
    const url = new URL(request.url);
    const segmentUrlParam = url.searchParams.get('url');
    const origin = request.headers.get('origin');

    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };

    if (!segmentUrlParam) {
      return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const segmentUrl = decodeURIComponent(segmentUrlParam);

    // Only allow proxying known CDN domains (not arbitrary URLs)
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(segmentUrl);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid URL' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    try {
      const resp = await fetch(segmentUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        },
      });

      if (!resp.ok) {
        console.log(`[/segment] upstream ${resp.status}: ${parsedUrl.hostname}`);
        return new Response(resp.body, {
          status: resp.status,
          headers: corsHeaders,
        });
      }

      return new Response(resp.body, {
        status: 200,
        headers: {
          'Content-Type': resp.headers.get('Content-Type') || 'application/octet-stream',
          'Content-Length': resp.headers.get('Content-Length') || '',
          ...corsHeaders,
          'Cache-Control': 'no-store',
        },
      });
    } catch (e) {
      console.log(`[/segment] Error: ${(e as Error).message}`);
      return new Response(JSON.stringify({ error: 'Segment fetch failed' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
  });

  // Backend listing endpoint - returns available backends for a channel
  // Tests each backend to see which are actually working before returning
  // 
  // SECURITY: Requires API key OR valid origin to prevent infrastructure enumeration
  // 
  // Query params:
  //   ?test=true - Actually test each backend (slower but accurate)
  //   ?test=false or omitted - Return all backends without testing (fast)
  router.get('/backends/:channelId', async (request, env, params) => {
    const channelId = params.channelId;
    const chNum = parseInt(channelId, 10);
    const url = new URL(request.url);
    const shouldTest = url.searchParams.get('test') !== 'false'; // Default to testing
    
    // SECURITY: Validate origin OR API key to prevent infrastructure enumeration
    const origin = request.headers.get('origin');
    const referer = request.headers.get('referer');
    
    // Check API key first (allows VLC/media players)
    const apiKeyResult = validateApiKey(request, env);
    
    // If no valid API key, check origin
    if (!apiKeyResult.valid) {
      const validatedOrigin = validateOrigin(request, env);
      if (!validatedOrigin) {
        return createSecurityErrorResponse(
          'Authentication required - provide API key or access from allowed origin',
          'UNAUTHORIZED',
          401,
          '*'
        );
      }
    }
    
    // Determine CORS origin for response
    const corsOrigin = apiKeyResult.valid ? '*' : (validateOrigin(request, env) || '*');
    
    if (isNaN(chNum) || chNum < 1 || chNum > 1000) {
      return new Response(JSON.stringify({ 
        error: 'Invalid channel ID',
        hint: 'Channel ID must be between 1 and 1000'
      }), { 
        status: 400, 
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin } 
      });
    }
    
    // Get RPI proxy config for testing
    const rpiProxyUrl = env.RPI_PROXY_URL;
    const rpiApiKey = env.RPI_PROXY_API_KEY;
    
    // Get the primary server for this channel (dynamic lookup)
    const primaryServer = await lookupServer(chNum) || getServerForChannel(chNum);
    const servers = await getServersForChannelDynamic(chNum);
    const channelKey = `premium${channelId}`;
    
    // Only test soyspace.cyou domain (primary proxy domain as of Mar 2026)
    const domain = 'soyspace.cyou';
    
    // SECURITY: Generate obfuscated backend IDs to prevent infrastructure enumeration
    // The actual server.domain is only used internally - clients get opaque IDs
    const obfuscateBackendId = (server: string, domain: string, index: number): string => {
      // Use a simple index-based ID that doesn't reveal server names
      // Format: "backend-{index}" - the /play endpoint will decode this
      return `backend-${index}`;
    };
    
    // Build list of backends to test
    const backendsToTest: Array<{
      id: string;
      internalId: string; // Actual server.domain for internal use only
      server: string;
      domain: string;
      isPrimary: boolean;
      index: number;
    }> = [];
    
    let backendIndex = 0;
    
    // Add primary server first
    if (primaryServer) {
      backendsToTest.push({
        id: obfuscateBackendId(primaryServer, domain, backendIndex),
        internalId: `${primaryServer}.${domain}`,
        server: primaryServer,
        domain,
        isPrimary: true,
        index: backendIndex++,
      });
    }
    
    // Add fallback servers
    for (const server of servers) {
      if (server !== primaryServer) {
        backendsToTest.push({
          id: obfuscateBackendId(server, domain, backendIndex),
          internalId: `${server}.${domain}`,
          server,
          domain,
          isPrimary: false,
          index: backendIndex++,
        });
      }
    }
    
    // If not testing, return all backends immediately
    if (!shouldTest || !rpiProxyUrl || !rpiApiKey) {
      const backends = backendsToTest.map((b, idx) => ({
        id: b.id,
        server: b.server,
        domain: b.domain,
        isPrimary: b.isPrimary,
        label: `${b.server.toUpperCase()} (${b.domain})${b.isPrimary ? ' - Primary' : ''}`,
        status: 'unknown' as const,
      }));
      
      return new Response(JSON.stringify({
        success: true,
        channelId,
        primaryServer,
        backends,
        tested: false,
        note: 'Backends not tested. Add ?test=true to test availability.',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
      });
    }
    
    // Test each backend in parallel with a timeout
    const testBackend = async (backend: typeof backendsToTest[0]): Promise<{
      id: string;
      server: string;
      domain: string;
      isPrimary: boolean;
      label: string;
      status: 'online' | 'offline' | 'timeout';
      responseTime?: number;
    }> => {
      // UPDATED Apr 10 2026: sec.ai-hls.site is DEAD. All use chevy.{domain} pattern now.
      const m3u8Url = `https://chevy.${backend.domain}/proxy/${backend.server}/${channelKey}/mono.css`;
      const startTime = Date.now();

      try {
        // Test via RPI proxy with 5s timeout
        const rpiUrl = new URL('/dlhdprivate', rpiProxyUrl);
        rpiUrl.searchParams.set('url', m3u8Url);
        rpiUrl.searchParams.set('headers', JSON.stringify({
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*',
          'Referer': 'https://www.newkso.ru/',
          'Origin': 'https://www.newkso.ru',
        }));
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const response = await fetch(rpiUrl.toString(), {
          headers: { 'X-API-Key': rpiApiKey },
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);
        const responseTime = Date.now() - startTime;
        
        if (response.ok) {
          const text = await response.text();
          const isValid = text.includes('#EXTM3U') || text.includes('#EXT-X-');
          
          return {
            id: backend.id,
            server: backend.server,
            domain: backend.domain,
            isPrimary: backend.isPrimary,
            label: `${backend.server.toUpperCase()} (${responseTime}ms)${backend.isPrimary ? ' - Primary' : ''}`,
            status: isValid ? 'online' : 'offline',
            responseTime,
          };
        }
        
        return {
          id: backend.id,
          server: backend.server,
          domain: backend.domain,
          isPrimary: backend.isPrimary,
          label: `${backend.server.toUpperCase()} - Offline`,
          status: 'offline',
          responseTime: Date.now() - startTime,
        };
      } catch (e) {
        return {
          id: backend.id,
          server: backend.server,
          domain: backend.domain,
          isPrimary: backend.isPrimary,
          label: `${backend.server.toUpperCase()} - Timeout`,
          status: 'timeout',
          responseTime: Date.now() - startTime,
        };
      }
    };
    
    // Test all backends in parallel
    const results = await Promise.all(backendsToTest.map(testBackend));
    
    // Filter to only online backends, keep primary first
    const onlineBackends = results
      .filter(b => b.status === 'online')
      .sort((a, b) => {
        // Primary first, then by response time
        if (a.isPrimary && !b.isPrimary) return -1;
        if (!a.isPrimary && b.isPrimary) return 1;
        return (a.responseTime || 9999) - (b.responseTime || 9999);
      });
    
    // If no backends are online, return all with their status
    const backends = onlineBackends.length > 0 ? onlineBackends : results;
    
    return new Response(JSON.stringify({
      success: true,
      channelId,
      primaryServer,
      backends,
      tested: true,
      onlineCount: onlineBackends.length,
      totalCount: results.length,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
    });
  });

  // Multi-server discovery endpoint — probes ALL 7 servers × 3 domains
  // to find EVERY working server for a channel (not just the primary).
  // This bypasses the server_lookup API limitation.
  //
  // Query params:
  //   ?full=true  - Full enumeration (all 21 combos, slower but complete)
  //   ?full=false - Fast mode (first working only, default)
  router.get('/servers/:channelId', async (request, env, params) => {
    const channelId = params.channelId;
    const url = new URL(request.url);
    const fullMode = url.searchParams.get('full') === 'true';
    const origin = request.headers.get('origin');

    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };

    // Validate channel ID
    const chNum = parseInt(channelId, 10);
    if (isNaN(chNum) || chNum < 1 || chNum > 1000) {
      return new Response(JSON.stringify({
        error: 'Invalid channel ID',
        hint: 'Channel ID must be between 1 and 1000',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    try {
      if (fullMode) {
        // Full enumeration — probe all 21 combos (7 servers × 3 domains)
        const result = await getAllWorkingServersForChannel(chNum);
        return new Response(JSON.stringify({
          success: true,
          channelId,
          channelKey: result.channelKey,
          primaryServer: result.primaryServer,
          allWorkingServers: result.allWorkingServers,
          allWorkingDomains: result.allWorkingDomains,
          totalProbed: result.totalProbed,
          totalWorking: result.totalWorking,
          elapsed: result.elapsed,
          probes: result.probes
            .filter(p => p.working)
            .map(p => ({ server: p.server, domain: p.domain, elapsed: p.elapsed })),
        }, null, 2), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } else {
        // Fast mode — first working server wins
        const working = await findWorkingServerQuick(chNum);
        return new Response(JSON.stringify({
          success: true,
          channelId,
          working: working !== null,
          server: working?.server || null,
          domain: working?.domain || null,
          mode: 'fast',
        }), {
          status: working ? 200 : 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    } catch (e) {
      return new Response(JSON.stringify({
        success: false,
        error: (e as Error).message,
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
  });

  // Multi-server cache debug/management endpoint
  router.get('/servers/cache/stats', async (request, env, params) => {
    const origin = request.headers.get('origin');
    const stats = getMultiServerCacheStats();
    return new Response(JSON.stringify(stats, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin || '*' },
    });
  });

  // Invalidate multi-server cache
  router.post('/servers/cache/invalidate', async (request, env, params) => {
    const origin = request.headers.get('origin');
    let channelId: string | undefined;
    try {
      const body = await request.json() as { channelId?: string };
      channelId = body.channelId;
    } catch { /* no body */ }
    invalidateCache(channelId);
    return new Response(JSON.stringify({
      success: true,
      invalidated: channelId || 'all',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin || '*' },
    });
  });

  // Debug endpoint to check proxy config (protected)
  router.get('/debug/proxy', async (request, env, params) => {
    const proxyConfig = getProxyConfig();

    // Also test shouldUseRpiProxy
    const testUrl = 'https://chevy.soyspace.cyou/test';
    const RPI_PROXY_DOMAINS = [
      'dlhd.link', 'dlhd.dad', 'thedaddy.top', 'soyspace.cyou',
      'topembed.pw', 'newkso.ru', 'enviromentalanimal.horse', 'dvalna.ru',
      'adffdafdsafds.sbs', 'dlstreams.top', 'vovlacosa.sbs', 'the-sunmoon.site',
      'vmvmv.shop', 'daddylivestream.com', 'ai-hls.site', 'aivideox.site',
    ];
    const hostname = new URL(testUrl).hostname;
    const shouldProxy = RPI_PROXY_DOMAINS.some(domain => 
      hostname === domain || hostname.endsWith('.' + domain)
    );
    
    return new Response(JSON.stringify({
      proxyUrl: proxyConfig.url || 'NOT SET',
      proxyApiKey: proxyConfig.apiKey ? 'SET (hidden)' : 'NOT SET',
      envProxyUrl: env.RPI_PROXY_URL || 'NOT SET',
      envProxyApiKey: env.RPI_PROXY_API_KEY ? 'SET (hidden)' : 'NOT SET',
      testUrl,
      testHostname: hostname,
      shouldUseProxy: shouldProxy,
      useProxy: !!(proxyConfig.url && proxyConfig.apiKey && shouldProxy),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  // Debug endpoint: SOCKS5 proxy health stats
  // Usage: /debug/proxies?key=vynx
  router.get('/debug/proxies', async (request, env, params) => {
    const apiKeyResult = validateApiKey(request, env);
    if (!apiKeyResult.valid) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify(getProxyStats(), null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  });

  // Debug endpoint: test SOCKS5 proxy key fetch directly
  // Usage: /debug/socks5test?key=vynx
  router.get('/debug/socks5test', async (request, env, params) => {
    const apiKeyResult = validateApiKey(request, env);
    if (!apiKeyResult.valid) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const results: Record<string, unknown> = { timestamp: new Date().toISOString(), tests: [] as unknown[] };

    // Get auth data
    const { fetchAuthData, generateKeyHeaders: genHeaders } = await import('./direct/dlhd-auth-v5');
    const authData = await fetchAuthData('44');
    if (!authData) {
      results.error = 'Failed to get auth data';
      return new Response(JSON.stringify(results, null, 2), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
    results.auth = { salt: authData.channelSalt.substring(0, 16) + '...' };

    // Generate key headers
    const resource = 'premium44';
    const keyNumber = '5901637';
    const keyHeaders = await genHeaders(resource, keyNumber, {
      authToken: authData.authToken,
      channelKey: resource,
      country: 'US',
      timestamp: Math.floor(Date.now() / 1000),
      channelSalt: authData.channelSalt,
      source: 'socks5-test',
    });

    const keyUrl = `https://chevy.soyspace.cyou/key/${resource}/${keyNumber}`;
    results.keyUrl = keyUrl;

    // Test 1: Direct fetch (should get fake key)
    try {
      const directResp = await fetch(keyUrl, { headers: keyHeaders });
      const directBody = await directResp.arrayBuffer();
      const directHex = directBody.byteLength === 16 
        ? Array.from(new Uint8Array(directBody)).map(b => b.toString(16).padStart(2, '0')).join('')
        : `${directBody.byteLength}b`;
      (results.tests as unknown[]).push({ method: 'cf-direct', status: directResp.status, key: directHex });
    } catch (e) {
      (results.tests as unknown[]).push({ method: 'cf-direct', error: String(e) });
    }

    // Test 2: SOCKS5 proxy fetch (with error capture)
    // First try raw fetchViaSocks5 to see the actual error
    const { fetchViaSocks5 } = await import('./direct/socks5-proxy');
    try {
      const rawResult = await fetchViaSocks5(keyUrl, keyHeaders);
      const hex = rawResult.body.length === 16
        ? Array.from(rawResult.body).map(b => b.toString(16).padStart(2, '0')).join('')
        : `${rawResult.body.length}b`;
      (results.tests as unknown[]).push({ method: 'socks5-raw', status: rawResult.status, key: hex, proxy: rawResult.proxy });
    } catch (e) {
      (results.tests as unknown[]).push({ method: 'socks5-raw', error: String(e), stack: (e as Error).stack?.substring(0, 300) });
    }

    // Then try fetchKeyViaSocks5 (with validation)
    try {
      const socks5Result = await fetchKeyViaSocks5(keyUrl, keyHeaders, 1);
      if (socks5Result) {
        const hex = socks5Result.body.length === 16
          ? Array.from(socks5Result.body).map(b => b.toString(16).padStart(2, '0')).join('')
          : `${socks5Result.body.length}b`;
        (results.tests as unknown[]).push({ method: 'socks5-validated', status: socks5Result.status, key: hex, proxy: socks5Result.proxy });
      } else {
        (results.tests as unknown[]).push({ method: 'socks5-validated', result: 'null (all retries failed)' });
      }
    } catch (e) {
      (results.tests as unknown[]).push({ method: 'socks5-validated', error: String(e) });
    }

    results.proxyStats = getProxyStats();

    return new Response(JSON.stringify(results, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  });

  // Debug endpoint: test key fetching directly from CF Worker
  // Shows exactly what happens when CF tries to fetch a DLHD key
  // Usage: /debug/keytest?ch=44&key=vynx
  router.get('/debug/keytest', async (request, env, params) => {
    const url = new URL(request.url);
    const apiKeyResult = validateApiKey(request, env);
    if (!apiKeyResult.valid) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const channel = url.searchParams.get('ch') || '44';
    const results: Record<string, unknown> = { channel, timestamp: new Date().toISOString(), tests: [] as unknown[] };

    // Step 1: Fetch auth data from player page (www.ksohls.ru)
    const { fetchAuthData, generateKeyHeaders: genHeaders } = await import('./direct/dlhd-auth-v5');
    const authData = await fetchAuthData(channel);
    if (!authData) {
      results.authError = 'Failed to fetch auth data from player page';
      return new Response(JSON.stringify(results, null, 2), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
    results.auth = { token: authData.authToken.substring(0, 40) + '...', salt: authData.channelSalt.substring(0, 16) + '...' };

    // Step 2: Generate JWT and fetch M3U8 to get a REAL key URL
    const { generateJWT } = await import('./direct/fast-extractor');
    const { token: jwtToken, channelKey } = await generateJWT(channel);
    
    const servers = ['zeko', 'chevy', 'nfs', 'ddy6', 'x4', 'wind', 'dokko1', 'wiki'];
    const domain = 'soyspace.cyou';
    let realKeyUrl: string | null = null;
    let workingServer: string | null = null;
    
    for (const server of servers) {
      const m3u8Url = `https://chevy.${domain}/proxy/${server}/${channelKey}/mono.css`;
      try {
        const m3u8Resp = await fetch(m3u8Url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.newkso.ru/',
            'Origin': 'https://www.newkso.ru',
            'Authorization': `Bearer ${jwtToken}`,
          },
        });
        if (m3u8Resp.ok) {
          const text = await m3u8Resp.text();
          if (text.includes('#EXTM3U')) {
            // Extract key URL from M3U8
            const keyMatch = text.match(/URI="([^"]+)"/);
            if (keyMatch) {
              const keyUri = keyMatch[1];
              const basePath = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
              realKeyUrl = keyUri.startsWith('http') ? keyUri : basePath + keyUri;
              workingServer = server;
              results.m3u8 = { server, url: m3u8Url, keyUrl: realKeyUrl };
              break;
            }
          }
        }
      } catch (e) { /* skip */ }
    }
    
    if (!realKeyUrl) {
      results.error = 'Could not fetch M3U8 from any server to get real key URL';
      return new Response(JSON.stringify(results, null, 2), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    // Step 3: Parse the real key URL
    const keyParsed = realKeyUrl.match(/\/key\/([^/]+)\/(\d+)/);
    if (!keyParsed) {
      results.error = `Could not parse key URL: ${realKeyUrl}`;
      return new Response(JSON.stringify(results, null, 2), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
    const resource = keyParsed[1];
    const keyNumber = keyParsed[2];
    results.keyInfo = { resource, keyNumber, fullUrl: realKeyUrl };

    // Step 4: Try fetching the key directly from CF
    // Also try the key URL on different servers to test IPv4 vs IPv6 behavior
    const keyServers = [workingServer!, ...servers.filter(s => s !== workingServer)];
    
    for (const server of keyServers) {
      // Build key URL for this server (key URLs now come from chevy.soyspace.cyou)
      const serverKeyUrl = realKeyUrl!.replace(/https:\/\/[^/]+/, `https://chevy.soyspace.cyou`);
      // Also try the original key URL hostname
      const origHostKeyUrl = realKeyUrl!.replace(/https:\/\/[^/]+/, `https://chevy.${domain}`);
      
      for (const testUrl of [serverKeyUrl, origHostKeyUrl]) {
        const testResult: Record<string, unknown> = { keyUrl: testUrl };

        try {
          const headers = await genHeaders(resource, keyNumber, {
            authToken: authData.authToken,
            channelKey: resource,
            country: 'US',
            timestamp: Math.floor(Date.now() / 1000),
            channelSalt: authData.channelSalt,
            source: 'debug-keytest',
          });

          const start = Date.now();
          const resp = await fetch(testUrl, { headers });
          testResult.elapsed = Date.now() - start;
          testResult.status = resp.status;
          testResult.cfRay = resp.headers.get('cf-ray');

          const body = await resp.arrayBuffer();
          testResult.bodySize = body.byteLength;

          if (body.byteLength === 16) {
            const hex = Array.from(new Uint8Array(body)).map(b => b.toString(16).padStart(2, '0')).join('');
            testResult.keyHex = hex;
            testResult.isFake = hex.startsWith('455806f8') || hex.startsWith('45c6497');
            testResult.isError = hex.startsWith('6572726f72');
            testResult.valid = !testResult.isFake && !testResult.isError;
          } else if (body.byteLength > 0 && body.byteLength < 1000) {
            testResult.bodyText = new TextDecoder().decode(body).substring(0, 200);
          } else {
            testResult.note = `Response body: ${body.byteLength} bytes`;
          }
        } catch (e) {
          testResult.error = String(e);
        }

        (results.tests as unknown[]).push(testResult);
        
        // If we got a valid key, no need to test more URLs
        if ((testResult as any).valid) break;
      }
      if ((results.tests as unknown[]).some((t: any) => t.valid)) break;
    }

    return new Response(JSON.stringify(results, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  });

  // VLC-compatible play endpoint - generates JWT locally and fetches M3U8 via RPI
  // CF Worker handles ALL smart logic: JWT generation, server mapping, URL rewriting
  // RPI just acts as a dumb passthrough from residential IP
  // Usage: vlc "https://dlhd.vynx-3b3.workers.dev/play/51?key=vynx"
  // 
  // CRITICAL FIX: This endpoint now properly handles playlist refresh requests.
  // HLS players refetch the M3U8 every few seconds to get updated segments.
  // We MUST fetch the latest playlist from upstream on each request.
  router.get('/play/:channelId', async (request, env, params) => {
    const startTime = Date.now();
    const channelId = params.channelId;
    const url = new URL(request.url);
    
    // SECURITY: Validate origin - simplified for performance
    // For /play endpoint, we prioritize speed over strict origin checking
    // API key validation is the primary security mechanism
    const allowedOrigin = '*'; // Allow all origins for VLC/media player compatibility
    
    // SECURITY: Validate API key
    const apiKeyStart = Date.now();
    const apiKeyResult = validateApiKey(request, env);
    console.log(`[/play] API key validation: ${Date.now() - apiKeyStart}ms`);
    if (!apiKeyResult.valid) {
      return createSecurityErrorResponse(
        apiKeyResult.error!,
        'UNAUTHORIZED',
        401,
        allowedOrigin
      );
    }

    // Configure proxy for DLHD pipeline (routes through RPI if direct access blocked)
    if (env.RPI_PROXY_URL && env.RPI_PROXY_API_KEY) {
      setPipelineProxyConfig({ url: env.RPI_PROXY_URL, key: env.RPI_PROXY_API_KEY });
    }

    // SECURITY: Validate channel ID format
    const channelValidation = validateChannelId(channelId);
    if (!channelValidation.valid) {
      return createSecurityErrorResponse(
        channelValidation.error!,
        'INVALID_INPUT',
        400,
        allowedOrigin
      );
    }
    
    // SECURITY: Rate limiting - DISABLED for /play endpoint to improve performance
    // The /play endpoint is called every few seconds for playlist refresh
    // KV-based rate limiting adds 200-1000ms latency which kills live streaming
    // Instead, rely on API key validation and origin checks
    // TODO: Implement in-memory rate limiting if abuse becomes an issue
    
    try {
      // ──────────────────────────────────────────────────────────────────
      // v8 (May 30 2026): Current DLHD flow. The old server_lookup/newkso
      // pipeline below is DEAD infra. New flow resolves {id} → signed master
      // playlist on a CORS-open, non-WAF CDN. Browser plays media+segments
      // directly; no proxying/keys needed. See ./direct/dlhd-v8.ts.
      // `backend` param is legacy and ignored by the v8 path.
      if (!url.searchParams.get('legacy')) {
        try {
          const v8 = await buildDLHDPlaylist(channelId);
          if (v8) {
            console.log(`[/play] ✅ v8 HIT: ch${channelId} → ${v8.masterUrl} (${Date.now() - startTime}ms)`);
            return new Response(v8.playlist, {
              status: 200,
              headers: {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Access-Control-Allow-Origin': allowedOrigin,
                'Cache-Control': 'no-store',
                'X-DLHD-Flow': 'v8',
              },
            });
          }
          console.log(`[/play] v8 miss for ch${channelId}, falling back to legacy pipeline`);
        } catch (e) {
          console.log(`[/play] v8 error: ${e instanceof Error ? e.message : e}, falling back`);
        }
      }

      // Step 1: Check for forced backend from query param
      const forcedBackend = url.searchParams.get('backend');
      let servers: string[];
      let domains: readonly string[];
      
      if (forcedBackend) {
        // Parse backend format: "server.domain" (e.g., "ddy6.soyspace.cyou")
        // Split only on the first dot to handle domains like "soyspace.cyou"
        const dotIndex = forcedBackend.indexOf('.');
        if (dotIndex === -1) {
          return new Response(JSON.stringify({ 
            error: 'Invalid backend format',
            hint: 'Use format: server.domain (e.g., ddy6.soyspace.cyou)',
            example: '/play/51?backend=zeko.soyspace.cyou'
          }), { 
            status: 400, 
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
          });
        }
        const server = forcedBackend.substring(0, dotIndex);
        const domain = forcedBackend.substring(dotIndex + 1);
        if (!server || !domain) {
          return new Response(JSON.stringify({ 
            error: 'Invalid backend format',
            hint: 'Use format: server.domain (e.g., ddy6.soyspace.cyou)',
            example: '/play/51?backend=zeko.soyspace.cyou'
          }), { 
            status: 400, 
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
          });
        }
        // Only try the forced backend
        servers = [server];
        domains = [domain] as readonly string[];
        console.log(`[/play] Forced backend: ${server}.${domain}`);
      } else {
        // OPTIMIZED Mar 30 2026: Use dynamic server_lookup FIRST (fast from CF edge, ~200ms).
        // This gives us the EXACT server for the channel, avoiding 12+ wasted 404 requests.
        // Only fall back to racing all servers if lookup fails.
        const chNum = parseInt(channelId, 10);
        let primary: string | null = null;

        // Try dynamic lookup first (very fast from CF, cached 2 min)
        try {
          primary = await lookupServer(chNum);
          if (primary) {
            console.log(`[/play] server_lookup: ch${channelId} -> ${primary}`);
          }
        } catch {
          // lookup failed, will fall back to static map
        }

        // Fall back to static map
        if (!primary) {
          primary = getServerForChannel(chNum);
        }

        const allServers = getAllServers();
        // Put primary first if known, then remaining servers as fallback
        servers = primary
          ? [primary, ...allServers.filter(s => s !== primary)]
          : [...allServers];
        domains = getAllDomains();
      }

      if (servers.length === 0) {
        return new Response(JSON.stringify({
          error: `Channel ${channelId} not found in server map`,
          hint: 'Channel may not be supported'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      // Generate JWT (runs fast, ~1ms — just crypto)
      const { token, channelKey } = await generateJWT(channelId);

      // Compute workerBaseUrl once for proxy URL rewriting
      const workerBaseUrl = `${url.protocol}//${url.host}`;

      // Build headers for M3U8 request
      const m3u8Headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': 'https://www.newkso.ru/',
        'Origin': 'https://www.newkso.ru',
        'Authorization': `Bearer ${token}`,
      };

      // OPTIMIZED Mar 30 2026: Two-phase M3U8 fetch strategy.
      // Phase 1: Try the PRIMARY server only (known from lookup/static map) with tight timeout.
      //   This is the fast path — usually resolves in ~200ms from CF edge.
      // Phase 2: If primary fails, race ALL servers as fallback (same as before).
      type M3U8Result = { content: string; server: string; domain: string };
      let m3u8Content: string | null = null;
      let workingServer: string | null = null;
      let workingDomain: string | null = null;

      // Phase 1: Try primary server directly (fast path, ~200-500ms)
      const primaryServer = servers[0]; // First server is the best candidate (from lookup or static map)
      const primaryUrl = `https://chevy.newkso.ru/proxy/${primaryServer}/${channelKey}/mono.css`;

      try {
        console.log(`[/play] Phase 1: Trying primary ${primaryServer} on chevy.newkso.ru...`);
        const primaryResp = await fetch(primaryUrl, {
          headers: m3u8Headers,
          signal: AbortSignal.timeout(3000), // Tight 3s timeout for primary
        });
        if (primaryResp.ok) {
          const content = await primaryResp.text();
          if (content.includes('#EXTM3U') || content.includes('#EXT-X-')) {
            m3u8Content = content;
            workingServer = primaryServer;
            workingDomain = 'newkso.ru';
            console.log(`[/play] ✅ Phase 1 HIT: ${primaryServer}.newkso.ru (${Date.now() - startTime}ms)`);
          }
        }
      } catch (e) {
        console.log(`[/play] Phase 1 missed: ${e instanceof Error ? e.message : 'timeout'}`);
      }

      // Phase 2: Race all candidates if primary failed
      if (!m3u8Content) {
        const m3u8Candidates: Array<{ url: string; server: string; domain: string }> = [];

        for (const server of servers) {
          for (const domain of ['newkso.ru', 'enviromentalanimal.horse', ...domains]) {
            m3u8Candidates.push({
              url: `https://chevy.${domain}/proxy/${server}/${channelKey}/mono.css`,
              server,
              domain: domain as string,
            });
          }
        }

        console.log(`[/play] Phase 2: Racing ${m3u8Candidates.length} candidates...`);

        const m3u8Result = await new Promise<M3U8Result | null>((resolve) => {
          let settled = false;
          let pending = m3u8Candidates.length;

          for (const candidate of m3u8Candidates) {
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), 6000);

            fetch(candidate.url, { headers: m3u8Headers, signal: controller.signal })
              .then(async (response) => {
                clearTimeout(tid);
                if (settled) return;
                if (!response.ok) { pending--; if (pending === 0 && !settled) { settled = true; resolve(null); } return; }
                const content = await response.text();
                if (settled) return;
                if (content.includes('#EXTM3U') || content.includes('#EXT-X-')) {
                  settled = true;
                  console.log(`[/play] ✅ Phase 2 winner: ${candidate.server}.${candidate.domain}`);
                  resolve({ content, server: candidate.server, domain: candidate.domain });
                } else {
                  pending--;
                  if (pending === 0 && !settled) { settled = true; resolve(null); }
                }
              })
              .catch(() => {
                clearTimeout(tid);
                pending--;
                if (pending === 0 && !settled) { settled = true; resolve(null); }
              });
          }
        });

        if (m3u8Result) {
          m3u8Content = m3u8Result.content;
          workingServer = m3u8Result.server;
          workingDomain = m3u8Result.domain;
        }
      }
      
      // If no server worked, return error
      // SECURITY: Don't expose server/domain counts in error response
      // If no proxy M3U8 server worked, try lovecdn (Player 6) then moveonjoy as fallbacks
      if (!m3u8Content || !workingServer || !workingDomain) {
        console.log(`[/play] All proxy M3U8 servers failed, trying fallback backends...`);
        
        // Fallback 1: Try Player 6 / lovecdn (second priority — no encryption, 142 channels)
        if (!forcedBackend && hasPlayer6Channel(channelId)) {
          console.log(`[/play] Trying player 6 (lovecdn) fallback for ch${channelId}...`);
          try {
            const p6Result = await fetchPlayer6Playlist(channelId, workerBaseUrl, token);
            if (p6Result) {
              const totalTime = Date.now() - startTime;
              console.log(`[/play] ✅ Player 6 fallback SUCCESS for ch${channelId} (${p6Result.streamName}) in ${totalTime}ms`);
              return new Response(p6Result.content, {
                status: 200,
                headers: {
                  'Content-Type': 'application/vnd.apple.mpegurl',
                  'Access-Control-Allow-Origin': '*',
                  'Cache-Control': 'no-cache, no-store, must-revalidate',
                  'Pragma': 'no-cache',
                  'Expires': '0',
                  'X-DLHD-Channel': channelId,
                  'X-DLHD-Server': 'player6-lovecdn',
                  'X-DLHD-Backend': 'player6-fallback',
                },
              });
            }
            console.log(`[/play] Player 6 offline for ch${channelId}, trying moveonjoy...`);
          } catch (e) {
            console.log(`[/play] Player 6 fallback error: ${e}, trying moveonjoy...`);
          }
        }
        
        // Fallback 2: Try moveonjoy (third priority — easiest security, ~50 US channels)
        if (!forcedBackend && hasMoveonjoyChannel(channelId)) {
          console.log(`[/play] Trying moveonjoy fallback for ch${channelId}...`);
          try {
            const movResult = await fetchMoveonjoyPlaylist(channelId, workerBaseUrl, token);
            if (movResult) {
              const totalTime = Date.now() - startTime;
              console.log(`[/play] ✅ Moveonjoy fallback SUCCESS for ch${channelId} (${movResult.channelName}) in ${totalTime}ms`);
              return new Response(movResult.content, {
                status: 200,
                headers: {
                  'Content-Type': 'application/vnd.apple.mpegurl',
                  'Access-Control-Allow-Origin': '*',
                  'Cache-Control': 'no-cache, no-store, must-revalidate',
                  'Pragma': 'no-cache',
                  'Expires': '0',
                  'X-DLHD-Channel': channelId,
                  'X-DLHD-Server': 'moveonjoy',
                  'X-DLHD-Backend': 'moveonjoy-fallback',
                },
              });
            }
          } catch (e) {
            console.log(`[/play] Moveonjoy fallback error: ${e}`);
          }
        }
        
        // If forced backend was set, also try player6 and moveonjoy
        if (forcedBackend) {
          if (hasPlayer6Channel(channelId)) {
            try {
              const p6Result = await fetchPlayer6Playlist(channelId, workerBaseUrl, token);
              if (p6Result) {
                const totalTime = Date.now() - startTime;
                console.log(`[/play] ✅ Player 6 forced-fallback SUCCESS for ch${channelId} in ${totalTime}ms`);
                return new Response(p6Result.content, {
                  status: 200,
                  headers: {
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0',
                    'X-DLHD-Channel': channelId,
                    'X-DLHD-Server': 'player6-lovecdn',
                    'X-DLHD-Backend': 'player6-forced-fallback',
                  },
                });
              }
            } catch (e) {
              console.log(`[/play] Player 6 forced-fallback failed: ${e}`);
            }
          }
          if (hasMoveonjoyChannel(channelId)) {
            try {
              const movResult = await fetchMoveonjoyPlaylist(channelId, workerBaseUrl, token);
              if (movResult) {
                const totalTime = Date.now() - startTime;
                console.log(`[/play] ✅ Moveonjoy forced-fallback SUCCESS for ch${channelId} in ${totalTime}ms`);
                return new Response(movResult.content, {
                  status: 200,
                  headers: {
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0',
                    'X-DLHD-Channel': channelId,
                    'X-DLHD-Server': 'moveonjoy',
                    'X-DLHD-Backend': 'moveonjoy-forced-fallback',
                  },
                });
              }
            } catch (e) {
              console.log(`[/play] Moveonjoy forced-fallback failed: ${e}`);
            }
          }
        }
        
        return new Response(JSON.stringify({ 
          error: 'Stream temporarily unavailable',
          code: 'STREAM_UNAVAILABLE',
          hint: 'Channel may be offline or experiencing issues. Try again later.',
        }), { 
          status: 502, 
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          } 
        });
      }
      
      // Step 4: Skip key inlining — let HLS.js fetch keys via /key endpoint.
      // CRITICAL FIX Mar 30 2026: Key inlining via RPI proxy was adding 8-10 seconds
      // to every /play response, causing channels to never load. The /key endpoint
      // already handles key fetching separately (~2.5s) and HLS.js requests it
      // non-blocking while buffering segments. This makes /play return in <1s.
      const rewriteStart = Date.now();
      const m3u8Url = `https://chevy.${workingDomain}/proxy/${workingServer}/${channelKey}/mono.css`;

      const inlineKeyBase64: string | undefined = undefined;

      const rewrittenM3u8 = await rewriteM3u8ForPlayEndpoint(
        m3u8Content,
        m3u8Url,
        workerBaseUrl,
        token,
        undefined,
        env.RPI_PROXY_URL,
        env.RPI_PROXY_API_KEY,
        inlineKeyBase64,
      );
      const rewriteTime = Date.now() - rewriteStart;
      const totalTime = Date.now() - startTime;
      
      console.log(`[/play] M3U8 rewrite: ${rewriteTime}ms, total: ${totalTime}ms, server: ${workingServer}.${workingDomain}`);
      
      return new Response(rewrittenM3u8, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          // CRITICAL: Set Cache-Control to no-cache to ensure players refetch the playlist
          // This allows them to get updated segments for live streams
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
          'X-DLHD-Channel': channelId,
          'X-DLHD-Server': `${workingServer}.${workingDomain}`,
        },
      });
    } catch (error) {
      console.error(`[/play] Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return new Response(JSON.stringify({ 
        error: 'Failed to fetch stream',
        details: error instanceof Error ? error.message : 'Unknown error',
      }), { 
        status: 502, 
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        } 
      });
    }
  });

  // DLHD Private proxy endpoint - fetches EVERYTHING directly (no RPI needed!)
  // Keys, M3U8, and segments all work directly from CF
  // 
  // SECURITY: This endpoint requires either:
  // 1. A valid JWT token (from /play endpoint rewritten URLs)
  // 2. A valid API key (for direct access)
  // 3. A valid referer from our own worker (internal calls)
  router.get('/dlhdprivate', async (request, env, params) => {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');
    const jwtToken = url.searchParams.get('jwt');
    const channelSalt = url.searchParams.get('salt'); // Pre-fetched channelSalt to avoid re-fetching auth
    const shouldStripHeader = url.searchParams.get('strip') === '1';
    const customReferer = url.searchParams.get('ref'); // Custom referer for player6/moveonjoy proxying
    
    // SECURITY: Validate access - must have JWT token OR API key OR be internal call
    const referer = request.headers.get('referer') || '';
    const isInternalCall = referer.includes(url.host);
    const hasApiKey = validateApiKey(request, env).valid;
    const hasJwt = !!jwtToken && jwtToken.length > 20; // Basic JWT format check
    
    if (!isInternalCall && !hasApiKey && !hasJwt) {
      return new Response(JSON.stringify({ 
        error: 'Unauthorized - missing authentication',
        hint: 'Use /play/:channelId endpoint for authenticated access'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
    
    if (!targetUrl) {
      return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
    
    // Check if this is a KEY request - needs special auth headers
    const isKeyRequest = targetUrl.includes('/key/');
    
    if (isKeyRequest) {
      console.log(`[/dlhdprivate] KEY request: ${targetUrl.substring(0, 60)}...`);
      
      // Extract channel from key URL
      const keyMatch = targetUrl.match(/\/key\/([^/]+)\/(\d+)/);
      if (!keyMatch) {
        return new Response(JSON.stringify({ error: 'Invalid key URL format' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
      
      const resource = keyMatch[1]; // e.g., "premium577"
      const keyNumber = keyMatch[2]; // e.g., "5900830"
      const channelMatch = resource.match(/premium(\d+)/);
      const channel = channelMatch ? channelMatch[1] : null;
      
      if (!channel) {
        return new Response(JSON.stringify({ error: 'Could not extract channel from key URL' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
      
      // Import auth functions
      const { fetchAuthData, generateKeyHeaders: genHeaders } = await import('./direct/dlhd-auth-v5');
      
      // Check if we have pre-passed auth data (from /play endpoint)
      let authToken = jwtToken;
      let usedChannelSalt = channelSalt;
      
      // If we don't have pre-passed auth, try cache first, then fetch fresh
      if (!authToken || !usedChannelSalt) {
        // Try auth cache first
        const cached = getCachedAuth(channel);
        if (cached) {
          authToken = cached.authToken;
          usedChannelSalt = cached.channelSalt;
          console.log(`[/dlhdprivate] Using cached auth for channel ${channel}`);
        } else {
          console.log(`[/dlhdprivate] Fetching fresh auth data for channel ${channel}...`);
          const authData = await fetchAuthData(channel);
          
          if (!authData || !authData.channelSalt) {
            console.log(`[/dlhdprivate] ❌ Failed to get auth data`);
            return new Response(JSON.stringify({ error: 'Failed to get auth data from player page' }), {
              status: 502,
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            });
          }
          
          authToken = authData.authToken;
          usedChannelSalt = authData.channelSalt;
          // Cache for future key requests on this channel
          setCachedAuth(channel, authToken, usedChannelSalt);
          console.log(`[/dlhdprivate] ✅ Got fresh auth with salt: ${usedChannelSalt.substring(0, 16)}...`);
        }
      } else {
        console.log(`[/dlhdprivate] Using pre-passed auth data`);
      }
      
      // Step 2: Compute V5 auth headers and fetch key DIRECTLY from CF Worker
      // RPI proxy shares the same banned home IP, so we fetch directly from CF edge
      const authDataForKey: DLHDAuthDataV5 = {
        authToken: authToken!,
        channelKey: resource,
        country: 'US',
        timestamp: Math.floor(Date.now() / 1000),
        channelSalt: usedChannelSalt!,
        source: 'dlhdprivate-cf-direct',
      };
      const keyHeaders = await genHeaders(resource, keyNumber, authDataForKey);
      console.log(`[/dlhdprivate] Auth headers computed via V5 helper`);
      
      // Check key cache first - avoid hitting upstream if we already have this key
      const keyCacheKey = `${resource}/${keyNumber}`;
      const cachedKey = keyCache.get(keyCacheKey);
      if (cachedKey && cachedKey.expires > Date.now()) {
        console.log(`[/dlhdprivate] ✅ Key from cache: ${keyCacheKey}`);
        return new Response(cachedKey.data, {
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': '16',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
            'X-Fetched-By': 'key-cache',
          },
        });
      }
      
      console.log(`[/dlhdprivate] Fetching key via RPI /dlhd-key → CF direct → RPI fallback...`);
      
      // Helper to validate a 16-byte key response
      const validateKeyResponse = (keyData: ArrayBuffer | Uint8Array, source: string): Response | null => {
        const bytes = keyData instanceof Uint8Array ? keyData : new Uint8Array(keyData);
        if (bytes.byteLength !== 16) {
          console.log(`[/dlhdprivate] ❌ Invalid key size from ${source}: ${bytes.byteLength}`);
          return null;
        }
        const keyHex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
        console.log(`[/dlhdprivate] Got key from ${source}: ${keyHex}`);
        
        // Check for error-as-key patterns (rate limit error encoded as bytes)
        const isRateLimited = keyHex === '6572726f7220636f64653a2031303135' || keyHex.startsWith('6572726f72');
        if (isRateLimited) {
          console.log(`[/dlhdprivate] ⚠️ Rate limited (error in key bytes) from ${source}`);
          return null;
        }
        
        // Check for known fake/decoy key patterns
        const isFake = keyHex.startsWith('455806f8') || keyHex.startsWith('45c6497');
        if (isFake) {
          console.log(`[/dlhdprivate] ⚠️ Fake/decoy key from ${source}`);
          return null;
        }
        
        // Valid key - cache it
        console.log(`[/dlhdprivate] ✅ Valid key from ${source}: ${keyHex}`);
        keyCache.set(keyCacheKey, { data: new Uint8Array(bytes), expires: Date.now() + 60_000 });
        if (keyCache.size > 100) cleanExpiredKeys();
        
        return new Response(new Uint8Array(bytes), {
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': '16',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
            'X-Fetched-By': source,
          },
        });
      };
      
      const rpiProxyUrl = env.RPI_PROXY_URL;
      const rpiApiKey = env.RPI_PROXY_API_KEY;
      
      // Attempt 1: RPI /dlhd-key (PRIMARY — does full V5 auth from residential IP)
      // This endpoint fetches the player page, extracts XOR-encrypted salt/token,
      // computes PoW, and fetches the key — all from the RPI's residential IP.
      if (rpiProxyUrl && rpiApiKey) {
        console.log(`[/dlhdprivate] Trying RPI /dlhd-key (V5 auth)...`);
        try {
          const dlhdKeyUrl = `${rpiProxyUrl}/dlhd-key?url=${encodeURIComponent(targetUrl)}&key=${rpiApiKey}`;
          
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 15000);
          
          const dlhdKeyResponse = await fetch(dlhdKeyUrl, {
            headers: { 'X-API-Key': rpiApiKey },
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          
          if (dlhdKeyResponse.ok) {
            const keyData = await dlhdKeyResponse.arrayBuffer();
            const validResponse = validateKeyResponse(keyData, 'rpi-dlhd-key-v5');
            if (validResponse) return validResponse;
          } else {
            const errText = await dlhdKeyResponse.text().catch(() => '');
            console.log(`[/dlhdprivate] RPI /dlhd-key failed: ${dlhdKeyResponse.status} ${errText.substring(0, 100)}`);
          }
        } catch (e) {
          console.log(`[/dlhdprivate] RPI /dlhd-key error: ${e}`);
        }
      }
      
      // Attempt 2: Direct fetch from CF Worker with pre-computed V5 headers
      // May get fake key from datacenter IP but worth trying
      try {
        const directResponse = await fetch(targetUrl, { headers: keyHeaders });
        
        if (directResponse.ok) {
          const keyData = await directResponse.arrayBuffer();
          const validResponse = validateKeyResponse(keyData, 'cf-direct');
          if (validResponse) return validResponse;
        } else {
          console.log(`[/dlhdprivate] CF direct key fetch: ${directResponse.status}`);
        }
      } catch (e) {
        console.log(`[/dlhdprivate] CF direct key fetch error: ${e}`);
      }
      
      // Attempt 3: RPI /fetch-socks5 bridge (tunnels through SOCKS5 proxies with pre-computed headers)
      if (rpiProxyUrl && rpiApiKey) {
        console.log(`[/dlhdprivate] Trying RPI SOCKS5 bridge...`);
        try {
          const socks5Endpoint = `${rpiProxyUrl}/fetch-socks5?` + new URLSearchParams({
            url: targetUrl,
            headers: JSON.stringify(keyHeaders),
          }).toString();
          
          const socks5Response = await fetch(socks5Endpoint, {
            headers: { 'X-API-Key': rpiApiKey },
          });
          
          if (socks5Response.ok) {
            const keyData = await socks5Response.arrayBuffer();
            const validResponse = validateKeyResponse(keyData, `rpi-socks5-${socks5Response.headers.get('x-socks5-proxy') || 'unknown'}`);
            if (validResponse) return validResponse;
          } else {
            console.log(`[/dlhdprivate] RPI SOCKS5 bridge failed: ${socks5Response.status}`);
          }
        } catch (e) {
          console.log(`[/dlhdprivate] RPI SOCKS5 bridge error: ${e}`);
        }
      }
      
      // All attempts failed
      console.log(`[/dlhdprivate] ❌ All key fetch attempts failed for ${keyCacheKey}`);
      authCache.delete(channel);
      return new Response(JSON.stringify({ 
        error: 'Key fetch failed from all sources',
        code: 'KEY_FETCH_FAILED',
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
    
    // M3U8 and SEGMENT requests - fetch directly (no RPI needed!)
    console.log(`[/dlhdprivate] Direct fetch: ${targetUrl.substring(0, 60)}...`);
    
    try {
      const upstreamReferer = customReferer || 'https://www.newkso.ru/';
      const upstreamOrigin = customReferer ? customReferer.replace(/\/$/, '') : 'https://www.newkso.ru';
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Referer': upstreamReferer,
          'Origin': upstreamOrigin,
        },
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.log(`[/dlhdprivate] Direct fetch failed: ${response.status} - ${errorText.substring(0, 100)}`);
        return new Response(errorText, {
          status: response.status,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
      
      // If strip=1, remove the 32-byte header from segments
      if (shouldStripHeader) {
        const segmentBuffer = await response.arrayBuffer();
        const segmentData = new Uint8Array(segmentBuffer);
        
        if (segmentData.length > 32) {
          const strippedData = segmentData.slice(32);
          return new Response(strippedData, {
            status: 200,
            headers: {
              'Content-Type': 'video/mp2t',
              'Content-Length': strippedData.length.toString(),
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-cache',
            },
          });
        }
      }
      
      // Stream response to client
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      const contentLength = response.headers.get('content-length');
      
      const responseHeaders: Record<string, string> = {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      };
      if (contentLength) {
        responseHeaders['Content-Length'] = contentLength;
      }
      
      return new Response(response.body, {
        status: 200,
        headers: responseHeaders,
      });
    } catch (e) {
      console.error(`[/dlhdprivate] Error: ${e}`);
      return new Response(JSON.stringify({ error: `Request failed: ${e}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  });
  // Fast stream extraction endpoint - uses local JWT generation
  // This is the FASTEST way to get a stream - no external API calls needed
  // Returns direct URL + headers for client-side fetching (bypasses CF Worker IP blocking)
  router.get('/fast/:channelId', async (request, env, params) => {
    const channelId = params.channelId;
    const startTime = Date.now();
    
    // Check if client wants proxied URL or direct URL
    const url = new URL(request.url);
    const direct = url.searchParams.get('direct') === 'true';
    
    try {
      // Use fast extraction with local JWT generation
      const stream = await extractFast(channelId);
      
      if (!stream) {
        const timing: TimingInfo = {
          durationMs: Date.now() - startTime,
          startTime: new Date(startTime).toISOString(),
        };
        
        const errorResponse: ErrorResponse = {
          success: false,
          error: `Channel ${channelId} not found or not supported`,
          code: 'CHANNEL_NOT_FOUND',
          details: { timing },
        };
        
        return new Response(JSON.stringify(errorResponse), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      const timing: TimingInfo = {
        durationMs: Date.now() - startTime,
        startTime: new Date(startTime).toISOString(),
      };
      
      // If direct mode, return the raw URL and headers for client-side fetching
      // This bypasses Cloudflare Worker IP blocking by the upstream server
      if (direct) {
        const response = {
          success: true,
          streamUrl: stream.m3u8Url,
          headers: stream.headers,
          playerId: 0,
          quality: stream.quality,
          timing,
          note: 'Direct mode - client must fetch with provided headers',
        };
        
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // Build the worker base URL for proxying
      const workerBaseUrl = `${url.protocol}//${url.host}`;
      
      // Create the proxied playable URL
      const proxiedUrl = encodeProxyUrl(
        stream.m3u8Url,
        stream.headers,
        workerBaseUrl,
        'playlist'
      );
      
      const response: StreamResponse = {
        success: true,
        streamUrl: proxiedUrl,
        playerId: 0, // Fast extraction doesn't use player IDs
        quality: stream.quality,
        timing,
      };
      
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      const timing: TimingInfo = {
        durationMs: Date.now() - startTime,
        startTime: new Date(startTime).toISOString(),
      };
      
      const errorResponse: ErrorResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Fast extraction failed',
        code: 'EXTRACTION_ERROR',
        details: { timing },
      };
      
      return new Response(JSON.stringify(errorResponse), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  });

  // Fast stats endpoint - shows server mapping coverage
  router.get('/fast/stats', async (request, env, params) => {
    const stats = getCacheStats();
    return new Response(JSON.stringify({
      success: true,
      stats,
      timestamp: new Date().toISOString(),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  // Debug endpoint - shows proxy config (remove in production)
  router.get('/debug/proxy', async (request, env, params) => {
    const { getProxyConfig } = await import('./discovery/fetcher');
    const proxyConfig = getProxyConfig();
    return new Response(JSON.stringify({
      success: true,
      proxyConfig: {
        url: proxyConfig.url || 'NOT SET',
        apiKeySet: !!proxyConfig.apiKey,
      },
      envVars: {
        RPI_PROXY_URL: env.RPI_PROXY_URL || 'NOT SET',
        RPI_PROXY_API_KEY_SET: !!env.RPI_PROXY_API_KEY,
      },
      timestamp: new Date().toISOString(),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  // Browser-side DLHD player — bypasses Cloudflare JS Challenge by pre-warming
  // the cf_clearance cookie via a hidden iframe before fetching M3U8.
  // The browser executes Cloudflare's JS challenge, gets the clearance cookie,
  // then all subsequent fetch() calls include it automatically.
  router.get('/browser/:channelId', async (request, env, params) => {
    const channelId = params.channelId;
    const workerBaseUrl = new URL(request.url).origin;

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>DLHD ch${channelId}</title>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
<style>body{font-family:system-ui;background:#111;color:#fff;margin:0;padding:20px}
video{width:100%;max-width:960px;background:#000;display:block}
#s{padding:10px;font-size:14px;color:#aaa}
#debug{font-size:11px;color:#555;margin-top:10px;max-height:200px;overflow-y:auto}
</style></head>
<body><video id="v" controls></video><div id="s">Initializing...</div><div id="debug"></div>
<script>
(function() {
var CH="${channelId}",
    WORKER="${workerBaseUrl}",
    DOM=["newkso.ru","enviromentalanimal.horse","soyspace.cyou"],
    SRV=["ddy6","zeko","wind","dokko1","nfs","wiki","x4"],
    debugLines=[];

function status(t){document.getElementById("s").textContent=t;debug(t);}
function debug(t){debugLines.push(new Date().toISOString().substr(11,8)+" "+t);document.getElementById("debug").textContent=debugLines.slice(-15).join("\\n");}

// Cloudflare JS Challenge bypass: open a hidden iframe to the DLHD domain.
// The browser executes Cloudflare's challenge JS, gets cf_clearance cookie.
// After that, all fetch() calls to that domain include the cookie.
function warmupCfClearance(domain, timeoutMs) {
  return new Promise(function(resolve) {
    status("Warming cf_clearance for "+domain+"...");
    var iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.src = "https://chevy."+domain+"/";
    var done = false;
    var timer = setTimeout(function() {
      if (!done) { done = true; document.body.removeChild(iframe); debug("cf warmup timeout for "+domain); resolve(false); }
    }, timeoutMs);
    iframe.onload = function() {
      if (!done) { done = true; clearTimeout(timer); document.body.removeChild(iframe); debug("cf warmup complete for "+domain); resolve(true); }
    };
    iframe.onerror = function() {
      if (!done) { done = true; clearTimeout(timer); document.body.removeChild(iframe); debug("cf warmup error for "+domain); resolve(false); }
    };
    document.body.appendChild(iframe);
  });
}

async function fetchWithRetry(url, headers, retries) {
  retries = retries || 2;
  for (var i=0; i<=retries; i++) {
    try {
      var r = await fetch(url, {headers: headers, signal: AbortSignal.timeout(8000)});
      if (r.ok) return r;
      debug("HTTP "+r.status+" for "+url.substring(0,60)+" (attempt "+(i+1)+"/"+(retries+1)+")");
      if (r.status === 403 && i < retries) {
        // Cloudflare challenge — warmup then retry
        var host = new URL(url).hostname;
        await warmupCfClearance(host.replace("chevy.",""), 5000);
      }
    } catch(e) {
      debug("Fetch error: "+e.message+" (attempt "+(i+1)+")");
    }
  }
  return null;
}

(async()=>{
// Step 0: Pre-warm cf_clearance on the primary domain
await warmupCfClearance(DOM[0], 6000);

// Step 1: Server discovery
status("Discovering server...");
var best=null;
for(var d of DOM){try{var j=await fetchWithRetry("https://chevy."+d+"/server_lookup?channel_id=premium"+CH,{Referer:"https://www.newkso.ru/"});if(j){var jj=await j.json();if(jj&&jj.server_key){best=jj.server_key;debug("Server: "+best+" (via "+d+")");break}}}catch(e){debug("Lookup err "+d+": "+e.message)}}

// Step 2: Fetch M3U8
status("Fetching stream...");
var m3=null, usedSrv=null, usedDom=null;
var sv=best?[best].concat(SRV.filter(function(x){return x!==best})):SRV;
for(var srv of sv){for(var dom of DOM){var r=await fetchWithRetry("https://chevy."+dom+"/proxy/"+srv+"/premium"+CH+"/mono.css",{Referer:"https://www.newkso.ru/",Origin:"https://www.newkso.ru"});if(r){m3=await r.text();usedSrv=srv;usedDom=dom;status("Got stream: "+srv+"."+dom);break}}if(m3)break}
if(!m3){status("Stream offline — try a different channel");return}

// Step 3: Rewrite M3U8
var m3url="https://chevy."+usedDom+"/proxy/"+usedSrv+"/premium"+CH+"/mono.css";
var ko=(new URL(m3url)).origin, bp=m3url.substring(0,m3url.lastIndexOf("/")+1);
var lines=m3.split("\\n"), out=[];
for(var li=0; li<lines.length; li++){
  var l=lines[li], t=l.trim();
  if(t.indexOf("#EXT-X-KEY")===0&&t.indexOf('URI="')!==-1){
    var um=t.match(/URI="([^"]+)"/);
    if(um){var abs=um[1].indexOf("http")===0?um[1]:um[1].indexOf("/")===0?ko+um[1]:bp+um[1];out.push(t.replace(/URI="[^"]+"/,'URI="'+abs+'"'));continue}
  }
  if(!t||t.indexOf("#")===0){out.push(l);continue}
  var seg=t.indexOf("http")===0?t:bp+t;
  out.push(WORKER+"/segment?url="+encodeURIComponent(seg));
}
var rw=out.join("\\n"), blob=new Blob([rw],{type:"application/vnd.apple.mpegurl"});
var url=URL.createObjectURL(blob), v=document.getElementById("v");
status("Playing... ("+usedSrv+"."+usedDom+")");

// Step 4: Play
if(Hls.isSupported()){var h=new Hls();h.loadSource(url);h.attachMedia(v);h.on(Hls.Events.ERROR,function(e,d){if(d.fatal){status("Fatal error: "+d.type+" — "+d.details);h.destroy()}})}
else if(v.canPlayType("application/vnd.apple.mpegurl")){v.src=url}
else{status("HLS not supported")}
v.play().catch(function(){});
})();
})();
</script></body></html>`;

    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
  });

  // API for browser-side pipeline — gives frontend the URLs to try directly
  router.get('/browser-api/:channelId', async (request, env, params) => {
    const channelId = params.channelId;
    const chNum = parseInt(channelId, 10);
    if (isNaN(chNum) || chNum < 1 || chNum > 1000) {
      return new Response(JSON.stringify({ error: 'Invalid channel' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
    const workerBaseUrl = new URL(request.url).origin;
    const domains = ['newkso.ru', 'enviromentalanimal.horse', 'soyspace.cyou'];
    const servers = ['ddy6','zeko','wind','dokko1','nfs','wiki','x4'];
    let bestServer = null;
    try {
      const resp = await fetch('https://chevy.'+domains[0]+'/server_lookup?channel_id=premium'+channelId, { headers: { 'Referer': 'https://www.newkso.ru/', 'Origin': 'https://www.newkso.ru' }, signal: AbortSignal.timeout(5000) });
      if (resp.ok) { const data = await resp.json(); if (data.server_key) bestServer = data.server_key; }
    } catch {}
    const orderedServers = bestServer ? [bestServer, ...servers.filter(s => s !== bestServer)] : servers;
    return new Response(JSON.stringify({
      success: true, channelId, bestServer,
      m3u8Urls: orderedServers.flatMap(s => domains.map(d => ({ server: s, domain: d, url: 'https://chevy.'+d+'/proxy/'+s+'/premium'+channelId+'/mono.css' }))),
      keyServerOrigin: 'https://chevy.'+domains[0],
      segmentProxy: workerBaseUrl+'/segment?url=',
      note: 'Browser fetches M3U8 & keys directly (residential IP). Segments proxy through worker.',
    }), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  });

  // Debug endpoint to test auth computation
  router.get('/debug-auth/:channelId', async (request, env, params) => {
    const channelId = params.channelId;
    
    try {
      // Import the auth functions
      const { fetchAuthData, generateKeyHeaders, computePowNonce, computeKeyPath, generateFingerprint, hmacSha256Debug } = await import('./direct/dlhd-auth-v5');
      
      // Fetch auth data
      const authData = await fetchAuthData(channelId);
      if (!authData) {
        return new Response(JSON.stringify({ error: 'Failed to fetch auth data' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // Test values
      const resource = `premium${channelId}`;
      const keyNumber = '5900829';
      const timestamp = Math.floor(Date.now() / 1000);
      const fingerprint = await generateFingerprint();
      
      // Debug: compute HMAC prefix
      const hmacPrefix = await hmacSha256Debug(resource, authData.channelSalt);
      
      const nonce = await computePowNonce(resource, keyNumber, timestamp, authData.channelSalt);
      const keyPath = await computeKeyPath(resource, keyNumber, timestamp, fingerprint, authData.channelSalt);
      
      return new Response(JSON.stringify({
        authData: {
          authToken: authData.authToken.substring(0, 50) + '...',
          channelSalt: authData.channelSalt,
          channelKey: authData.channelKey,
          source: authData.source,
        },
        computed: {
          resource,
          keyNumber,
          timestamp,
          fingerprint,
          hmacPrefix,
          nonce,
          keyPath,
        },
        expected: {
          hmacPrefix: '1a4c310c0393ca113fc743a92b8180cfbebd0d1f624519c0185e64aa2b8a35c5',
        },
      }, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  });

  // Root endpoint (public)
  router.get('/', async (request, env, params) => {
    return new Response(
      JSON.stringify({
        name: 'DLHD Stream Extractor Worker',
        version: '2.3.0',
        endpoints: [
          'GET /play/:channelId - VLC-compatible: JWT generated locally, M3U8 via RPI',
          'GET /dlhdprivate?url=&headers= - Proxy segments/keys via RPI (internal use)',
          'GET /fast/:channelId - Get stream with local JWT (may fail due to CF IP blocking)',
          'GET /fast/:channelId?direct=true - Get raw URL + headers for client-side fetching',
          'GET /fast/stats - Get server mapping statistics',
          'GET /channels - List all channels',
          'GET /channel/:id - Get channel details',
          'GET /stream/:channelId - Auto-select best stream',
          'GET /stream/:channelId/:playerId - Get specific player stream',
          'GET /live/* - Proxy stream resources',
        ],
        notes: [
          '/play/:channelId - CF Worker generates JWT, fetches M3U8 via RPI, decrypts segments',
          '/dlhdprivate is used internally by M3U8 URLs to proxy segments through RPI',
          'All smart logic (JWT, PoW, server maps) is in CF Worker - RPI is just a dumb proxy',
          'Use ?direct=true to get raw M3U8 URL + headers for client-side fetching',
        ],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  });

  // Channel listing endpoint (protected)
  router.get('/channels', async (_request, _env, _params) => {
    const startTime = Date.now();
    
    try {
      const { channels, timing } = await discoverChannels();
      const response = buildChannelListResponse(channels, timing);
      
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      const timing: TimingInfo = {
        durationMs: Date.now() - startTime,
        startTime: new Date(startTime).toISOString(),
      };
      
      // Handle parse errors specifically
      if (error instanceof ParseError) {
        const errorResponse: ErrorResponse = {
          success: false,
          error: error.message,
          code: error.code,
          details: { timing },
        };
        
        return new Response(JSON.stringify(errorResponse), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // Handle network/fetch errors
      const errorResponse: ErrorResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch channels',
        code: 'FETCH_ERROR',
        details: { timing },
      };
      
      return new Response(JSON.stringify(errorResponse), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  });

  // Channel details endpoint (protected)
  router.get('/channel/:id', async (_request, _env, params) => {
    const channelId = params.id;
    const startTime = Date.now();
    
    try {
      // Fetch the channel page
      const { html } = await fetchChannelPage(channelId);
      
      // Detect all player sources
      const players = detectPlayers(html, channelId);
      
      // Build channel details response
      const channelDetails: ChannelDetails = {
        id: channelId,
        name: `Channel ${channelId}`, // Name will be extracted from page in future
        category: '24-7',
        status: 'live',
        players,
        lastUpdated: new Date().toISOString(),
      };
      
      const timing: TimingInfo = {
        durationMs: Date.now() - startTime,
        startTime: new Date(startTime).toISOString(),
      };
      
      return new Response(JSON.stringify({
        success: true,
        channel: channelDetails,
        timing,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      const timing: TimingInfo = {
        durationMs: Date.now() - startTime,
        startTime: new Date(startTime).toISOString(),
      };
      
      // Handle player detection errors
      if (error instanceof PlayerDetectionError) {
        const errorResponse: ErrorResponse = {
          success: false,
          error: error.message,
          code: error.code,
          details: { timing },
        };
        
        return new Response(JSON.stringify(errorResponse), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // Handle 404 errors (channel not found)
      if (error instanceof Error && error.message.includes('404')) {
        const errorResponse: ErrorResponse = {
          success: false,
          error: `Channel ${channelId} not found`,
          code: 'CHANNEL_NOT_FOUND',
          details: { timing },
        };
        
        return new Response(JSON.stringify(errorResponse), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // Handle network/fetch errors
      const errorResponse: ErrorResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch channel details',
        code: 'FETCH_ERROR',
        details: { timing },
      };
      
      return new Response(JSON.stringify(errorResponse), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  });

  // Auto-select stream endpoint (protected)
  // Requirements: 6.4 - THE Worker SHALL expose a `/stream/:channelId` endpoint 
  // that auto-selects the best working player and returns a playable stream
  router.get('/stream/:channelId', async (request, env, params) => {
    const channelId = params.channelId;
    const startTime = Date.now();
    
    try {
      // Fetch the channel page to get player sources
      const { html } = await fetchChannelPage(channelId);
      
      // Detect all player sources
      const players = detectPlayers(html, channelId);
      
      // Try to extract the best stream (tries direct backend first, then players)
      const result = await extractBestStream(channelId, players, undefined, { env });
      
      if (!result.success || !result.stream) {
        const timing: TimingInfo = {
          durationMs: Date.now() - startTime,
          startTime: new Date(startTime).toISOString(),
        };
        
        // Build comprehensive error message from all attempts
        const errorMessage = buildErrorMessage(result.attempts);
        
        // Use aggregated error if available
        const aggregatedError = result.aggregatedError;
        
        const errorResponse: ErrorResponse = {
          success: false,
          error: aggregatedError?.summary || errorMessage,
          code: 'ALL_PLAYERS_FAILED',
          details: { 
            timing,
            totalAttempts: aggregatedError?.totalAttempts || result.attempts.length,
            failedAttempts: aggregatedError?.failedAttempts || result.attempts.filter(a => !a.success).length,
            mostCommonError: aggregatedError?.mostCommonError,
            errorCodeCounts: aggregatedError?.errorCodeCounts,
            playerErrors: aggregatedError?.playerErrors || result.attempts.map(a => ({
              playerId: a.playerId,
              success: a.success,
              error: a.error,
              errorCode: a.errorCode,
              durationMs: a.durationMs,
            })),
          },
        };
        
        return new Response(JSON.stringify(errorResponse), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // Build the worker base URL for proxying
      const url = new URL(request.url);
      const workerBaseUrl = `${url.protocol}//${url.host}`;
      
      // Create the proxied playable URL
      const proxiedUrl = encodeProxyUrl(
        result.stream.m3u8Url,
        result.stream.headers,
        workerBaseUrl,
        'playlist'
      );
      
      const timing: TimingInfo = {
        durationMs: Date.now() - startTime,
        startTime: new Date(startTime).toISOString(),
      };
      
      const response: StreamResponse = {
        success: true,
        streamUrl: proxiedUrl,
        playerId: result.playerId!,
        quality: result.stream.quality,
        timing,
      };
      
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      const timing: TimingInfo = {
        durationMs: Date.now() - startTime,
        startTime: new Date(startTime).toISOString(),
      };
      
      // Handle player detection errors
      if (error instanceof PlayerDetectionError) {
        const errorResponse: ErrorResponse = {
          success: false,
          error: error.message,
          code: error.code,
          details: { timing },
        };
        
        return new Response(JSON.stringify(errorResponse), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // Handle 404 errors (channel not found)
      if (error instanceof Error && error.message.includes('404')) {
        const errorResponse: ErrorResponse = {
          success: false,
          error: `Channel ${channelId} not found`,
          code: 'CHANNEL_NOT_FOUND',
          details: { timing },
        };
        
        return new Response(JSON.stringify(errorResponse), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // Handle generic errors
      const errorResponse: ErrorResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to extract stream',
        code: 'EXTRACTION_ERROR',
        details: { timing },
      };
      
      return new Response(JSON.stringify(errorResponse), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  });

  // Specific player stream endpoint (protected)
  // Requirements: 6.3 - THE Worker SHALL expose a `/stream/:channelId/:playerId` endpoint 
  // that returns a DIRECTLY PLAYABLE proxied M3U8 URL
  router.get('/stream/:channelId/:playerId', async (request, env, params) => {
    const { channelId, playerId: playerIdStr } = params;
    const startTime = Date.now();
    const playerId = parseInt(playerIdStr, 10);
    
    // Validate player ID
    if (isNaN(playerId) || playerId < 1 || playerId > 6) {
      const timing: TimingInfo = {
        durationMs: Date.now() - startTime,
        startTime: new Date(startTime).toISOString(),
      };
      
      const errorResponse: ErrorResponse = {
        success: false,
        error: `Invalid player ID: ${playerIdStr}. Must be between 1 and 6.`,
        code: 'INVALID_PLAYER',
        details: { timing },
      };
      
      return new Response(JSON.stringify(errorResponse), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    try {
      // Fetch the channel page to get player sources
      const { html } = await fetchChannelPage(channelId);
      
      // Detect all player sources
      const players = detectPlayers(html, channelId);
      
      // Extract stream from the specific player
      const stream = await extractFromPlayerId(channelId, playerId, players);
      
      // Build the worker base URL for proxying
      const url = new URL(request.url);
      const workerBaseUrl = `${url.protocol}//${url.host}`;
      
      // Create the proxied playable URL
      const proxiedUrl = encodeProxyUrl(
        stream.m3u8Url,
        stream.headers,
        workerBaseUrl,
        'playlist'
      );
      
      const timing: TimingInfo = {
        durationMs: Date.now() - startTime,
        startTime: new Date(startTime).toISOString(),
      };
      
      const response: StreamResponse = {
        success: true,
        streamUrl: proxiedUrl,
        playerId,
        quality: stream.quality,
        timing,
      };
      
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      const timing: TimingInfo = {
        durationMs: Date.now() - startTime,
        startTime: new Date(startTime).toISOString(),
      };
      
      // Handle stream extraction errors
      if (error instanceof StreamExtractionError) {
        const errorResponse: ErrorResponse = {
          success: false,
          error: error.message,
          code: error.code,
          details: { timing, playerId: error.playerId },
        };
        
        return new Response(JSON.stringify(errorResponse), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // Handle player detection errors
      if (error instanceof PlayerDetectionError) {
        const errorResponse: ErrorResponse = {
          success: false,
          error: error.message,
          code: error.code,
          details: { timing },
        };
        
        return new Response(JSON.stringify(errorResponse), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // Handle 404 errors (channel not found)
      if (error instanceof Error && error.message.includes('404')) {
        const errorResponse: ErrorResponse = {
          success: false,
          error: `Channel ${channelId} not found`,
          code: 'CHANNEL_NOT_FOUND',
          details: { timing },
        };
        
        return new Response(JSON.stringify(errorResponse), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // Handle generic errors
      const errorResponse: ErrorResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to extract stream',
        code: 'EXTRACTION_ERROR',
        details: { timing },
      };
      
      return new Response(JSON.stringify(errorResponse), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  });

  // Live proxy endpoint (protected)
  // Requirements: 6.5 - THE Worker SHALL expose a `/live/:path*` endpoint 
  // that proxies all stream resources (playlists, segments, keys)
  router.get('/live/*', async (request, env, params) => {
    const path = params.path;
    const url = new URL(request.url);
    const searchParams = url.searchParams;
    const startTime = Date.now();
    
    console.log(`[/live/*] Path: ${path}`);
    console.log(`[/live/*] Search params: ${searchParams.toString().substring(0, 100)}`);
    
    // Build the worker base URL for rewriting nested URLs
    const workerBaseUrl = `${url.protocol}//${url.host}`;
    console.log(`[/live/*] Worker base URL: ${workerBaseUrl}`);
    
    // Extract API key from query params for VLC/media player compatibility
    const apiKey = searchParams.get('key') || searchParams.get('api_key') || undefined;
    console.log(`[/live/*] API Key: ${apiKey ? 'present' : 'none'}`);
    
    try {
      // Handle the proxy request based on path type
      const result = await handleProxyRequest(path, searchParams, {
        workerBaseUrl,
        timeout: 30000,
        rewriteM3U8: true,
        apiKey,
      });
      
      // Add CORS headers to the response
      return addProxyCorsHeaders(result.response);
    } catch (error) {
      const timing: TimingInfo = {
        durationMs: Date.now() - startTime,
        startTime: new Date(startTime).toISOString(),
      };
      
      // Handle proxy errors
      if (error instanceof ProxyError) {
        const errorResponse: ErrorResponse = {
          success: false,
          error: error.message,
          code: error.code,
          details: { timing, ...error.details },
        };
        
        return addProxyCorsHeaders(new Response(JSON.stringify(errorResponse), {
          status: error.statusCode,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      
      // Handle generic errors
      const errorResponse: ErrorResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Proxy request failed',
        code: 'PROXY_ERROR',
        details: { timing },
      };
      
      return addProxyCorsHeaders(new Response(JSON.stringify(errorResponse), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }));
    }
  });
}
