/**
 * Browser-side Cap.js PoW Solver (Parallel Web Workers)
 *
 * Solves Cap.js proof-of-work using a pool of Web Workers, matching
 * how the official @cap.js/widget works. On an 8-core machine this
 * solves 80 challenges in ~2-4 seconds (vs 48s sequential).
 *
 * Token is cached in sessionStorage with 2.5hr TTL.
 */

const CAP_BASE = 'https://cap.hexa.su/15d2cf0395';
const CAP_TOKEN_STORAGE_KEY = 'hexa_cap_token';
const CAP_TOKEN_EXPIRES_KEY = 'hexa_cap_expires';

// Inline worker code — each worker solves one challenge at a time
const WORKER_CODE = `
self.onmessage = async ({ data: { salt, target } }) => {
  const encoder = new TextEncoder();
  let nonce = 0;
  while (true) {
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(salt + nonce));
    const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
    if (hex.startsWith(target)) {
      self.postMessage({ nonce, found: true });
      return;
    }
    nonce++;
    if (nonce > 50000000) {
      self.postMessage({ found: false, error: 'timeout' });
      return;
    }
  }
};
`;

// PRNG — matches @cap.js/server exactly
function fnv1a(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
}

function prng(seed: string, length: number): string {
  let state = fnv1a(seed);
  let result = '';
  function next(): number {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  }
  while (result.length < length) {
    result += next().toString(16).padStart(8, '0');
  }
  return result.substring(0, length);
}

/**
 * Get a cached cap token from sessionStorage, or null if expired/missing.
 */
export function getCachedCapToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const token = sessionStorage.getItem(CAP_TOKEN_STORAGE_KEY);
    const expiresStr = sessionStorage.getItem(CAP_TOKEN_EXPIRES_KEY);
    if (!token || !expiresStr) return null;
    const expires = parseInt(expiresStr, 10);
    if (Date.now() > expires - 5 * 60 * 1000) return null;
    return token;
  } catch {
    return null;
  }
}

// Singleton solve promise — prevents multiple concurrent solves
let _solvePromise: Promise<string> | null = null;

/**
 * Solve a single challenge in a Web Worker.
 */
function solveInWorker(workerUrl: string, salt: string, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const w = new Worker(workerUrl);
    w.onmessage = ({ data }) => {
      w.terminate();
      if (data.found) resolve(data.nonce);
      else reject(new Error(data.error || 'worker failed'));
    };
    w.onerror = (e) => { w.terminate(); reject(e); };
    w.postMessage({ salt, target });
  });
}

/**
 * Solve Cap.js PoW using parallel Web Workers.
 * Uses navigator.hardwareConcurrency workers (typically 4-16).
 * Solves 80 challenges in ~2-4s on modern hardware.
 */
async function solveCapParallel(): Promise<string> {
  const cached = getCachedCapToken();
  if (cached) return cached;

  console.log('[Cap] Solving PoW with Web Workers...');
  const t0 = Date.now();

  // Step 1: Get challenge
  const challengeRes = await fetch(`${CAP_BASE}/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!challengeRes.ok) throw new Error(`Challenge HTTP ${challengeRes.status}`);
  const { challenge, token: jwt } = await challengeRes.json();
  const { c: count, s: saltSize, d: difficulty } = challenge;

  // Step 2: Generate all challenge pairs
  const challenges: Array<{ salt: string; target: string }> = [];
  for (let i = 1; i <= count; i++) {
    challenges.push({
      salt: prng(`${jwt}${i}`, saltSize),
      target: prng(`${jwt}${i}d`, difficulty),
    });
  }

  // Step 3: Create worker blob URL
  const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
  const workerUrl = URL.createObjectURL(blob);

  // Step 4: Solve all challenges in parallel using worker pool
  const poolSize = Math.min(navigator.hardwareConcurrency || 4, 16);
  console.log(`[Cap] ${count} challenges, ${poolSize} workers`);

  const solutions: number[] = new Array(count);
  let nextIdx = 0;

  const runWorker = async (): Promise<void> => {
    while (nextIdx < count) {
      const idx = nextIdx++;
      const { salt, target } = challenges[idx];
      solutions[idx] = await solveInWorker(workerUrl, salt, target);
    }
  };

  // Launch pool
  await Promise.all(Array.from({ length: poolSize }, () => runWorker()));
  URL.revokeObjectURL(workerUrl);

  console.log(`[Cap] Solved ${count} puzzles in ${Date.now() - t0}ms`);

  // Step 5: Redeem
  const redeemRes = await fetch(`${CAP_BASE}/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: jwt, solutions }),
  });
  if (!redeemRes.ok) throw new Error(`Redeem HTTP ${redeemRes.status}`);
  const redeemData = await redeemRes.json();
  if (!redeemData.success || !redeemData.token) {
    throw new Error(`Redeem rejected: ${JSON.stringify(redeemData)}`);
  }

  // Cache
  const token = redeemData.token;
  const expires = redeemData.expires || (Date.now() + 2.5 * 60 * 60 * 1000);
  try {
    sessionStorage.setItem(CAP_TOKEN_STORAGE_KEY, token);
    sessionStorage.setItem(CAP_TOKEN_EXPIRES_KEY, expires.toString());
  } catch {}

  console.log(`[Cap] Token obtained in ${Date.now() - t0}ms`);
  return token;
}

/**
 * Get a cap token — cached or freshly solved via Web Workers.
 * Deduplicates concurrent calls (singleton promise).
 */
export async function getCapToken(): Promise<string | null> {
  const cached = getCachedCapToken();
  if (cached) return cached;

  if (_solvePromise) return _solvePromise;

  _solvePromise = solveCapParallel()
    .catch(e => {
      console.error('[Cap] Solve failed:', e instanceof Error ? e.message : e);
      return null as any;
    })
    .finally(() => { _solvePromise = null; });

  return _solvePromise;
}
