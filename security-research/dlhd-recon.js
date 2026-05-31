/**
 * DLHD live-flow recon — May 2026
 * Loads the daddy.php player iframe directly in real Chromium with the proper
 * Referer, hooks fetch/XHR, and captures the full flow (server_lookup, m3u8, keys).
 */
const { chromium } = require('playwright');

const IFRAME_URL = process.argv[2] || 'https://donis.jimpenopisonline.online/premiumtv/daddy.php?id=32';
const REFERER = process.argv[3] || 'https://dlhd.pk/';
const RUN_MS = parseInt(process.argv[4] || '25000', 10);

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required', '--disable-popup-blocking'],
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 },
    extraHTTPHeaders: { 'Referer': REFERER },
  });

  // Hook fetch + XHR in every frame, log every URL the player requests
  await ctx.addInitScript(() => {
    const log = (tag, url, extra) => {
      try { console.log('NETHOOK ' + tag + ' ' + url + (extra ? ' ' + extra : '')); } catch (e) {}
    };
    const of = window.fetch;
    window.fetch = function (i, init) {
      const u = (typeof i === 'string') ? i : (i && i.url) || '';
      log('FETCH', u);
      return of.apply(this, arguments).then((r) => { log('FETCH_RESP', u, r.status); return r; });
    };
    const oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) {
      log('XHR', u, m);
      this.addEventListener('load', () => log('XHR_RESP', u, this.status));
      this.addEventListener('error', () => log('XHR_ERR', u));
      return oo.apply(this, arguments);
    };
  });

  const page = await ctx.newPage();

  // Auto-close ad popups (any page that is NOT the main one)
  ctx.on('page', async (p) => {
    if (p !== page) { try { await p.close(); } catch (e) {} }
  });

  // Block ad/popup domains that hijack the main frame
  const AD_RE = /(effectivecpmnetwork|cobnutscopsole|tabretwicht|jnbhi\.com|wherewindsmeet|easebar|googletag|google-analytics|doubleclick|popunder|histats|onclick|propeller|adsterra|monetag|disable-devtool)/i;
  await ctx.route('**/*', (route) => {
    if (AD_RE.test(route.request().url())) return route.abort();
    return route.continue();
  });

  const hits = [];
  ctx.on('response', async (resp) => {
    const u = resp.url();
    if (/(server_lookup|\.m3u8|mono\.css|\/proxy\/|\/key\/|auth|token|verify|newkso|\.ts(\?|$))/i.test(u) && !/ad|track|css\/|\.png|\.jpg|\.woff/i.test(u)) {
      let body = '';
      try { const ct = resp.headers()['content-type'] || ''; if (/json|text|mpegurl|octet|css|x-/i.test(ct) || /lookup|m3u8|mono|auth|verify/i.test(u)) body = (await resp.text()).slice(0, 300); } catch (e) {}
      console.log(`\n[RESP ${resp.status()}] ${u}`);
      console.log(`   server=${resp.headers()['server']||''} cf-ray=${resp.headers()['cf-ray']||''} ct=${resp.headers()['content-type']||''}`);
      if (body) console.log(`   body: ${body.replace(/\n/g,'\\n')}`);
      hits.push(u);
    }
  });

  page.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('NETHOOK')) console.log('  ' + t);
    else if (/error|fail|m3u8|server|premium|auth|key/i.test(t)) console.log('[PAGE] ' + t.slice(0, 160));
  });
  page.on('pageerror', (e) => console.log('[PAGEERR] ' + e.message.slice(0, 160)));

  console.log(`\n=== Loading iframe ${IFRAME_URL} (ref ${REFERER}) ===`);
  try { await page.goto(IFRAME_URL, { waitUntil: 'commit', timeout: 30000 }); }
  catch (e) { console.log('goto: ' + e.message); }

  await page.waitForTimeout(2500);
  try { await page.mouse.click(640, 360); } catch (e) {}
  try { await page.evaluate(() => document.querySelectorAll('video').forEach(v => v.play && v.play().catch(()=>{}))); } catch (e) {}

  console.log(`\n=== waiting ${RUN_MS}ms ===`);
  await page.waitForTimeout(RUN_MS);

  console.log(`\n=== ${hits.length} stream-related responses captured ===`);
  await browser.close();
})();
