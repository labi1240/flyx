/**
 * MegaUp Native Decryption
 *
 * XOR stream cipher with a pre-computed keystream.
 * For a fixed User-Agent, the keystream is constant across all videos.
 * Pre-computed once, used forever — no external API dependency.
 *
 * Keystream was extracted via known-plaintext attack:
 *   1. Request /media/{id} with fixed UA
 *   2. Get encrypted payload (base64)
 *   3. Get known plaintext (from enc-dec.app, one-time RE only)
 *   4. keystream = ciphertext XOR plaintext
 *
 * Verification showed the same keystream works for ALL video IDs.
 * This is because the keystream is derived solely from the User-Agent,
 * not from the video ID. If you change the UA, you need a new keystream.
 */

// Fixed User-Agent for MegaUp requests
export const MEGAUP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// Pre-computed keystream for the fixed UA above (521 bytes)
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

/**
 * Native MegaUp decryption — XOR with pre-computed keystream.
 * No external API dependency. Works in browser and Node.js.
 *
 * @param encryptedBase64 - URL-safe base64 encrypted payload
 * @returns Decrypted JSON string
 */
export function decryptMegaUp(encryptedBase64: string): string {
  const keystream = getKeystream();

  // URL-safe base64 → standard base64 → bytes
  const base64 = encryptedBase64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const binaryStr = atob(padded);
  const encBytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    encBytes[i] = binaryStr.charCodeAt(i);
  }

  // XOR decrypt with pre-computed keystream
  const decLen = Math.min(keystream.length, encBytes.length);
  const decBytes = new Uint8Array(decLen);
  for (let i = 0; i < decLen; i++) {
    decBytes[i] = encBytes[i] ^ keystream[i];
  }

  const result = new TextDecoder().decode(decBytes);

  // Find last valid JSON boundary (handles keystream truncation)
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
      sources: data.sources || [],
      tracks: data.tracks || []
    };
  } catch {
    return null;
  }
}
