/**
 * MegaUp Keystream Cache
 *
 * Each successful decryption via enc-dec.app derives a keystream:
 *   keystream = ciphertext XOR plaintext (JSON)
 *
 * The keystream for a given (videoId, UA) pair is deterministic.
 * We cache it so repeat views of the same video bypass the API entirely.
 *
 * Cache replay: plaintext = findJsonBoundary(XOR(ciphertext, keystream))
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CACHE_DIR = path.join(process.cwd(), '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'megaup-keystreams.json');
const MAX_CACHE_ENTRIES = 500;

interface CacheEntry {
  /** Hex-encoded keystream */
  ks: string;
  /** Timestamp of last access */
  lastAccess: number;
  /** Number of times used */
  hits: number;
}

// key = hex(MD5(videoId + UA)[0:8])
const cache = new Map<string, CacheEntry>();

function hashKey(videoId: string, ua: string): string {
  return crypto.createHash('md5').update(videoId + '|' + ua).digest('hex').substring(0, 16);
}

// --- Persistence ---

let _loaded = false;

function ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function loadCache() {
  if (_loaded) return;
  _loaded = true;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
      const data = JSON.parse(raw);
      for (const [key, entry] of Object.entries(data)) {
        cache.set(key, entry as CacheEntry);
      }
    }
  } catch {
    // Missing or corrupt cache — start fresh
  }
}

let _saveTimeout: ReturnType<typeof setTimeout> | null = null;

function saveCacheDeferred() {
  if (_saveTimeout) clearTimeout(_saveTimeout);
  _saveTimeout = setTimeout(() => {
    _saveTimeout = null;
    try {
      ensureDir();
      const obj: Record<string, CacheEntry> = {};
      for (const [key, entry] of cache) {
        obj[key] = entry;
      }
      fs.writeFileSync(CACHE_FILE, JSON.stringify(obj), 'utf-8');
    } catch { /* disk full or permission error — ignore */ }
  }, 5000);
}

function evictIfNeeded() {
  if (cache.size <= MAX_CACHE_ENTRIES) return;

  // Sort by lastAccess, remove oldest
  const entries = Array.from(cache.entries())
    .sort((a, b) => a[1].lastAccess - b[1].lastAccess);

  for (const [key] of entries.slice(0, cache.size - MAX_CACHE_ENTRIES)) {
    cache.delete(key);
  }
}

// --- Public API ---

export function getCachedKeystream(videoId: string, ua: string): Uint8Array | null {
  loadCache();
  const key = hashKey(videoId, ua);
  const entry = cache.get(key);
  if (!entry) return null;

  entry.lastAccess = Date.now();
  entry.hits++;

  return hexToBytes(entry.ks);
}

export function setCachedKeystream(videoId: string, ua: string, keystream: Uint8Array): void {
  loadCache();
  const key = hashKey(videoId, ua);
  cache.set(key, {
    ks: bytesToHex(keystream),
    lastAccess: Date.now(),
    hits: 1,
  });
  evictIfNeeded();
  saveCacheDeferred();
}

export function getCacheStats(): { size: number; totalHits: number } {
  let totalHits = 0;
  for (const entry of cache.values()) {
    totalHits += entry.hits;
  }
  return { size: cache.size, totalHits };
}

// --- Helpers ---

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
