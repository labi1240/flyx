/**
 * Simple segment test with curl
 */

const { execSync } = require('child_process');

// Test segment URL
const url = 'https://dlhd.vynx-3b3.workers.dev/live/ts?url=aHR0cHM6Ly9jaGV2eS5kdmFsbmEucnUvOWFhNGE2YTZhMDZhNjA1Yzk1OWM&key=vynx';

console.log('Testing segment fetch with curl...');
console.log(`URL: ${url.substring(0, 80)}...`);

try {
  const result = execSync(`curl -s -w "\\n\\nHTTP_CODE: %{http_code}\\nTIME: %{time_total}s" "${url}"`, {
    encoding: 'utf8',
    timeout: 30000
  });
  console.log(result);
} catch (err) {
  console.error('Error:', err.message);
  if (err.stdout) console.log('stdout:', err.stdout);
  if (err.stderr) console.log('stderr:', err.stderr);
}
