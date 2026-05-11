const fs = require('fs');
const files = [
  'player-videasy-anime-chunk.js',
  'player-videasy-tv-chunk.js',
  'player-videasy-1862-chunk.js',
  'player-videasy-927-chunk.js',
  'player-videasy-8601-chunk.js',
  'player-videasy-app-chunk.js',
];

const patterns = [
  'downloader', 'sources-with-title', 'flixhq', 'FLIXHQ',
  'CORS_PROXY', 'b35ebba4', 'wasm', 'WASM', 'module\\.wasm',
  'AES\\.decrypt', 'CryptoJS', 'decrypt\\(', 'encrypt\\(',
  'window\\.hash', 'serve\\(', 'verify\\(', 'Hashids',
  'api\\.videasy', 'backend\\.videasy',
  'getSources', 'fetchSources', 'sources:', 'sources\\[',
  'subtitles', 'extractAll', 'extract',
  'Wg\\(', 'axios', 'fetch\\(', 'XMLHttpRequest',
  'baseURL', 'baseUrl'
];

for (const file of files) {
  const path = `C:/Users/Nicks/Desktop/Flyx-main/${file}`;
  if (!fs.existsSync(path)) { console.log(`MISSING: ${file}`); continue; }
  const content = fs.readFileSync(path, 'utf8');
  console.log(`\n========== ${file} (${content.length} bytes) ==========`);

  for (const p of patterns) {
    try {
      const re = new RegExp('.{0,200}' + p + '.{0,200}', 'gi');
      let match;
      let count = 0;
      const seen = new Set();
      while ((match = re.exec(content)) !== null && count < 3) {
        const m = match[0];
        const key = m.substring(0, 80);
        if (!seen.has(key)) {
          seen.add(key);
          count++;
          console.log(`  [${p}]: ${m.substring(0, 600)}`);
        }
      }
    } catch(e) {
      // skip
    }
  }
}
