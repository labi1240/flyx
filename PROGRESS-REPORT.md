# Flyx — Session Progress Report / Handoff

> Handoff doc so work can resume cleanly after a disconnect or in a new thread.
> Project: **Flyx Media Proxy** (Next.js 16 streaming aggregator). Working dir:
> `/Users/lovepreetgill/developer/Flyx-main`. Date of this report: 2026-06-28.

---

## TL;DR — where we are

- **Videasy is FIXED and committed.** It now extracts + plays end-to-end (server-side).
- **Cloudflare Workers are deployed** to the user's own account (media-proxy + flyx-sync), tested working.
- **Architecture chosen:** app on **VPS** (Node/Docker), all proxying on **Cloudflare Workers** (`DISABLE_LOCAL_PROXY=true`).
- Work is on branch **`fix/videasy-server-side-extraction`** (3 commits), **not merged to main, not pushed**.
- Dev server runs locally on **http://localhost:3000** (`npm run dev`).

---

## Git state

**Branch:** `fix/videasy-server-side-extraction` (created off `main`)

**Commits (newest first):**
| SHA | Summary |
|---|---|
| `15ef3565` | feat(docker): VPS+Cloudflare hybrid, TMDB v4 auth, env-file fix |
| `dfd15cd4` | chore(deploy): point workers at own CF resources + add deploy:dlhd |
| `bb663741` | fix(videasy): server-side extraction + VPS stream proxy |

