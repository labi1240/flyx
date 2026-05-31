/**
 * End-to-end playback proof: load hls.js against the local /play v8 endpoint,
 * assert the video actually decodes (currentTime advances + fragments buffer).
 */
const { chromium } = require('playwright');

const PORT = process.argv[2] || 8799;
const CH = process.argv[3] || '32';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  let fatal = null, manifest = false, fragResps = 0;
  page.on('console', (m) => { const t = m.text(); if (/error|fatal|hls/i.test(t)) console.log('[page]', t.slice(0,160)); });
  ctx.on('response', (r) => { if (/tomompakis|\.pdf|\.png|\.zst|ingest/i.test(r.url())) fragResps++; });

  console.log(`Loading hls.html?ch=${CH} ...`);
  await page.goto(`http://localhost:${PORT}/hls.html?ch=${CH}`, { waitUntil: 'domcontentloaded' });

  // Sample playback state over ~20s
  const samples = [];
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(2000);
    const s = await page.evaluate(() => {
      const v = document.getElementById('v');
      return {
        t: +v.currentTime.toFixed(2),
        buffered: v.buffered.length ? +v.buffered.end(v.buffered.length - 1).toFixed(2) : 0,
        readyState: v.readyState,
        vw: v.videoWidth, vh: v.videoHeight,
        st: window.__state,
      };
    });
    samples.push(s);
    console.log(`t=${s.t}s buffered=${s.buffered}s ready=${s.readyState} ${s.vw}x${s.vh} frags=${s.st.frag} manifest=${s.st.manifest} fatal=${s.st.fatal || '-'}`);
    if (s.st.fatal) fatal = s.st.fatal;
  }

  const first = samples[0], last = samples[samples.length - 1];
  const advanced = last.t > first.t && last.t > 0.5;
  const decoded = last.vw > 0 && last.vh > 0;
  const buffered = last.buffered > 0;
  console.log('\n=== VERDICT ===');
  console.log(`currentTime advanced: ${advanced} (${first.t} → ${last.t})`);
  console.log(`video decoded (dimensions): ${decoded} (${last.vw}x${last.vh})`);
  console.log(`buffered ahead: ${buffered} (${last.buffered}s)`);
  console.log(`fragment responses seen: ${fragResps}`);
  console.log(`fatal error: ${fatal || 'none'}`);
  console.log(advanced && decoded ? '\n✅ PLAYBACK CONFIRMED' : '\n❌ PLAYBACK FAILED');

  await browser.close();
  process.exit(advanced && decoded ? 0 : 1);
})();
