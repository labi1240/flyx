// Local validation of the v8 DLHD extraction flow (mirrors src/direct/dlhd-v8.ts)
const STREAM_DOMAINS = ['dlhd.pk', 'dlhd.sx', 'dlstreams.com'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

async function findPlayerIframe(id) {
  for (const domain of STREAM_DOMAINS) {
    const streamUrl = `https://${domain}/stream/stream-${id}.php`;
    try {
      const resp = await fetch(streamUrl, { headers: { 'User-Agent': UA, 'Referer': `https://${domain}/`, 'Accept': 'text/html,*/*' } });
      if (!resp.ok) { console.log(`  ${streamUrl} → ${resp.status}`); continue; }
      const html = await resp.text();
      const m = html.match(/<iframe[^>]+src=["']([^"']*\/premiumtv\/daddy\d*\.php\?id=[^"']+)["']/i);
      if (m) { console.log(`  iframe via ${domain}: ${m[1]}`); return m[1]; }
    } catch (e) { console.log(`  ${streamUrl} ERR ${e.message}`); }
  }
  return null;
}

async function extractSignedMaster(playerUrl) {
  const resp = await fetch(playerUrl, { headers: { 'User-Agent': UA, 'Referer': 'https://dlhd.pk/', 'Accept': 'text/html,*/*' } });
  if (!resp.ok) { console.log(`  daddy.php → ${resp.status}`); return null; }
  const html = await resp.text();
  for (const mm of html.matchAll(/atob\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/g)) {
    try {
      const decoded = Buffer.from(mm[1], 'base64').toString('utf8');
      if (/^https?:\/\/\S+\.m3u8/i.test(decoded)) return decoded.trim();
    } catch {}
  }
  return null;
}

(async () => {
  const id = process.argv[2] || '32';
  console.log(`=== Resolving DLHD channel ${id} ===`);
  const playerUrl = await findPlayerIframe(id);
  if (!playerUrl) return console.log('FAIL: no iframe');
  const master = await extractSignedMaster(playerUrl);
  if (!master) return console.log('FAIL: no signed master');
  console.log(`MASTER: ${master}`);

  const r = await fetch(master, { headers: { 'User-Agent': UA, 'Accept': '*/*' } });
  const body = await r.text();
  console.log(`master fetch → ${r.status}, ${body.length}b, ACAO=${r.headers.get('access-control-allow-origin')}`);
  const playlist = body.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    try { return new URL(t, master).toString(); } catch { return line; }
  }).join('\n');
  console.log('=== REWRITTEN PLAYLIST ===');
  console.log(playlist);
})();
