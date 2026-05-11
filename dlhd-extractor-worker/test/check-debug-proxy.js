/**
 * Check debug proxy endpoint
 */

async function debug() {
  const res = await fetch('https://dlhd.vynx-3b3.workers.dev/debug/proxy', {
    headers: { 'X-API-Key': 'vynx' }
  });
  
  console.log('Status:', res.status);
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

debug().catch(console.error);
