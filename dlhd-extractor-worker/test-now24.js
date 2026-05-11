// Test: verify player6 extraction + URL rewriting produces proxied /dlhdprivate URLs
// This simulates what the worker does — extract, rewrite, verify format
const https = require('https');

function httpsReq(url, headers = {}, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', ...headers },
      timeout, family: 4,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

const WORKER_BASE = 'https://dlhd.vynx-3b3.workers.dev';
const FAKE_JWT = 'test-jwt-token-placeholder-12345';
const REFERER = 'https://lovetier.bz/';

function proxyUrl(upstream) {
  const u = new URL('/dlhdprivate', WORKER_BASE);
  u.searchParams.set('url', upstream);
  u.searchParams.set('jwt', FAKE_JWT);
  u.searchParams.set('ref', REFERER);
  return u.toString();
}

async function testPlayer6Rewrite(ch, streamName) {
  console.log(`\n--- ch${ch} (${streamName}) ---`);
  try {
    // Step 1: Extract stream URL from lovetier.bz
    const resp = await httpsReq(`https://lovetier.bz/player/${streamName}`, { 'Referer': 'https://lovecdn.ru/' });
    const html = resp.data.toString('utf8');
    const match = html.match(/streamUrl:\s*"([^"]+)"/);
    if (!match) { console.log('  ❌ No streamUrl found'); return false; }
    const masterUrl = match[1].replace(/\\\//g, '/');
    console.log(`  Master: ${masterUrl.substring(0, 100)}...`);

    // Step 2: Fetch master playlist
    const master = await httpsReq(masterUrl, { 'Referer': REFERER });
    if (master.status !== 200) { console.log(`  ❌ Master ${master.status}`); return false; }
    const masterText = master.data.toString('utf8');
    if (!masterText.includes('#EXTM3U')) { console.log('  ❌ Not M3U8'); return false; }

    // Step 3: Get media playlist
    const mediaPath = masterText.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim();
    const masterBase = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1);
    const mediaUrl = mediaPath.startsWith('http') ? mediaPath : masterBase + mediaPath;
    const media = await httpsReq(mediaUrl, { 'Referer': REFERER });
    if (media.status !== 200) { console.log(`  ❌ Media ${media.status}`); return false; }
    const mediaText = media.data.toString('utf8');

    // Step 4: Rewrite URLs (same logic as player6.ts)
    const mediaBase = mediaUrl.substring(0, mediaUrl.lastIndexOf('/') + 1);
    const lines = mediaText.split('\n');
    const rewritten = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const abs = trimmed.startsWith('http') ? trimmed : mediaBase + trimmed;
      return proxyUrl(abs);
    });

    const finalPlaylist = rewritten.join('\n');
    
    // Verify: ALL non-comment lines should be /dlhdprivate URLs
    const segLines = rewritten.filter(l => l.trim() && !l.trim().startsWith('#'));
    const allProxied = segLines.every(l => l.includes('/dlhdprivate'));
    const noDirect = segLines.every(l => !l.includes('planetary.lovecdn.ru') || l.includes('/dlhdprivate'));
    
    console.log(`  Segments: ${segLines.length}`);
    console.log(`  All proxied: ${allProxied ? '✅' : '❌'}`);
    console.log(`  No direct upstream: ${noDirect ? '✅' : '❌'}`);
    console.log(`  Sample: ${segLines[0]?.substring(0, 120)}...`);
    
    return allProxied && noDirect;
  } catch (e) {
    console.log(`  ❌ ERROR: ${e.message}`);
    return false;
  }
}

async function testMoveonjoyRewrite(ch, masterUrl, name) {
  console.log(`\n--- ch${ch} ${name} (moveonjoy) ---`);
  try {
    const master = await httpsReq(masterUrl);
    if (master.status !== 200) { console.log(`  ❌ Master ${master.status}`); return false; }
    const masterText = master.data.toString('utf8');
    const mediaPath = masterText.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim();
    const baseUrl = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1);
    const mediaUrl = mediaPath.startsWith('http') ? mediaPath : baseUrl + mediaPath;
    const media = await httpsReq(mediaUrl);
    if (media.status !== 200) { console.log(`  ❌ Media ${media.status}`); return false; }
    const mediaText = media.data.toString('utf8');

    const mediaBase = mediaUrl.substring(0, mediaUrl.lastIndexOf('/') + 1);
    const lines = mediaText.split('\n');
    // Moveonjoy proxyUrl doesn't use ref param
    const rewritten = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const abs = trimmed.startsWith('http') ? trimmed : mediaBase + trimmed;
      const u = new URL('/dlhdprivate', WORKER_BASE);
      u.searchParams.set('url', abs);
      u.searchParams.set('jwt', FAKE_JWT);
      return u.toString();
    });

    const segLines = rewritten.filter(l => l.trim() && !l.trim().startsWith('#'));
    const allProxied = segLines.every(l => l.includes('/dlhdprivate'));
    console.log(`  Segments: ${segLines.length}, all proxied: ${allProxied ? '✅' : '❌'}`);
    console.log(`  Sample: ${segLines[0]?.substring(0, 120)}...`);
    return allProxied;
  } catch (e) {
    console.log(`  ❌ ERROR: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log('=== Player6 + Moveonjoy URL Rewrite Verification ===');
  console.log('Time:', new Date().toISOString());

  let pass = 0, fail = 0;

  // Player 6 tests
  const p6Tests = [
    ['44', 'ESPN'], ['35', 'SkySportsFootballUK'], ['45', 'ESPN2'],
    ['130', 'skysportspremierleague'], ['405', 'NFLNETWORK'],
  ];
  for (const [ch, name] of p6Tests) {
    const ok = await testPlayer6Rewrite(ch, name);
    if (ok) pass++; else fail++;
  }

  // Moveonjoy tests
  const movTests = [
    ['51', 'https://fl1.moveonjoy.com/AL_BIRMINGHAM_ABC/index.m3u8', 'ABC'],
    ['321', 'https://fl61.moveonjoy.com/HBO/index.m3u8', 'HBO'],
    ['44', 'https://fl2.moveonjoy.com/ESPN/index.m3u8', 'ESPN'],
  ];
  for (const [ch, url, name] of movTests) {
    const ok = await testMoveonjoyRewrite(ch, url, name);
    if (ok) pass++; else fail++;
  }

  console.log(`\n=== Results: ${pass} pass, ${fail} fail ===`);
}

main().catch(console.error);
