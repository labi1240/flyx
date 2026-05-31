/**
 * Local stand-in for the worker /play/:id endpoint, running the v8 DLHD flow.
 * Lets us verify real hls.js playback end-to-end without a production deploy.
 */
const http = require('http');
const STREAM_DOMAINS = ['dlhd.pk', 'dlhd.sx', 'dlstreams.com'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

async function findPlayerIframe(id) {
  for (const domain of STREAM_DOMAINS) {
    try {
      const resp = await fetch(`https://${domain}/stream/stream-${id}.php`, {
        headers: { 'User-Agent': UA, 'Referer': `https://${domain}/`, 'Accept': 'text/html,*/*' },
      });
      if (!resp.ok) continue;
      const html = await resp.text();
      const m = html.match(/<iframe[^>]+src=["']([^"']*\/premiumtv\/daddy\d*\.php\?id=[^"']+)["']/i);
      if (m) return m[1];
    } catch {}
  }
  return null;
}

async function extractSignedMaster(playerUrl) {
  const resp = await fetch(playerUrl, { headers: { 'User-Agent': UA, 'Referer': 'https://dlhd.pk/', 'Accept': 'text/html,*/*' } });
  if (!resp.ok) return null;
  const html = await resp.text();
  for (const mm of html.matchAll(/atob\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/g)) {
    try {
      const decoded = Buffer.from(mm[1], 'base64').toString('utf8');
      if (/^https?:\/\/\S+\.m3u8/i.test(decoded)) return decoded.trim();
    } catch {}
  }
  return null;
}

async function buildPlaylist(id) {
  const playerUrl = await findPlayerIframe(id);
  if (!playerUrl) return null;
  const master = await extractSignedMaster(playerUrl);
  if (!master) return null;
  const r = await fetch(master, { headers: { 'User-Agent': UA, 'Accept': '*/*' } });
  if (!r.ok) return null;
  const body = await r.text();
  if (!body.includes('#EXTM3U')) return null;
  const playlist = body.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    try { return new URL(t, master).toString(); } catch { return line; }
  }).join('\n');
  return { playlist, masterUrl: master };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const m = u.pathname.match(/^\/play\/(\d+)/);
  if (u.pathname === '/hls.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(HLS_PAGE);
  }
  if (!m) { res.writeHead(404); return res.end('nope'); }
  try {
    const r = await buildPlaylist(m[1]);
    if (!r) { res.writeHead(502, { 'Access-Control-Allow-Origin': '*' }); return res.end('#EXTM3U\n# extraction failed'); }
    console.log(`[/play/${m[1]}] → ${r.masterUrl}`);
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(r.playlist);
  } catch (e) {
    res.writeHead(500, { 'Access-Control-Allow-Origin': '*' }); res.end(String(e));
  }
});

const HLS_PAGE = `<!doctype html><html><head><meta charset=utf8></head><body style="margin:0;background:#000">
<video id=v autoplay muted playsinline style="width:100%;height:100vh"></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"></script>
<script>
const ch = new URLSearchParams(location.search).get('ch') || '32';
const v = document.getElementById('v');
window.__state = { fatal:null, level:false, frag:0, manifest:false };
if (Hls.isSupported()) {
  const hls = new Hls({ debug:false, lowLatencyMode:false });
  hls.loadSource('/play/' + ch);
  hls.attachMedia(v);
  hls.on(Hls.Events.MANIFEST_PARSED, () => { window.__state.manifest = true; v.play().catch(()=>{}); });
  hls.on(Hls.Events.LEVEL_LOADED, () => { window.__state.level = true; });
  hls.on(Hls.Events.FRAG_BUFFERED, () => { window.__state.frag++; });
  hls.on(Hls.Events.ERROR, (e, d) => { if (d.fatal) window.__state.fatal = d.type + ':' + d.details; });
}
</script></body></html>`;

const PORT = process.argv[2] || 8799;
server.listen(PORT, () => console.log(`local /play server on http://localhost:${PORT}  (try /hls.html?ch=32)`));
