# Security & Anti-Scraping Research

This folder documents the anti-scraping measures, security mechanisms, and bypass strategies for each streaming source used by the project. The goal is to have a living reference that can be quickly updated when providers change their systems.

## Provider Index

| Provider | Status | File | Last Updated |
|----------|--------|------|--------------|
| Flixer (hexa.su) | ✅ Working | [flixer.md](./flixer.md) | 2026-03-19 |
| Hexa (hexawatch.cc) | ⚠️ Disabled | [hexa.md](./hexa.md) | 2026-03-19 |
| 1movies (111movies.com) | ❌ Disabled | [1movies.md](./1movies.md) | 2026-03-19 |
| Tapemotion (tapemotion.com) | 🔍 Not Integrated | [tapemotion.md](./tapemotion.md) | 2026-03-19 |
| Uflix (uflix.to) | ✅ Integrated | [uflix.md](./uflix.md) | 2026-03-19 |
| Nepoflix (nepoflix.site) | 🔍 Not Integrated | [nepoflix.md](./nepoflix.md) | 2026-03-19 |
| Streamversea (streamversea.site) | 🔍 Not Integrated | [streamversea.md](./streamversea.md) | 2026-03-19 |
| PrimeSrc (primesrc.me) | ✅ Integrated | [primesrc.md](./primesrc.md) | 2026-03-20 |

## How to Use This Folder

1. When a provider breaks, check its doc for known anti-scraping measures
2. Update the doc with new findings (changed headers, new encryption, new captcha, etc.)
3. Update the "Last Updated" date in the table above
4. Use the "Current Bypass Strategy" section to quickly see what's implemented
5. Use the "Known Weaknesses / Failure Modes" section to diagnose issues

## E2E Tests

Each provider has an `e2e.test.ts` in its subfolder. Run them with:

```bash
# Run all provider E2E tests
bun test security-research/ --timeout 60000

# Run a specific provider
bun test security-research/flixer/e2e.test.ts --timeout 60000
bun test security-research/hexa/e2e.test.ts --timeout 60000
bun test security-research/1movies/e2e.test.ts --timeout 60000
bun test security-research/tapemotion/e2e.test.ts --timeout 60000
bun test security-research/uflix/e2e.test.ts --timeout 60000
bun test security-research/nepoflix/e2e.test.ts --timeout 60000
bun test security-research/streamversea/e2e.test.ts --timeout 60000
bun test security-research/primesrc/e2e.test.ts --timeout 60000
```

### Test Categories

| Provider | Test Type | What It Tests |
|----------|-----------|---------------|
| Flixer | Full pipeline | CF Worker /flixer/extract-all → WASM sign + API + decrypt → stream URLs |
| Hexa | Server availability | All 8 embed servers reachability + m3u8 extraction |
| 1movies | Encryption + reachability | AES/XOR/substitution primitives + site status |
| Tapemotion | Reconnaissance | Protection detection, URL/API pattern probing |
| Uflix | Full pipeline | Search → slug → IMDB extraction → gStream API → 5 embed URLs |
| Nepoflix | Reconnaissance | Protection analysis, UA testing, infrastructure ID |
| Streamversea | Reconnaissance | SPA analysis, JS bundle inspection, API discovery |
| PrimeSrc | Full pipeline | Server list API, PrimeVid cloudnestra extraction, Turnstile bypass, CDN domain resolution |

### Notes

- Integrated providers (Flixer, Hexa, 1movies) have deeper tests that validate the actual extraction pipeline
- Non-integrated providers (Tapemotion, Uflix, Nepoflix, Streamversea) have recon tests that probe for URL patterns, API endpoints, and protection mechanisms
- All tests produce detailed console output — run with `--verbose` to see the full reports
- Tests use `--timeout 60000` because they make real network requests

## Related Code

- Extractors: `app/lib/services/*-extractor.ts`
- Proxy config: `app/lib/proxy-config.ts`
- CF fetch utility: `app/lib/utils/cf-fetch.ts`
- Hexa cap solver: `app/lib/services/hexa-cap-solver.ts`
- AnimeKai crypto: `app/lib/animekai-crypto.ts`
