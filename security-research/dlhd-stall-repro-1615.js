/**
 * Reproduce the ~10s stall using the EXACT livetv VideoPlayer hls.js config.
 * Loads via the extension, runs 90s, logs stalls / nudges / currentTime continuity.
 */
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');
const EXT = path.resolve(__dirname, '..', 'browser-extension');
const CH = process.argv[2] || '32';
const PLAY = `https://dlhd.vynx-3b3.workers.dev/play/${CH}?key=vynx`;

const PAGE = `<!doctype html><html><head><meta charset=utf8></head><body style="margin:0;background:#000">
<video id=v autoplay muted playsinline style="width:100%;height:100vh"></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.6.15/dist/hls.min.js"></script>
<script>
window.__log=[]; const log=(...a)=>{window.__log.push(a.join(' '));console.log('[HLS]',...a);};
const v=document.getElementById('v');
// EXACT config from app/(routes)/livetv/components/VideoPlayer.tsx
const hls=new Hls({
  enableWorker:true, lowLatencyMode:false,
  backBufferLength:60, maxBufferLength:45, maxMaxBufferLength:90,
  maxBufferSize:60*1000*1000, maxBufferHole:0.5,
  liveSyncDurationCount:4, liveMaxLatencyDurationCount:12, liveDurationInfinity:true,
  manifestLoadingMaxRetry:20, manifestLoadingRetryDelay:800, manifestLoadingMaxRetryTimeout:60000,
  levelLoadingMaxRetry:20, levelLoadingRetryDelay:800, levelLoadingMaxRetryTimeout:60000,
  fragLoadingMaxRetry:30, fragLoadingRetryDelay:500, fragLoadingMaxRetryTimeout:60000,
  abrEwmaDefaultEstimate:1000000, abrBandWidthFactor:0.7, abrBandWidthUpFactor:0.5, abrMaxWithRealBitrate:true,
  nudgeOffset:0.2, nudgeMaxRetry:10,
  xhrSetup:(xhr)=>{xhr.timeout=30000;},
});
hls.loadSource(${JSON.stringify(PLAY)});
hls.attachMedia(v);
hls.on(Hls.Events.MANIFEST_PARSED,()=>{v.play().catch(()=>{});});
hls.on(Hls.Events.ERROR,(e,d)=>{log('ERR',d.type,d.details,'fatal='+d.fatal);});
v.addEventListener('waiting',()=>log('video:waiting @'+v.currentTime.toFixed(2)));
v.addEventListener('stalled',()=>log('video:stalled @'+v.currentTime.toFixed(2)));
v.addEventListener('playing',()=>log('video:playing @'+v.currentTime.toFixed(2)));
</script></body></html>`;

(async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); });
  await new Promise((r) => server.listen(3000, r));
  const ctx = await chromium.launchPersistentContext('', { headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'] });
  const page = await ctx.newPage();
  await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });

  let lastT = 0, stalls = 0;
  for (let i = 0; i < 30; i++) { // 90s
    await page.waitForTimeout(3000);
    const s = await page.evaluate(() => { const v = document.getElementById('v'); return { t: +v.currentTime.toFixed(2), buf: v.buffered.length ? +(v.buffered.end(v.buffered.length-1)-v.currentTime).toFixed(2) : 0, paused: v.paused, ready: v.readyState }; });
    const advanced = (s.t - lastT).toFixed(2);
    const stalled = (s.t <= lastT + 0.1) && !s.paused;
    if (stalled) stalls++;
    console.log(`t=${s.t}s (+${advanced}) bufferAhead=${s.buf}s ready=${s.ready} paused=${s.paused}${stalled ? '  <-- STALL' : ''}`);
    lastT = s.t;
  }
  const logs = await page.evaluate(() => window.__log);
  console.log('\n=== hls/video events ===');
  logs.slice(-40).forEach((l) => console.log('  ' + l));
  console.log(`\nstall samples: ${stalls}/30`);
  await ctx.close(); server.close();
})();
