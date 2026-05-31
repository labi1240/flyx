/** Playback proof against the PRODUCTION worker. */
const { chromium } = require('playwright');
const CH = process.argv[2] || '32';
const PLAY = `https://dlhd.vynx-3b3.workers.dev/play/${CH}?key=vynx`;

const PAGE = `<!doctype html><html><head><meta charset=utf8></head><body style="margin:0;background:#000">
<video id=v autoplay muted playsinline style="width:100%;height:100vh"></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"></script>
<script>
const v=document.getElementById('v'); window.__s={fatal:null,manifest:false,frag:0};
if(Hls.isSupported()){const h=new Hls();h.loadSource(${JSON.stringify(PLAY)});h.attachMedia(v);
h.on(Hls.Events.MANIFEST_PARSED,()=>{window.__s.manifest=true;v.play().catch(()=>{});});
h.on(Hls.Events.FRAG_BUFFERED,()=>{window.__s.frag++;});
h.on(Hls.Events.ERROR,(e,d)=>{if(d.fatal)window.__s.fatal=d.type+':'+d.details;});}
</script></body></html>`;

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.goto('https://dlhd.vynx-3b3.workers.dev/health', { waitUntil: 'domcontentloaded' }).catch(()=>{});
  await page.setContent(PAGE, { waitUntil: 'domcontentloaded' });
  let fatal=null;
  for (let i=0;i<8;i++){
    await page.waitForTimeout(2000);
    const s=await page.evaluate(()=>{const v=document.getElementById('v');return{t:+v.currentTime.toFixed(2),buf:v.buffered.length?+v.buffered.end(v.buffered.length-1).toFixed(2):0,vw:v.videoWidth,vh:v.videoHeight,s:window.__s};});
    console.log(`t=${s.t}s buffered=${s.buf}s ${s.vw}x${s.vh} frags=${s.s.frag} manifest=${s.s.manifest} fatal=${s.s.fatal||'-'}`);
    if(s.s.fatal)fatal=s.s.fatal;
  }
  const last=await page.evaluate(()=>{const v=document.getElementById('v');return{t:v.currentTime,vw:v.videoWidth,vh:v.videoHeight};});
  const ok=last.t>0.5 && last.vw>0 && !fatal;
  console.log(`\n${ok?'✅ PROD PLAYBACK CONFIRMED':'❌ FAILED'} (t=${last.t.toFixed(1)}s ${last.vw}x${last.vh} fatal=${fatal||'none'})`);
  await browser.close();
  process.exit(ok?0:1);
})();
