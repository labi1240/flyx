/**
 * End-to-end test of the Flyx Bypass extension DLHD path.
 * Serves an hls.js page on localhost:3000 that loads the worker /play URL via the
 * default XHR loader (so inject.js intercepts it → bridge → SW mints from the
 * browser's residential IP). Asserts real playback.
 */
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const EXT = path.resolve(__dirname, '..', 'browser-extension');
const CH = process.argv[2] || '32';
const PLAY = `https://dlhd.vynx-3b3.workers.dev/play/${CH}?key=vynx`;

const PAGE = `<!doctype html><html><head><meta charset=utf8></head><body style="margin:0;background:#000">
<video id=v autoplay muted playsinline style="width:100%;height:100vh"></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"></script>
<script>
window.__s={fatal:null,manifest:false,frag:0};
const v=document.getElementById('v');
if(Hls.isSupported()){
  const h=new Hls({enableWorker:false}); // force main-thread XHR so inject.js sees it
  h.loadSource(${JSON.stringify(PLAY)});
  h.attachMedia(v);
  h.on(Hls.Events.MANIFEST_PARSED,()=>{window.__s.manifest=true;v.play().catch(()=>{});});
  h.on(Hls.Events.FRAG_BUFFERED,()=>{window.__s.frag++;});
  h.on(Hls.Events.ERROR,(e,d)=>{if(d.fatal)window.__s.fatal=d.type+':'+d.details;});
}
</script></body></html>`;

(async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); });
  await new Promise((r) => server.listen(3000, r));
  console.log('test page on http://localhost:3000');

  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'],
  });

  // Surface SW logs
  ctx.on('serviceworker', (sw) => console.log('[SW registered]', sw.url()));
  for (const sw of ctx.serviceWorkers()) console.log('[SW existing]', sw.url());

  const page = await ctx.newPage();
  page.on('console', (m) => { const t = m.text(); if (/flyx|dlhd|error|fail|hls/i.test(t)) console.log('[page]', t.slice(0, 200)); });

  await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });

  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(2500);
    const s = await page.evaluate(() => {
      const v = document.getElementById('v');
      return { t: +v.currentTime.toFixed(2), buf: v.buffered.length ? +v.buffered.end(v.buffered.length - 1).toFixed(2) : 0, vw: v.videoWidth, vh: v.videoHeight, s: window.__s };
    });
    console.log(`t=${s.t}s buffered=${s.buf}s ${s.vw}x${s.vh} frags=${s.s.frag} manifest=${s.s.manifest} fatal=${s.s.fatal || '-'}`);
  }

  const last = await page.evaluate(() => { const v = document.getElementById('v'); return { t: v.currentTime, vw: v.videoWidth, vh: v.videoHeight, s: window.__s }; });
  const ok = last.t > 0.5 && last.vw > 0 && !last.s.fatal;
  console.log(`\n${ok ? '✅ EXTENSION DLHD PLAYBACK CONFIRMED' : '❌ FAILED'} (t=${last.t.toFixed(1)}s ${last.vw}x${last.vh} fatal=${last.s.fatal || 'none'})`);

  await ctx.close();
  server.close();
  process.exit(ok ? 0 : 1);
})();
