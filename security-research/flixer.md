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

### 4. CDN IP-Based Blocking (anti-CF-Worker)
- The Flixer CDN (*.workers.dev domains) blocks ALL requests from Cloudflare Worker IP ranges — returns 403
- ANY header combination from CF Worker IPs fails (tested: no headers, bare minimum, referer-only, origin-free, etc.)
- **Residential IPs can access the CDN directly** — returns 200 with `Access-Control-Allow-Origin: *`
- CDN tokens are NOT IP-bound to the requesting IP; they can be fetched from any residential IP
- **The RPI proxy was masking CF Worker IPs, not stripping headers** — the blocking is purely IP-based
- **Solution**: Browser fetches CDN content directly (residential IP). CF Worker only handles API extraction.

### 5. Referer Validation
- API expects `Referer: https://flixer.su/`
- Standard browser headers required (User-Agent, Accept, etc.)

## Current Bypass Strategy

### Primary: CF Worker for API, Browser-Direct for CDN

```
Browser → CF Worker /flixer/extract-all → WASM sign + Flixer API + decrypt → source URLs
Browser → CDN URL directly (residential IP, no Origin issues) → 200 + ACAO:*
```

- CF Worker handles the WASM-signed API calls (only place WASM can run)
- Browser fetches m3u8 + segments directly from the CDN (residential IP is not blocked)
- CDN returns `Access-Control-Allow-Origin: *` — CORS works for cross-origin browser requests
- No RPI needed for CDN access (residential IP)
- Also supports `/flixer/extract?server=X` for single-server fetches

## Server Mapping

Flixer uses NATO phonetic alphabet codenames for servers:
- alpha → Ares, bravo → Balder, charlie → Circe, delta → Dionysus
- echo → Eros, foxtrot → Freya, golf → Gaia, hotel → Hades
- (full list in extractor source)

## Known Weaknesses / Failure Modes

1. **WASM module changes** — If Flixer updates their WASM, the CF Worker's signing/decryption breaks. Need to re-extract the WASM.
2. **Cap.js difficulty increase** — If they increase PoW difficulty (more challenges or harder target prefix), solve time increases.
3. **Domain changes** — flixer.su or its CDN domains could change.
4. **Rate limiting** — No explicit rate limiting observed, but aggressive scraping could trigger blocks.
5. **CDN Origin blocking changes** — CDN currently blocks on Origin header only. If they switch to IP-based blocking, RPI proxy would become necessary again. Currently disabled to save costs.

## Subtitles

- Fetched from `https://sub.wyzie.ru/search?id={tmdbId}`
- Separate from the main API, no special auth needed

## What to Check When It Breaks

- [ ] Is the CF Worker `/flixer/extract-all` endpoint returning sources?
- [ ] Is the CF Worker `/flixer/extract` endpoint working for single-server fetches?
- [ ] Has the WASM module been updated? (check flixer.su JS bundle)
- [ ] Is Cap.js PoW still solvable? (check challenge count/difficulty)
- [ ] Has the API URL structure changed?
- [ ] Are the server codenames still the same?
- [ ] Does the CDN now require an IP change (residential proxy) instead of just Origin stripping?
- [ ] Are CDN domain names still `*.workers.dev` or have they rotated again?
