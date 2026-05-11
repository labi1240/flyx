const fs = require('fs');
const files = [
  'player-videasy-9219-real.js',
  'player-videasy-1470-chunk.js',
  'player-videasy-2679-chunk.js',
  'player-videasy-app-chunk.js',
  'player-videasy-movie-chunk.js'
];

const patterns = [
  'downloader', 'sources-with-title', 'flixhq', 'FLIXHQ',
  'CORS_PROXY', 'b35ebba4', 'tmdbId', 'wasm', 'WASM',
  'extractAll', 'getSources', 'fetchSources', 'sources',
  'imdbId', 'totalSeasons', 'api\\.videasy',
  'AES\\.decrypt', 'CryptoJS', 'Hashids', 'encode\\(', 'decode\\(',
  'module\\.wasm', 'window\\.hash', 'serve\\(', 'verify\\(',
  'decrypt\\(', 'encrypt\\('
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
        // Deduplicate
        const key = m.substring(0, 80);
        if (!seen.has(key)) {
          seen.add(key);
          count++;
          console.log(`  [${p}]: ...${m.substring(0, 500)}...`);
        }
      }
      if (count > 0) console.log(`  (${count} shown)`);
    } catch(e) {
      // skip
    }
  }
}
