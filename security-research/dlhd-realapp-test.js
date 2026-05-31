/**
 * Drive the REAL livetv player (dev server) with the extension loaded.
 * Opens a DLHD channel and captures the production [VideoPlayer] recovery logs
 * + playback timeline to see what happens at ~10s.
 */
const path = require('path');
const { chromium } = require('playwright');
const EXT = path.resolve(__dirname, '..', 'browser-extension');

(async () => {
  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'],
    viewport: { width: 1400, height: 900 },
  });
  const page = await ctx.newPage();
  const KEEP = /\[VideoPlayer\]|\[Flyx|\[proxy-config\]|\[HLS\]|HLS Error|Stall|reload|Recover|Network error|stuck|buffer/i;
  page.on('console', (m) => { const t = m.text(); if (KEEP.test(t)) console.log('  ' + t.slice(0, 200)); });
  page.on('pageerror', (e) => console.log('  [pageerror] ' + e.message.slice(0, 160)));

  console.log('navigating to /livetv ...');
  await page.goto('http://localhost:3000/livetv', { waitUntil: 'domcontentloaded' });

  // Wait for channel cards
  await page.waitForSelector('[data-tv-focusable="true"]', { timeout: 30000 }).catch(() => console.log('no cards appeared'));
  await page.waitForTimeout(2000);

  // Click cards until the player logs a DLHD /play URL
  const cards = await page.$$('[data-tv-focusable="true"]');
  console.log(`found ${cards.length} focusable cards; clicking first to open player`);
  if (cards.length) await cards[0].click();

  // Watch playback for 45s
  let last = -1;
  for (let i = 0; i < 18; i++) {
    await page.waitForTimeout(2500);
    const s = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return null;
      return { t: +v.currentTime.toFixed(2), buf: v.buffered.length ? +(v.buffered.end(v.buffered.length-1)-v.currentTime).toFixed(2) : 0, paused: v.paused, rs: v.readyState, vw: v.videoWidth };
    });
    if (!s) { console.log(`[${i*2.5}s] no <video> yet`); continue; }
    const stalled = s.t > 0 && s.t <= last + 0.05 && !s.paused;
    console.log(`[${(i*2.5).toFixed(0)}s] t=${s.t}s bufAhead=${s.buf}s rs=${s.rs} ${s.vw}px${stalled ? '  <-- STALL' : ''}`);
    last = s.t;
  }

  await ctx.close();
})();
