/**
 * MegaUp Keystream Derivation Analysis
 *
 * Collects encrypted data from MegaUp /media/{videoId} and plaintext from
 * enc-dec.app for multiple video IDs. XOR-derives per-video keystreams and
 * analyzes the relationship to reverse-engineer the derivation algorithm.
 *
 * Run: bun run tests/anime/derive-keystream.ts
 */

const MEGAUP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const ENCDEC_API = 'https://enc-dec.app/api/dec-mega';

// Known video IDs collected from AnimeKai extraction
const VIDEO_IDS = [
  // One Punch Man Ep 1 (different servers)
  { id: 'jIrrLzj-WS2JcOLzF79O5xvpCQ', host: 'megaup22.online', label: 'OPM-E1-Server1' },
];

// We'll discover more video IDs from actual extraction runs
async function discoverVideoIds(): Promise<Array<{id: string, host: string, label: string}>> {
  // First, run extraction to get MegaUp URLs
  const { extractAnimeKaiStreams } = await import('@/app/lib/services/animekai-extractor');

  // Try a few different anime to collect diverse video IDs
  const targets = [
    { malId: 30276, title: 'One Punch Man', type: 'tv', episode: 1 },
    { malId: 199, title: 'Spirited Away', type: 'movie' },
    { malId: 5114, title: 'Fullmetal Alchemist: Brotherhood', type: 'tv', episode: 1 },
    { malId: 1535, title: 'Death Note', type: 'tv', episode: 1 },
  ];

  const discovered: Array<{id: string, host: string, label: string}> = [];

  for (const target of targets) {
    console.log(`\n=== Discovering video IDs from: ${target.title} ===`);
    try {
      const result = await extractAnimeKaiStreams(
        '0',
        target.type as 'tv' | 'movie',
        target.type === 'tv' ? 1 : undefined,
        target.episode,
        target.malId,
        target.title,
      );

      if (result.success) {
        for (const source of result.sources) {
          // Extract MegaUp video ID from URL
          const megaMatch = source.url?.match(/megaup[^\/]*\/e\/([^\/\?]+)/i);
          if (megaMatch) {
            const hostMatch = source.url?.match(/https?:\/\/([^\/]+)\/e\//);
            const host = hostMatch?.[1] || 'unknown';
            const id = megaMatch[1];
            const label = `${target.title.replace(/\s+/g, '-')}-${target.episode || 'movie'}`;

            if (!discovered.find(d => d.id === id)) {
              discovered.push({ id, host, label });
              console.log(`  Found: ${id} (${host}) — ${label}`);
            }
          }
        }
      }
    } catch (e) {
      console.log(`  Failed: ${target.title} —`, e);
    }
  }

  return discovered;
}

async function fetchEncrypted(videoId: string, host: string): Promise<{data: string, bytes: Uint8Array}> {
  const url = `https://${host}/media/${videoId}`;
  console.log(`  Fetching: ${url}`);

  const res = await fetch(url, {
    headers: {
      'User-Agent': MEGAUP_UA,
      'Accept': 'application/json',
      'Referer': `https://${host}/e/${videoId}`,
      'Origin': `https://${host}`,
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== 200 || !json.result) throw new Error('No result in response');

  // Decode base64
  const base64 = json.result.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const binaryStr = atob(padded);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  return { data: json.result, bytes };
}

async function fetchPlaintext(encryptedB64: string): Promise<{json: any, str: string}> {
  console.log(`  Decrypting via enc-dec.app...`);

  const res = await fetch(ENCDEC_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: encryptedB64, agent: MEGAUP_UA }),
  });

  if (!res.ok) throw new Error(`enc-dec HTTP ${res.status}`);
  const data = await res.json();
  if (data.status !== 200 || !data.result) throw new Error('enc-dec no result');

  // Re-serialize to get the bytes that would be the original
  const str = JSON.stringify(data.result);

  return { json: data.result, str };
}

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const len = Math.min(a.length, b.length);
  const result = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    result[i] = a[i] ^ b[i];
  }
  return result;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function analyzeKeystreams(keystreams: Map<string, {ks: Uint8Array, label: string}>): void {
  console.log('\n========== KEYSTREAM ANALYSIS ==========');

  const entries = Array.from(keystreams.entries());

  for (const [vid, {ks, label}] of entries) {
    console.log(`\n${label} (${vid.substring(0, 20)}...):`);
    console.log(`  Length: ${ks.length} bytes`);
    console.log(`  First 64 bytes: ${bytesToHex(ks.slice(0, 64))}`);
  }

  // Compare first N bytes across all keystreams
  console.log('\n--- Divergence Point Analysis ---');
  if (entries.length >= 2) {
    const [, {ks: refKs, label: refLabel}] = entries[0];

    for (let i = 1; i < entries.length; i++) {
      const [, {ks, label}] = entries[i];
      let firstDiff = -1;
      const minLen = Math.min(refKs.length, ks.length);

      for (let j = 0; j < minLen; j++) {
        if (refKs[j] !== ks[j]) {
          firstDiff = j;
          break;
        }
      }

      console.log(`  ${refLabel} vs ${label}: first diff at byte ${firstDiff}`);

      if (firstDiff > 0) {
        console.log(`    Common prefix (${firstDiff} bytes): ${bytesToHex(refKs.slice(0, firstDiff))}`);
        console.log(`    Ref byte ${firstDiff}: ${refKs[firstDiff].toString(16)} → after: ${bytesToHex(refKs.slice(firstDiff, Math.min(firstDiff+32, refKs.length)))}`);
        console.log(`    ${label} byte ${firstDiff}: ${ks[firstDiff].toString(16)} → after: ${bytesToHex(ks.slice(firstDiff, Math.min(firstDiff+32, ks.length)))}`);
      }
    }
  }

  // Check if keystream difference relates to video ID
  console.log('\n--- Video ID Influence Analysis ---');
  for (const [vid, {ks, label}] of entries) {
    // XOR keystream with video ID bytes to see if there's a relationship
    const vidBytes = new TextEncoder().encode(vid);
    console.log(`\n  ${label}:`);
    console.log(`    Video ID: ${vid}`);
    console.log(`    Video ID bytes (hex): ${bytesToHex(vidBytes)}`);

    // Check if ks[i] XOR ks[j] == vid[i] XOR vid[j] for any pattern
    if (entries.length >= 2) {
      const [refVid, {ks: refKs2}] = entries[0];
      const refVidBytes = new TextEncoder().encode(refVid);

      // At byte 38 (where divergence starts), check:
      // ks2[38] XOR ks1[38] vs vid2[i] XOR vid1[i]
      const divIdx = 38;
      if (ks.length > divIdx && refKs2.length > divIdx) {
        const ksXor = ks[divIdx] ^ refKs2[divIdx];
        console.log(`    ks_diff[${divIdx}] = ${ksXor.toString(16)}`);

        // Try XOR with each byte of video ID
        for (let vi = 0; vi < Math.min(vidBytes.length, refVidBytes.length); vi++) {
          const vidXor = vidBytes[vi] ^ refVidBytes[vi];
          console.log(`    vid_diff[${vi}] = ${vidXor.toString(16)} (${String.fromCharCode(vidXor)})`);
        }
      }
    }
  }
}

