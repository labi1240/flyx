const path = require('path');
const { chromium } = require('playwright');
const EXT = path.resolve(__dirname, '..', 'browser-extension');
(async () => {
  const ctx = await chromium.launchPersistentContext('', { headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'], viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const KEEP = /\[VideoPlayer\]|\[Flyx|Stream URL|Stall|reload|Recover|Network error|stuck|HLS Error/i;
  page.on('console', (m) => { const t = m.text(); if (KEEP.test(t)) console.log('  ' + t.slice(0, 200)); });
  await page.goto('http://localhost:3000/livetv', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Click the DLHD provider chip
  const chips = await page.$$('[data-tv-focusable="true"]');
  for (const c of chips) { const tx = await c.innerText().catch(() => ''); if (/DLHD/i.test(tx)) { console.log('clicking DLHD chip:', tx.replace(/\n/g, ' ')); await c.click(); break; } }
  await page.waitForTimeout(3500);

  // Re-query; find a channel card (skip nav + chips by looking for ones past index 38)
  let cards = await page.$$('[data-tv-focusable="true"]');
  console.log('cards now:', cards.length);
  for (let i = 38; i < Math.min(cards.length, 50); i++) { const txt = (await cards[i].innerText().catch(() => '')).replace(/\n/g, ' | ').slice(0, 50); console.log(`  [${i}] ${txt}`); }
  const idx = parseInt(process.env.IDX || '40', 10);
  console.log('clicking channel card', idx);
  await cards[idx].click();

  // Watch playback + logs for 45s
  let last = -1;
  for (let i = 0; i < 18; i++) {
    await page.waitForTimeout(2500);
    const s = await page.evaluate(() => { const v = document.querySelector('video'); if (!v) return null; return { t: +v.currentTime.toFixed(2), buf: v.buffered.length ? +(v.buffered.end(v.buffered.length - 1) - v.currentTime).toFixed(2) : 0, paused: v.paused, rs: v.readyState, vw: v.videoWidth }; });
    if (!s) { console.log(`[${(i * 2.5).toFixed(0)}s] no <video>`); continue; }
    const stalled = s.t > 0 && s.t <= last + 0.05 && !s.paused;
    console.log(`[${(i * 2.5).toFixed(0)}s] t=${s.t}s bufAhead=${s.buf}s rs=${s.rs} ${s.vw}px${stalled ? '  <-- STALL' : ''}`);
    last = s.t;
  }
  await ctx.close();
})();