**Uncommitted (intentionally left — these are `videasy.net`→`videasy.to` domain renames the USER made, in scratch/worker files NOT part of the app fix):**
- `cloudflare-proxy/src/videasy-proxy.ts` (comments only)
- `full-decrypt-pipeline.mjs`, `videasy-full-pipeline.mjs`, `videasy-source-extractor.mjs` (root scratch/test scripts)
- `package-lock.json` (from `npm install`)
- `videasy.py` (untracked — user's reference script with the enc-dec.app + server list)

**To finish up:** `git checkout main && git merge fix/videasy-server-side-extraction` (or open a PR). Nothing has been pushed.

---

## What this project is (quick orientation)

Next.js 16 / React 19 streaming aggregator. A **Provider Registry** (`app/lib/providers/`) of ~21 providers scrapes/extracts stream URLs from third-party sites; **Cloudflare Workers** proxy the streams (CORS, Referer, decryption). Two interchangeable proxy backends, chosen purely by env-var URLs:
- **Cloudflare Workers** (production) — `NEXT_PUBLIC_*` point at `*.workers.dev`
- **Local Bun proxy** `:8787` (Docker self-host) — `docker/proxy/`, "replaces CF Workers + RPI"

`CLAUDE.md` is a **security-testing authorization** doc (scraping these targets is authorized). It also lists 5 priority providers NOT yet implemented: **XPrime, 456movie, ReAnime, Anify, TVPass**.

---

## Deployed Cloudflare resources (user's account)

- Account: `lovepreetgill1238@gmail.com`, Account ID `1b87f9b71dbca3b2b6f5185a2e79c9aa`
- **media-proxy** → `https://media-proxy.lovepreetgill1238.workers.dev` (KV `HEXA_CONFIG`=`1a8b96af032549f193c863d28fc73d4d`, secret `TMDB_API_KEY` set)
- **flyx-sync** → `https://flyx-sync.lovepreetgill1238.workers.dev` (D1 `flyx-sync-db`=`c75b0826-21ba-4ac2-b6a5-57dd8dee443d`, schema applied, secret `ADMIN_JWT_SECRET` set = `cfc68e355490ed63999544f7660ad44e4c375340cc6cd50cb6f27b681dd02bdf`)
- **dlhd** → reusing shared default `https://dlhd.vynx-3b3.workers.dev` (not self-hosted)
- wrangler is authenticated (`npx wrangler whoami` works). Re-deploy a worker: `cd <dir> && npx wrangler deploy`.
- `wrangler.toml` files were updated to point at the user's KV/D1 ids (committed in `dfd15cd4`).

Env values live in **`.env.local`** (gitignored): TMDB v3 key `550b3a6b5e7c1af899691aee61869a89` (+ NEXT_PUBLIC_ variant), v4 token, the worker URLs above, and `JWT_SECRET` matching the sync worker.

---

## THE VIDEASY FIX (the main work) — how it works

**Root cause (proven):** videasy needs `Referer: https://player.videasy.to/` on BOTH the API call and the stream, fetched from a single normal server IP.
- Browser can't: it's forced to send `Origin` and can't set a cross-origin `Referer` → `api.videasy.to` returns **403**.
- CF Worker can't: infra-blocked from CF-proxied `api.videasy.to` / `shegu.org`.
- Node server CAN: proven from this machine — server-style request (Referer, no Origin) → **200, 158,424 bytes hex**; browser-style → 403.

**The two-stage pipeline (both now server-side / VPS):**
1. **Extraction** — `app/lib/services/videasy-extractor.ts`:
   - `fetchVideasyHexDirect()` fetches hex **directly from `https://api.videasy.to/cdn/sources-with-title`** with the videasy headers and a **double-URL-encoded title**.
   - Decrypts with **local WASM** (`videasy-crypto.ts` + `public/videasy-module-patched.wasm`); **fallback** to `https://enc-dec.app/api/dec-videasy` (POST `{text:hex, id:tmdbId}`) via `decryptVideasyViaEncDec()`.
   - Maps sources, wraps each URL through `getVideasyStreamProxyUrl()`.
2. **Delivery** — `app/api/stream/videasy-proxy/route.ts` (NEW):
   - Fetches playlist + segments server-side with the Referer, rewrites every playlist URL back through itself so all legs share one IP + the header. Forwards `Range`.
3. **Wiring:**
   - `app/lib/proxy-config.ts` `getVideasyStreamProxyUrl()` → `/api/stream/videasy-proxy?url=<enc>` (idempotent).
   - `app/components/player/VideoPlayer.tsx` videasy branch now calls the **server API** `/api/stream/extract?provider=videasy` (was the impossible browser-direct path). `applyStreamProxy` already leaves videasy URLs unchanged (no double-wrap).

**Verified:** extract → 3 sources (Fight Club) → playlist → segment = **3,874,680 bytes video/mp2t**; user confirmed it **played in the browser ("superfast")**.

**Known behavior:** the `shegu.org/?q=...` tokens are **short-lived** — a stream can stall after a few minutes; replaying re-extracts a fresh token. (Optional improvement below.)

---

## Important caveats / gotchas

1. **VPS datacenter IP risk (UNTESTED):** all videasy proof was on the user's **residential** Mac IP. On a cloud VPS (datacenter IP), `api.videasy.to` and/or `shegu.org` *may* 403. If so, route through a residential box. The architecture is unchanged either way.
2. **NEXT_PUBLIC_* are build-time:** baked into the client bundle. Changing them requires a rebuild (`docker compose up -d --build`); editing `docker/.env` + restart is NOT enough. `flyx.sh`/`flyx.ps1` were fixed to pass `--env-file docker/.env` so Compose reads them for build args.
3. **D1 errors in local dev are EXPECTED** — D1 only binds inside Cloudflare Workers; `next dev` logs "D1 not available" for banner/sync. Harmless locally.
4. **TMDB:** code uses the **v3 key** (`?api_key=`). `app/api/tmdb/route.js` was fixed (it wrongly sent v3 key as a Bearer → 401); now uses v4 `TMDB_API_ACCESS_TOKEN` for Bearer with v3 fallback.
5. **Stale browser bundle:** after editing player code, hard-refresh (Cmd+Shift+R) / unregister service worker — Turbopack + SW can serve old chunks (we hit this: "browser-direct FAILED" was stale code).
6. **Provider flakiness is normal:** BingeBox/others fail for some titles (upstream down); registry falls through. Not a bug.
7. **videasy + vidking + bingebox share the same upstream** (`api.videasy.to` servers: cdn/yoru, mb-flix/neon, sage, breach, etc. — see `videasy.py`).

---

## How to resume / verify

```bash
# Dev server (loads .env.local)
npm run dev                       # http://localhost:3000

# Verify videasy extraction (server-side)
curl -s "http://localhost:3000/api/stream/extract?tmdbId=550&type=movie&provider=videasy&title=Fight+Club"
#   expect: {"success":true,"sources":[ ...3 with /api/stream/videasy-proxy urls ]}

# Verify a worker
curl -s https://media-proxy.lovepreetgill1238.workers.dev/tmdb/health   # {"status":"healthy","hasApiKey":true}
curl -s https://flyx-sync.lovepreetgill1238.workers.dev/health          # {"status":"ok","hasD1":true}
```

In the browser: open a movie, pick **Videasy** in Server Selection, expect console `[VideoPlayer] Trying videasy (server-side)... ✓ videasy: N source(s)`.

---

## Open next steps (pick up here)

1. **Merge to main / push** the `fix/videasy-server-side-extraction` branch (3 commits). Not done yet.
2. **(Optional) Commit the `.net`→`.to` renames** in the scratch/worker files (harmless) — left uncommitted.
3. **Videasy auto-recovery** (recommended polish): on a fatal HLS frag/token error for videasy, silently **re-extract** (fresh token) and resume from the saved timestamp (`pendingSeekTimeRef` already exists; `tryNextSource` in `VideoPlayer.tsx` ~line 1666 is the place to add a "re-extract same provider" branch). Stops the token-expiry stall.
4. **vidking** — same `shegu.org` infra. `enc-dec.app/api/dec-vidking` is 404, so it uses a different decrypt endpoint or the same WASM with a different key. User has GitHub repo leads + `videasy.py` reference. Apply the same server-side extract + reuse the `videasy-proxy` route for delivery.
5. **Implement the 5 missing authorized providers** from CLAUDE.md (XPrime, 456movie, ReAnime, Anify, TVPass).
6. **VPS deploy test** — deploy and confirm videasy works from the datacenter IP (see caveat #1); add residential fallback if blocked.

## Bigger-picture backlog (from the initial codebase audit — not started)

- **Security Phase 0:** replace insecure secret fallbacks with fail-fast (`app/api/admin/migrate-sync/route.ts:13` `JWT_SECRET || 'flyx-admin-jwt-secret-key-2024'`, worker `SIGNING_SECRET || 'default...'`); SSRF guards on stream/image/subtitle proxies; Zod validation at API boundaries. (Note: leaked `NEXT_PUBLIC_RPI_PROXY_KEY` was in `wrangler.toml` — verify/rotate.)
- **No CI** (no `.github/`), ESLint has no config, `check-env`/`verify-env` scripts missing.
- **Repo hygiene:** ~21 stray root `.md` reports, ~13 `test-*.mjs`, committed `.wasm`/`tsconfig.tsbuildinfo`.
- **VideoPlayer.tsx is 5,400+ lines** (god component); MobileVideoPlayer is a 1,700-line near-duplicate.