async function main() {
  console.log('=== MegaUp Keystream Derivation ===\n');

  // Step 1: Discover video IDs from actual extraction
  console.log('Step 1: Discovering video IDs...');
  const videoIds = await discoverVideoIds();

  if (videoIds.length < 2) {
    console.log('Need at least 2 video IDs for comparison. Using hardcoded ones...');
    // Fall back to what we have + try direct MegaUp scraping
  }

  // Step 2: Fetch encrypted data and plaintext for each video
  console.log(`\nStep 2: Fetching encrypted data for ${videoIds.length} videos...`);

  const keystreams = new Map<string, {ks: Uint8Array, label: string}>();

  for (const {id, host, label} of videoIds) {
    try {
      const { data: encB64, bytes: encBytes } = await fetchEncrypted(id, host);
      const { str: plainStr } = await fetchPlaintext(encB64);

      const plainBytes = new TextEncoder().encode(plainStr);
      const ks = xorBytes(encBytes, plainBytes);

      keystreams.set(id, {ks, label});

      console.log(`  ✓ ${label}: enc=${encBytes.length}B, plain=${plainBytes.length}B, ks=${ks.length}B`);
    } catch (e) {
      console.log(`  ✗ ${label}: ${e}`);
    }
  }

  // Step 3: Analyze
  analyzeKeystreams(keystreams);

  // Step 4: Try to derive algorithm
  console.log('\n=== Algorithm Hypothesis Testing ===');

  // Hypothesis 1: keystream = SHA256(UA + video_id) expanded via CTR-like mode
  // Test: derive keystream from various hash inputs and compare

  // Hypothesis 2: keystream = ua_keystream XOR video_keystream
  // where video_keystream = f(video_id)

  // Hypothesis 3: keystream = ChaCha20(key=H(UA), nonce=H(video_id))
  // This would produce completely different keystream per video

  console.log('\nDone.');
}

main().catch(console.error);
