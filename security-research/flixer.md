# Flixer (hexa.su) — Security & Anti-Scraping Research

**Status:** ✅ Working  
**Extractor:** `app/lib/services/flixer-extractor.ts` (server/CF Worker pattern)  
**Client Extractor:** `app/lib/services/flixer-client-extractor.ts` (browser-direct pattern)  
**Last Updated:** 2026-04-30

---

## Overview

Flixer is the PRIMARY streaming provider. It uses hexa.su as its API backend. The main extractor uses a CF Worker pattern where the `/flixer/extract-all` endpoint handles the entire pipeline: WASM keygen, HMAC signing, API calls to hexa.su, and decryption. This works from both browser and server contexts.

A separate browser-direct extractor (`flixer-client-extractor.ts`) is used by VideoPlayer.tsx for client-side extraction using the sign → direct fetch → decrypt pattern.

## Anti-Scraping Measures

### 1. WASM-Based Authentication
- Auth headers are generated via a WASM module running on the CF Worker
- The CF Worker handles HMAC-signed header generation internally
- Without valid signed headers, the API returns 403

### 2. Encrypted API Responses
- hexa.su returns encrypted payloads
- Decryption is handled internally by the CF Worker
- The WASM module contains the decryption keys/logic

### 3. Cap.js Proof-of-Work (PoW)
- hexa.su uses Cap.js (cap.hexa.su) for bot protection
- Requires solving SHA-256 proof-of-work challenges
- 80 challenges must be solved; uses parallel Web Workers for speed (~2-4s on 8 cores)
- Token is cached in sessionStorage with 2.5hr TTL
- PoW solver: `app/lib/services/hexa-cap-solver.ts`
- Uses FNV-1a PRNG matching @cap.js/server exactly

### 4. IP-Based Restrictions
- Datacenter IPs are blocked — requests must come from residential IPs
- The CF Worker has proper IP handling for making API calls
- The browser-direct client extractor ensures the user's real IP hits hexa.su

### 5. Referer/Origin Validation
- API expects `Referer: https://hexa.su/`
- Standard browser headers required (User-Agent, Accept, etc.)

## Current Bypass Strategy

### Primary: CF Worker Pattern (flixer-extractor.ts)

```
Browser/Server → CF Worker /flixer/extract-all → (WASM sign + hexa.su API + decrypt) → parsed sources
```

- Single endpoint handles the full pipeline
- Works from both browser and server contexts (SSR, API routes)
- Uses `cfFetch` utility to route through RPI when on CF Pages
- Also supports `/flixer/extract?server=X` for fetching a specific server

### Secondary: Browser-Direct Pattern (flixer-client-extractor.ts)

```
Browser → CF Worker /flixer/sign → get HMAC-signed headers
Browser → hexa.su API directly (user's residential IP) → encrypted response
Browser → CF Worker /flixer/decrypt → decrypted stream URLs
```

- Used by VideoPlayer.tsx for client-side extraction
- Browser makes the actual API call (residential IP visible to hexa.su)

## Server Mapping

Flixer uses NATO phonetic alphabet codenames for servers:
- alpha → Ares, bravo → Balder, charlie → Circe, delta → Dionysus
- echo → Eros, foxtrot → Freya, golf → Gaia, hotel → Hades
- (full list in extractor source)

## Known Weaknesses / Failure Modes

1. **WASM module changes** — If hexa.su updates their WASM, the CF Worker's signing/decryption breaks. Need to re-extract the WASM.
2. **Cap.js difficulty increase** — If they increase PoW difficulty (more challenges or harder target prefix), solve time increases.
3. **Domain changes** — hexa.su could migrate domains.
4. **Rate limiting** — No explicit rate limiting observed, but aggressive scraping could trigger blocks.
5. **CF Worker IP blocking** — If hexa.su starts blocking CF Worker IPs, the primary pattern breaks. Fall back to browser-direct client extractor.

## Subtitles

- Fetched from `https://sub.wyzie.ru/search?id={tmdbId}`
- Separate from the main API, no special auth needed

## What to Check When It Breaks

- [ ] Is the CF Worker `/flixer/extract-all` endpoint returning sources?
- [ ] Is the CF Worker `/flixer/extract` endpoint working for single-server fetches?
- [ ] Has the WASM module been updated? (check hexa.su JS bundle)
- [ ] Is Cap.js PoW still solvable? (check challenge count/difficulty)
- [ ] Has the API URL structure changed?
- [ ] Are the server codenames still the same?
- [ ] Is `cfFetch` routing correctly through RPI on CF Pages?
