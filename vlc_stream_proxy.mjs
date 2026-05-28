// Local HLS proxy — extracts fresh Videasy stream, proxies m3u8 + segments
// with proper headers. Keeps m3u8 fresh so VLC never hits expired tokens.
// Open VLC → http://localhost:8765/play.m3u8
import { readFileSync } from 'fs';
import crypto from 'crypto';
import http from 'http';

const PORT = 8765;
const REFERER = 'https://player.videasy.net/';
const ORIGIN = 'https://player.videasy.net';
const UA = 'Mozilla/5.0';
const M3U8_MAX_AGE_MS = 45_000; // refresh m3u8 before tokens expire (~60s)

// ── WASM init ──
const wasmBuf = readFileSync('videasy-module-patched.wasm');
const mod = await WebAssembly.instantiate(wasmBuf, {
  env: { seed() { return Date.now() * Math.random(); }, abort() {} }
});
const ex = mod.instance.exports;
const mem = ex.memory;

const alloc = (str) => {
  const b = new Uint8Array(mem.buffer);
  const ptr = ex.__new(str.length * 2, 2);
  for (let i = 0; i < str.length; i++) {
    b[ptr + i*2] = str.charCodeAt(i) & 0xff;
    b[ptr + i*2 + 1] = (str.charCodeAt(i) >> 8) & 0xff;
  }
  return ptr;
};
const reads = (ptr, max) => {
  if (!ptr) return '';
  const b = new Uint8Array(mem.buffer);
  let r = '';
  for (let i = ptr; i < ptr + max*2 && i+1 < b.length; i+=2) {
    const c = b[i] | (b[i+1] << 8);
    if (c === 0) break;
    r += String.fromCharCode(c);
  }
  return r;
};
const aes = (b64, key='') => {
  const raw = Buffer.from(b64, 'base64');
  const s = raw.slice(8,16), ct = raw.slice(16);
  let h=Buffer.alloc(0), d=Buffer.alloc(0);
  while(d.length < 48) {
    const m = crypto.createHash('md5');
    m.update(h); m.update(Buffer.from(key,'utf8')); m.update(s);
    h = m.digest(); d = Buffer.concat([d,h]);
  }
  const dec = crypto.createDecipheriv('aes-256-cbc', d.slice(0,32), d.slice(32,48));
  dec.setAutoPadding(true);
  return Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
};

// ── Extract fresh stream ──
async function extractFull(title = 'Interstellar', tmdbId = '157336', year = '2014', imdbId = 'tt0816692') {
  const params = new URLSearchParams({ title, mediaType: 'Movie', year, totalSeasons: '0', episodeId: '0', seasonId: '0', tmdbId, imdbId });
  const res = await fetch(`https://api.videasy.net/cdn/sources-with-title?${params}`, {
    headers: { 'User-Agent': UA }
  });
  const hex = await res.text();
  if (hex.startsWith('{')) throw new Error('API error: ' + hex);
  const ptr = alloc(hex);
  const dp = ex.decrypt(ptr, parseFloat(tmdbId));
  const b64 = reads(dp, Math.floor(hex.length / 2));
  const json = aes(b64, '');
  const data = JSON.parse(json);
  return data.sources.find(s => s.quality === '1080p')?.url || data.sources[0].url;
}

// ── M3U8 cache ──
let cachedM3u8 = null;
let m3u8Timestamp = 0;
let refreshInProgress = null;

async function getFreshM3u8() {
  // Avoid concurrent refreshes
  if (refreshInProgress) await refreshInProgress;

  const age = Date.now() - m3u8Timestamp;
  if (cachedM3u8 && age < M3U8_MAX_AGE_MS) return cachedM3u8;

  refreshInProgress = (async () => {
    try {
      const url = await extractFull();
      console.log(`[proxy] Fresh master m3u8 URL: ${url.substring(0,80)}...`);
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Referer': REFERER, 'Origin': ORIGIN }
      });
      if (!r.ok) throw new Error(`Upstream returned ${r.status}`);
      const body = await r.text();
      // Rewrite all absolute URLs to go through our proxy
      const rewritten = body.replace(/https?:\/\/[^\s"'<>]+/g, (match) => {
        return `/proxy?url=${encodeURIComponent(match)}`;
      });
      cachedM3u8 = rewritten;
      m3u8Timestamp = Date.now();
      console.log(`[proxy] M3U8 cached (${body.length} -> ${rewritten.length} bytes, valid for ${M3U8_MAX_AGE_MS/1000}s)`);
      return rewritten;
    } finally {
      refreshInProgress = null;
    }
  })();

  return refreshInProgress;
}

// Force refresh after a segment failure
async function forceRefresh() {
  cachedM3u8 = null;
  m3u8Timestamp = 0;
  console.log('[proxy] Forced m3u8 expiration due to segment failure');
  return getFreshM3u8();
}

// ── HTTP server ──
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    if (req.url === '/play.m3u8' || req.url === '/') {
      const m3u8 = await getFreshM3u8();
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(m3u8);
    }
    else if (req.url.startsWith('/proxy')) {
      const targetUrl = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('url');
      if (!targetUrl) { res.writeHead(400); res.end('Missing url param'); return; }

      let r;
      try {
        r = await fetch(targetUrl, {
          headers: { 'User-Agent': UA, 'Referer': REFERER, 'Origin': ORIGIN }
        });
      } catch (e) {
        // Network failure — token likely expired
        console.log(`[proxy] Fetch failed for segment, forcing m3u8 refresh: ${e.message}`);
        await forceRefresh();
        res.writeHead(503);
        res.end('Token expired — playlist refreshed, retry');
        return;
      }

      if (!r.ok) {
        console.log(`[proxy] Upstream returned ${r.status} for segment, forcing refresh`);
        await forceRefresh();
        // Tell VLC to reload the playlist by returning an error
        res.writeHead(r.status);
        res.end('Segment unavailable — playlist refreshed');
        return;
      }

      const ct = r.headers.get('content-type') || '';
      if (ct.includes('mpegurl') || targetUrl.includes('m3u8')) {
        let body = await r.text();
        const rewritten = body.replace(/https?:\/\/[^\s"'<>]+/g, (match) => {
          return `/proxy?url=${encodeURIComponent(match)}`;
        });
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' });
        res.end(rewritten);
      } else {
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(200, {
          'Content-Type': ct || (targetUrl.includes('.ts') ? 'video/mp2t' : 'application/octet-stream'),
          'Content-Length': buf.length,
          'Access-Control-Allow-Origin': '*',
        });
        res.end(buf);
      }
    }
    else {
      res.writeHead(404);
      res.end('Open http://localhost:8765/play.m3u8 in VLC');
    }
  } catch (e) {
    console.error(`[proxy] ERROR: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end(e.message);
    }
  }
});

server.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`HLS Proxy: http://localhost:${PORT}/play.m3u8`);
  console.log(`========================================`);
  console.log(`M3U8 refresh interval: ${M3U8_MAX_AGE_MS/1000}s`);
  console.log(`Auto-refreshes on segment failure`);
  console.log(`Open VLC → Media → Open Network Stream → localhost:${PORT}/play.m3u8\n`);
});

// Proactive background refresh every 40s
setInterval(async () => {
  try {
    await getFreshM3u8();
  } catch(e) {
    console.error(`[proxy] Background refresh failed: ${e.message}`);
  }
}, 40_000);
