/**
 * MegaUp Native Decryption
 *
 * Uses enc-dec.app API as the primary decryption oracle (handles the
 * per-video XOR keystream that is derived from User-Agent + video ID).
 * Falls back to a pre-computed keystream when the API is unreachable.
 *
 * The keystream is NOT constant across videos — it's derived per-video
 * from the UA and video ID. enc-dec.app knows the derivation algorithm.
 */


// Fixed User-Agent for MegaUp requests
export const MEGAUP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// enc-dec.app API for MegaUp decryption
const ENCDEC_API = 'https://enc-dec.app/api/dec-mega';

// Fallback keystream — only used when enc-dec.app is unreachable.
// This is a 521-byte pre-computed keystream that may become stale.
const KEYSTREAM_HEX =
  'cd04e9c92863097ef5e0b5010d2d7bb7ff8e3efd831d83da12a45a1aca29d195' +
  '3c552272fdb39a789049975aa97586781074b4a13d841e7945e2f0c5b632b420' +
  '2dc8979699db15aacdc53193784eb52278fb7c0c33e2b3073bb1c2d6b86e9aa1' +
  '7a8c4d58e44d2b6035e2966ead4047bbe68392924ede09de62294c29b998568e' +
  'af420dd8a84a476d0e5ebd76ec8d83dfc186903afc109a855dc05da1d1c57084' +
  'e8316191571538ecdd51be555c4e245bc38068ac8054af44089db6fc10470a7b' +
  'ca7d276045b11caeac973263324e86fcf8d79f8415c33fce7b53e0dfcba2ec81' +
  '57ab8504c03a9687fd57909cc78aeef452b06f54c2d6d990390ed49ddc605a9f' +
  'ecc1509619342f70884a399a51097388f58d2668f1a80d9e14acb6502125658f' +
  '5c42394595c52c8e76baa7b1249051bc09ab642f6eb26a9d2de9bc67f964af9a' +
  'd02dbb3573998e6dd5d05c32160f340da7d94e7e463f98ecf7b75176838cbb23' +
  '9c1b73d394e9fe62eba27b52efda2b50d50ab727e2e21cea81787cc220b3ac03' +
  '8dbd47a9ead5b952b7f2e6ced5ce55a6cb5d2d6cc0f843b38c33f53ddc50d92' +
  '61ac01ddad199b09c79414ade30fce9eb39b040b8881704b368eae842a65858e' +
  'de4bed9cae74089d096558838309b170a4010547718792e00536ebbc1b903e7b' +
  '9f77ff78b66535c7ba90f218bb1bc11677ade52cf3927cdd53a9560d76b0ee9e' +
  '90328b5261f62e35f42';

// Lazy-parsed keystream bytes
let _keystream: Uint8Array | null = null;

function getKeystream(): Uint8Array {
  if (!_keystream) {
    _keystream = hexToBytes(KEYSTREAM_HEX);
  }
  return _keystream;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function base64ToBytes(b64: string): Uint8Array {
  // URL-safe base64 → standard base64 → bytes
  const base64 = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const binaryStr = atob(padded);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}

function findJsonBoundary(result: string): string {
  for (let i = result.length; i > 0; i--) {
    const substr = result.substring(0, i);
    if (substr.endsWith('}')) {
      try {
        JSON.parse(substr);
        return substr;
      } catch { /* keep searching */ }
    }
  }
  return result;
}

/**
 * Decrypt via enc-dec.app API (primary method).
 * Handles per-video keystream correctly.
 */
async function decryptViaApi(encryptedBase64: string): Promise<string> {
  const res = await fetch(ENCDEC_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: encryptedBase64, agent: MEGAUP_USER_AGENT }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`enc-dec.app returned ${res.status}`);
  }

  const data = await res.json();
  if (data.status !== 200 || !data.result) {
    throw new Error(`enc-dec.app error: ${JSON.stringify(data).substring(0, 200)}`);
  }

  return JSON.stringify(data.result);
}

/**
 * Native XOR decryption with pre-computed keystream (fallback).
 * Only works when the keystream matches the current server key.
 */
function decryptNative(encryptedBase64: string): string {
  const keystream = getKeystream();
  const encBytes = base64ToBytes(encryptedBase64);

  // XOR decrypt with pre-computed keystream
  const decLen = Math.min(keystream.length, encBytes.length);
  const decBytes = new Uint8Array(decLen);
  for (let i = 0; i < decLen; i++) {
    decBytes[i] = encBytes[i] ^ keystream[i];
  }

  return new TextDecoder().decode(decBytes);
}

/**
 * Decrypt MegaUp encrypted payload.
 *
 * Tries (in order):
 *   1. enc-dec.app API (handles per-video keystream correctly)
 *   2. Native XOR with hardcoded keystream (fallback)
 *
 * @param encryptedBase64 - URL-safe base64 encrypted payload from /media/ endpoint
 * @param _videoId - Unused (kept for API compatibility)
 * @returns Decrypted JSON string
 */
export async function decryptMegaUp(encryptedBase64: string, _videoId?: string): Promise<string> {
  // Strategy 1: enc-dec.app API (handles per-video keystream correctly)
  try {
    const result = await decryptViaApi(encryptedBase64);
    return result;
  } catch (apiError) {
    console.log('[MegaUp] enc-dec.app API failed, trying native decryption:', (apiError as Error).message);
  }

  // Strategy 2: Native XOR with hardcoded keystream (fallback)
  const result = decryptNative(encryptedBase64);
  return findJsonBoundary(result);
}

/**
 * Synchronous native-only decryption (no API call).
 * Use when you can't await (e.g., in non-async contexts).
 * Only works if the hardcoded keystream is still valid.
 */
export function decryptMegaUpSync(encryptedBase64: string): string {
  const result = decryptNative(encryptedBase64);
  return findJsonBoundary(result);
}

/**
 * Parses decrypted MegaUp response into structured data.
 */
export interface MegaUpSource {
  file: string;
  type?: string;
  label?: string;
}

export interface MegaUpTrack {
  file: string;
  kind: string;
  label?: string;
  default?: boolean;
}

export interface MegaUpResponse {
  sources: MegaUpSource[];
  tracks: MegaUpTrack[];
}

export function parseMegaUpResponse(decrypted: string): MegaUpResponse | null {
  try {
    const data = JSON.parse(decrypted);
    return {
      sources: data.sources || data.result?.sources || [],
      tracks: data.tracks || data.result?.tracks || []
    };
  } catch {
    return null;
  }
}
