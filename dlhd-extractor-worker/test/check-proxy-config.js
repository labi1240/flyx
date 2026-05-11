/**
 * Check if proxy config endpoint exists
 */

async function debug() {
  // Hit the root endpoint to see if worker is responding
  const res = await fetch('https://dlhd.vynx-3b3.workers.dev/', {
    headers: { 'X-API-Key': 'vynx' }
  });
  
  console.log('Root endpoint:', res.status);
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

debug().catch(console.error);
