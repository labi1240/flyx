/**
 * Cap.js PoW (Proof-of-Work) Solver for Cloudflare Workers
 *
 * Hexa.su uses Cap.js (open-source PoW CAPTCHA) to gate API access.
 * The challenge is SHA-256 based — fully solvable server-side.
 *
 * Flow:
 *   1. POST /challenge → get JWT token + params (c=80, s=32, d=4)
 *   2. Generate 80 salt/target pairs using PRNG seeded with the JWT token
 *   3. For each: find nonce where sha256(salt + nonce).startsWith(target)
 *   4. POST /redeem with solutions → get cap token (valid 3 hours)
 *   5. Pass cap token as x-cap-token header on API requests
 *
 * CRITICAL: The PRNG seed is the FULL JWT token string, NOT the 'n' field
 * from the JWT payload. This was the key discovery after 7 failed attempts.
 *
 * Token is cached in KV with 2.5hr TTL (token lasts 3hr).
 */

const CAP_BASE = 'https://cap.hexa.su/15d2cf0395';
const CAP_TOKEN_KV_KEY = 'cap_token';
const CAP_TOKEN_EXPIRES_KV_KEY = 'cap_token_expires';
const CAP_TOKEN_TTL_SECONDS = 2.5 * 60 * 60; // 2.5 hours (token lasts 3hr)

// ---------------------------------------------------------------------------
// PRNG — FNV-1a seed + xorshift (matches @cap.js/server exactly)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SHA-256 using Web Crypto API (async, available in CF Workers)
// ---------------------------------------------------------------------------

async function sha256hex(str: string): Promise<string> {
  const data = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Challenge solver
// ---------------------------------------------------------------------------

interface ChallengeResponse {
  challenge: { c: number; s: number; d: number };
  token: string;
  instrumentation?: string;
}

interface RedeemResponse {
  success: boolean;
  token: string;
  expires: number;
}

const FETCH_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Origin': 'https://hexa.su',
  'Referer': 'https://hexa.su/',
};

/**
 * Solve a single PoW challenge: find nonce where sha256(salt + nonce) starts with target.
 */
async function solveChallenge(salt: string, target: string): Promise<number> {
  for (let nonce = 0; ; nonce++) {
    const hash = await sha256hex(`${salt}${nonce}`);
    if (hash.startsWith(target)) return nonce;
    if (nonce > 50_000_000) throw new Error(`PoW timeout on salt ${salt.substring(0, 8)}`);
  }
}

/**
 * Fetch a challenge, solve all PoW puzzles, redeem for a cap token.
 * Returns the token string and expiry timestamp.
 *
 * This is CPU-intensive (~60-80s for 80 challenges with d=4).
 * Best called from a cron trigger, not inline with user requests.
 */
export async function solveCapChallenge(): Promise<{ token: string; expires: number }> {
  // Step 1: Get challenge
  const challengeRes = await fetch(`${CAP_BASE}/challenge`, {
    method: 'POST',
    headers: FETCH_HEADERS,
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(10_000),
  });

  if (!challengeRes.ok) {
    throw new Error(`Cap challenge request failed: HTTP ${challengeRes.status}`);
  }

  const challengeData = await challengeRes.json() as ChallengeResponse & { instrumentation?: string };
  const { challenge, token: challengeToken, instrumentation: capInstrumentation } = challengeData;
  const { c: count, s: saltSize, d: difficulty } = challenge;

  // Step 2: Generate challenge pairs using FULL JWT token as PRNG seed
  // Server code: prng(`${token}${i}`, s) where i is 1-indexed
  const challenges: Array<[string, string]> = [];
  for (let i = 1; i <= count; i++) {
    const salt = prng(`${challengeToken}${i}`, saltSize);
    const target = prng(`${challengeToken}${i}d`, difficulty);
    challenges.push([salt, target]);
  }

  // Step 3: Solve all challenges
  // Each challenge: find nonce where sha256(salt + nonce).startsWith(target)
  const solutions: number[] = [];
  for (let i = 0; i < count; i++) {
    const [salt, target] = challenges[i];
    const nonce = await solveChallenge(salt, target);
    solutions.push(nonce);
  }

  // Step 4: Redeem solutions for cap token
  const redeemBody: Record<string, any> = { token: challengeToken, solutions };
  if (capInstrumentation) redeemBody.instrumentation = capInstrumentation;
  const redeemRes = await fetch(`${CAP_BASE}/redeem`, {
    method: 'POST',
    headers: FETCH_HEADERS,
    body: JSON.stringify(redeemBody),
    signal: AbortSignal.timeout(10_000),
  });

  if (!redeemRes.ok) {
    throw new Error(`Cap redeem failed: HTTP ${redeemRes.status}`);
  }

  const redeemData = await redeemRes.json() as RedeemResponse;
  if (!redeemData.success || !redeemData.token) {
    throw new Error(`Cap redeem rejected: ${JSON.stringify(redeemData)}`);
  }

  return { token: redeemData.token, expires: redeemData.expires };
}

// ---------------------------------------------------------------------------
// KV-backed token cache
// ---------------------------------------------------------------------------

/**
 * Get a valid cap token from KV cache, or null if expired/missing.
 */
export async function getCachedCapToken(kv: KVNamespace): Promise<string | null> {
  try {
    const [token, expiresStr] = await Promise.all([
      kv.get(CAP_TOKEN_KV_KEY),
      kv.get(CAP_TOKEN_EXPIRES_KV_KEY),
    ]);

    if (!token || !expiresStr) return null;

    const expires = parseInt(expiresStr, 10);
    // Add 5 minute buffer before expiry
    if (Date.now() > expires - 5 * 60 * 1000) return null;

    return token;
  } catch {
    return null;
  }
}

/**
 * Store a cap token in KV with appropriate TTL.
 */
export async function cacheCapToken(
  kv: KVNamespace,
  token: string,
  expires: number,
): Promise<void> {
  const ttl = Math.max(60, Math.floor((expires - Date.now()) / 1000));
  await Promise.all([
    kv.put(CAP_TOKEN_KV_KEY, token, { expirationTtl: ttl }),
    kv.put(CAP_TOKEN_EXPIRES_KV_KEY, expires.toString(), { expirationTtl: ttl }),
  ]);
}

/**
 * Get a valid cap token — from cache if available, otherwise solve a new challenge.
 * This is the main entry point for the extraction flow.
 */
export async function getCapToken(kv?: KVNamespace): Promise<string | null> {
  // Try cache first
  if (kv) {
    const cached = await getCachedCapToken(kv);
    if (cached) return cached;
  }

  // Solve new challenge
  try {
    const { token, expires } = await solveCapChallenge();

    // Cache it
    if (kv) {
      await cacheCapToken(kv, token, expires);
    }

    return token;
  } catch (e) {
    console.error(`[Cap] Failed to solve challenge: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Proactively solve and cache a cap token (for cron trigger).
 * Returns true if a new token was obtained, false if cache was still valid.
 */
export async function refreshCapToken(kv: KVNamespace): Promise<boolean> {
  const cached = await getCachedCapToken(kv);
  if (cached) return false;

  const { token, expires } = await solveCapChallenge();
  await cacheCapToken(kv, token, expires);
  console.log(`[Cap] New token cached, expires ${new Date(expires).toISOString()}`);
  return true;
}
