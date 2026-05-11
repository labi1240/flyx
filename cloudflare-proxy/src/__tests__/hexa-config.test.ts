/**
 * Property-based tests for hexa-config.ts
 *
 * Feature: hexa-resilient-extraction
 * Properties 1, 2, 7
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import {
  getHexaConfig,
  refreshHexaConfig,
  DEFAULTS,
  ALLOWED_API_DOMAIN_PATTERN,
  _resetCache,
  _setNow,
  type HexaConfig,
  type ApiRoutes,
} from '../hexa-config';

// ---------------------------------------------------------------------------
// Mock KV helpers
// ---------------------------------------------------------------------------

/** Minimal mock that behaves like KVNamespace.get / .put */
function createMockKV(store: Record<string, string | null> = {}): KVNamespace {
  return {
    get: async (key: string) => store[key] ?? null,
    put: async (key: string, value: string) => { store[key] = value; },
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async (key: string) => ({ value: store[key] ?? null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

/** Mock KV that throws on every get() call */
function createThrowingKV(): KVNamespace {
  return {
    get: async () => { throw new Error('KV unavailable'); },
    put: async () => { throw new Error('KV unavailable'); },
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => { throw new Error('KV unavailable'); },
  } as unknown as KVNamespace;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const arbDomain = fc.constantFrom(
  'https://plsdontscrapemelove.flixer.su',
  'https://plsdontscrapemelove.hexa.su',
  'https://api.flixer.su',
  'https://api.hexa.sh',
  'https://api.flixer.cc',
);

// moviedb domains are BLOCKED by the validator (require captcha)
const arbBlockedDomain = fc.constantFrom(
  'https://theemoviedb.hexa.su',
  'https://themoviedb.hexa.su',
  'https://moviedb.flixer.su',
  'https://theemoviedb.flixer.sh',
  'https://amoviedb.hexa.cc',
);

const arbFingerprint = fc.string({ minLength: 5, maxLength: 30, unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')) });

const arbApiRoutes: fc.Arbitrary<ApiRoutes> = fc.record({
  time: fc.constant('/api/time'),
  movieImages: fc.constantFrom('/api/tmdb/movie/{tmdbId}/images', '/api/v2/tmdb/movie/{tmdbId}/images'),
  tvImages: fc.constantFrom(
    '/api/tmdb/tv/{tmdbId}/season/{season}/episode/{episode}/images',
    '/api/v2/tmdb/tv/{tmdbId}/season/{season}/episode/{episode}/images',
  ),
});

const arbHexChar = fc.constantFrom(...'0123456789abcdef'.split(''));
const arbHexString64 = fc.string({ minLength: 64, maxLength: 64, unit: arbHexChar });

const arbWasmHash = fc.oneof(
  fc.constant(null as string | null),
  arbHexString64,
);

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetCache();
  _setNow(() => Date.now());
});

// ---------------------------------------------------------------------------
// Property 1: Config KV Round-Trip
// Feature: hexa-resilient-extraction, Property 1: Config KV Round-Trip
// Validates: Requirements REQ-DOMAIN-1.2, REQ-WASM-1.2, REQ-ROUTE-1.2, REQ-FP-1.3
// ---------------------------------------------------------------------------

describe('Property 1: Config KV Round-Trip', () => {
  it('writing config values to KV and reading back via getHexaConfig returns equivalent values', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbDomain,
        arbFingerprint,
        arbApiRoutes,
        arbWasmHash,
        async (domain, fingerprint, routes, wasmHash) => {
          _resetCache();

          const store: Record<string, string | null> = {
            api_domain: domain,
            fingerprint_lite: fingerprint,
            api_routes: JSON.stringify(routes),
            wasm_hash: wasmHash,
          };
          const kv = createMockKV(store);

          const config = await getHexaConfig(kv);

          expect(config.apiDomain).toBe(domain);
          expect(config.fingerprintLite).toBe(fingerprint);
          expect(config.apiRoutes.time).toBe(routes.time);
          expect(config.apiRoutes.movieImages).toBe(routes.movieImages);
          expect(config.apiRoutes.tvImages).toBe(routes.tvImages);
          if (wasmHash !== null) {
            expect(config.wasmHash).toBe(wasmHash);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Config Fallback Always Valid
// Feature: hexa-resilient-extraction, Property 2: Config Fallback Always Valid
// Validates: Requirements REQ-DOMAIN-1.3, REQ-DOMAIN-2.1, REQ-FP-2.1, REQ-ROUTE-1.3, REQ-CONFIG-1.4
// ---------------------------------------------------------------------------

/** Generates a random KV state: some keys present, some missing, some invalid */
const arbKvState = fc.record({
  api_domain: fc.oneof(fc.constant(undefined as string | undefined), fc.constant(''), arbDomain),
  fingerprint_lite: fc.oneof(fc.constant(undefined as string | undefined), fc.constant(''), arbFingerprint),
  api_routes: fc.oneof(fc.constant(undefined as string | undefined), fc.constant('not-json'), fc.constant('{}'), fc.json()),
  wasm_hash: fc.oneof(fc.constant(undefined as string | undefined), arbHexString64),
  throws: fc.boolean(),
});

function isValidConfig(config: HexaConfig): boolean {
  return (
    typeof config.apiDomain === 'string' &&
    config.apiDomain.length > 0 &&
    ALLOWED_API_DOMAIN_PATTERN.test(config.apiDomain) &&
    typeof config.fingerprintLite === 'string' &&
    config.fingerprintLite.length > 0 &&
    /^[a-zA-Z0-9]+$/.test(config.fingerprintLite) &&
    typeof config.apiRoutes === 'object' &&
    typeof config.apiRoutes.time === 'string' &&
    config.apiRoutes.time.length > 0 &&
    typeof config.apiRoutes.movieImages === 'string' &&
    config.apiRoutes.movieImages.length > 0 &&
    typeof config.apiRoutes.tvImages === 'string' &&
    config.apiRoutes.tvImages.length > 0
  );
}

describe('Property 2: Config Fallback Always Valid', () => {
  it('getHexaConfig always returns a complete, valid HexaConfig regardless of KV state', async () => {
    await fc.assert(
      fc.asyncProperty(arbKvState, async (kvState) => {
        _resetCache();

        if (kvState.throws) {
          const kv = createThrowingKV();
          const config = await getHexaConfig(kv);
          expect(isValidConfig(config)).toBe(true);
          return;
        }

        const store: Record<string, string | null> = {};
        if (kvState.api_domain !== undefined) store.api_domain = kvState.api_domain;
        if (kvState.fingerprint_lite !== undefined) store.fingerprint_lite = kvState.fingerprint_lite;
        if (kvState.api_routes !== undefined) store.api_routes = kvState.api_routes;
        if (kvState.wasm_hash !== undefined) store.wasm_hash = kvState.wasm_hash;

        const kv = createMockKV(store);
        const config = await getHexaConfig(kv);
        expect(isValidConfig(config)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('getHexaConfig returns valid config when KV namespace is undefined', async () => {
    _resetCache();
    const config = await getHexaConfig(undefined);
    expect(isValidConfig(config)).toBe(true);
    expect(config.apiDomain).toBe(DEFAULTS.apiDomain);
    expect(config.fingerprintLite).toBe(DEFAULTS.fingerprintLite);
  });

  it('rejects moviedb domains and falls back to default', async () => {
    for (const blocked of ['https://theemoviedb.hexa.su', 'https://moviedb.flixer.su', 'https://theemoviedb.flixer.sh']) {
      _resetCache();
      const kv = createMockKV({ api_domain: blocked });
      const config = await getHexaConfig(kv);
      expect(config.apiDomain).toBe(DEFAULTS.apiDomain);
    }
  });
});

// ---------------------------------------------------------------------------
// Property 7: In-Memory Cache TTL
// Feature: hexa-resilient-extraction, Property 7: In-Memory Cache TTL
// Validates: Requirements REQ-CONFIG-1.3, REQ-IMPL-2.2
// ---------------------------------------------------------------------------

describe('Property 7: In-Memory Cache TTL', () => {
  it('returns cached reference within 5 minutes, re-reads from KV after 5 minutes', async () => {
    const FIVE_MIN = 5 * 60 * 1000;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: FIVE_MIN - 1 }),   // elapsed within TTL
        fc.integer({ min: FIVE_MIN, max: FIVE_MIN * 3 }), // elapsed past TTL
        async (withinTtl, pastTtl) => {
          _resetCache();

          let kvReadCount = 0;
          const store: Record<string, string | null> = {
            api_domain: 'https://plsdontscrapemelove.flixer.su',
          };
          const kv = {
            get: async (key: string) => { kvReadCount++; return store[key] ?? null; },
            put: async () => {},
            delete: async () => {},
            list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
            getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
          } as unknown as KVNamespace;

          let fakeNow = 1000000;
          _setNow(() => fakeNow);

          // First call — populates cache, reads from KV
          const first = await getHexaConfig(kv);
          const readsAfterFirst = kvReadCount;

          // Second call within TTL — should use cache, no new KV reads
          fakeNow += withinTtl;
          const second = await getHexaConfig(kv);
          expect(second).toBe(first); // same object reference
          expect(kvReadCount).toBe(readsAfterFirst); // no new reads

          // Third call past TTL — should re-read from KV
          fakeNow += pastTtl;
          store.api_domain = 'https://api.flixer.su';
          const third = await getHexaConfig(kv);
          expect(third).not.toBe(first); // new object
          expect(third.apiDomain).toBe('https://api.flixer.su');
          expect(kvReadCount).toBeGreaterThan(readsAfterFirst);
        },
      ),
      { numRuns: 100 },
    );
  });
});
