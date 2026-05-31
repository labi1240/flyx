/** Throttled playback test — does a constrained connection reproduce the ~10s stall? */
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');
const EXT = path.resolve(__dirname, '..', 'browser-extension');
const CH = process.argv[2] || '32';
const MBPS = parseFloat(process.argv[3] || '8');
const PLAY = `https://dlhd.vynx-3b3.workers.dev/play/${CH}?key=vynx`;

const PAGE = `<!doctype html><html><head><meta charset=utf8></head><body style="margin:0;background:#000">
<video id=v autoplay muted playsinline style="width:100%;height:100vh"></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.6.15/dist/hls.min.js"></script>
<script>
const v=document.getElementById('v'); window.__stalls=0;
const hls=new Hls({enableWorker:true,lowLatencyMode:false,backBufferLength:60,maxBufferLength:45,maxMaxBufferLength:90,maxBufferSize:60000000,maxBufferHole:0.5,liveSyncDurationCount:4,liveMaxLatencyDurationCount:12,liveDurationInfinity:true,fragLoadingMaxRetry:30,nudgeOffset:0.2,nudgeMaxRetry:10});
hls.loadSource(${JSON.stringify(PLAY)}); hls.attachMedia(v);
hls.on(Hls.Events.MANIFEST_PARSED,()=>v.play().catch(()=>{}));
v.addEventListener('waiting',()=>{window.__stalls++;});
</script></body></html>`;

(async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); });
  await new Promise((r) => server.listen(3000, r));
  const ctx = await chromium.launchPersistentContext('', { headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'] });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: (MBPS * 1000 * 1000) / 8, uploadThroughput: 1000000 });
  console.log(`Throttled to ${MBPS} Mbps (stream is ~7-9.6 Mbps single-variant)`);
  await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });

  let lastT = 0;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(3000);
    const s = await page.evaluate(() => { const v = document.getElementById('v'); return { t: +v.currentTime.toFixed(2), buf: v.buffered.length ? +(v.buffered.end(v.buffered.length-1)-v.currentTime).toFixed(2) : 0, stalls: window.__stalls }; });
    const stalled = (s.t <= lastT + 0.1);
    console.log(`t=${s.t}s (+${(s.t-lastT).toFixed(2)}) bufferAhead=${s.buf}s waitingEvents=${s.stalls}${stalled ? '  <-- NOT ADVANCING' : ''}`);
    lastT = s.t;
  }
  await ctx.close(); server.close();
})();
