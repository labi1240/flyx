# Flyx

A privacy-first streaming platform built with Next.js 16, featuring movies, TV shows, anime, live TV, live sports, and cross-device sync.

![Next.js](https://img.shields.io/badge/Next.js-16-black?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?style=flat-square)
![React](https://img.shields.io/badge/React-19-61dafb?style=flat-square)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=flat-square)
![Cloudflare](https://img.shields.io/badge/Cloudflare-Pages-F38020?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)

## Features

- **Movies & TV Shows** — Browse trending content, search, and watch with multiple video providers
- **Anime** — Hybrid TMDB + MAL system with dual providers (HiAnime + AnimeKai), sub/dub toggle, automatic episode mapping
- **Live TV** — 850+ channels via DLHD with PoW authentication and server-side decryption
- **Live Sports** — VIPRow integration with Casthill token auth and manifest rewriting
- **PPV Events** — Pay-per-view streaming through residential proxy
- **Cross-Device Sync** — Sync watchlist, continue watching, and preferences across devices
- **Casting** — Chromecast and AirPlay for all content types including live TV
- **Subtitles** — 29 languages via OpenSubtitles with sync adjustment and non-UTF8 encoding support
- **TV Navigation** — Full spatial navigation for Fire TV, Android TV, and D-pad devices
- **Copy Stream URL** — One-click copy for VLC, IINA, mpv, or any external player
- **Admin Dashboard** — Real-time analytics, user metrics, and live activity monitoring
- **Privacy-First** — No ads, no tracking, no PII collected

## Provider Registry

All streaming sources are managed through a unified Provider Registry with priority ordering and error isolation. A single broken provider never crashes the app.

| # | Provider | Content | Method | Priority | Status |
|---|----------|---------|--------|----------|--------|
| 1 | PrimeSrc | Movies, TV | PrimeVid extraction via CF Worker | 10 | ✅ Enabled |
| 2 | Flixer | Movies, TV | WASM sign + decrypt via CF Worker (hexa.su) | 10 | ✅ Enabled |
| 3 | Uflix | Movies, TV | Multi-embed aggregator (5 servers) | 20 | ✅ Enabled |
| 4 | HiAnime | Anime | MegaCloud extraction via CF Worker (primary) | 30 | ✅ Enabled |
| 5 | AnimeKai | Anime | Native crypto extraction (secondary) | 35 | ✅ Enabled |
| 6 | VidSrc | Movies, TV | Multi-embed scraping | 40 | ✅ Enabled |
| 7 | MultiEmbed | Movies, TV | Direct HTML scraping | 50 | ❌ Disabled |
| 8 | DLHD | Live TV | PoW auth + AES segment decryption | 100 | ✅ Enabled |
| 9 | CDN-Live | Live TV | CDN stream extraction | 105 | ✅ Enabled |
| 10 | VIPRow | Live Sports | Casthill token + manifest rewrite | 110 | ✅ Enabled |
| 11 | PPV | PPV Events | Residential proxy extraction | 120 | ✅ Enabled |
| 12 | IPTV | IPTV | Stalker portal + MAC auth | 130 | ✅ Enabled |

Lower priority number = tried first. Providers are selected automatically based on content type.

## Quick Start (Docker)

Docker is the recommended way to run Flyx. The container runs two processes — Next.js (Node.js) on port 3000 and a Bun proxy server on port 8787. The only requirement is a free TMDB API key.

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) installed
- A free TMDB API key from [themoviedb.org](https://www.themoviedb.org/settings/api)

### Setup

**Linux / Mac:**
```bash
chmod +x flyx.sh
./flyx.sh
```

**Windows (PowerShell as Administrator):**
```powershell
.\flyx.ps1
```

That's it. The script will:
1. Create `docker/.env` from the template and prompt for your TMDB key
2. Auto-generate random security secrets (JWT, signing, watermark, admin)
3. Build the Docker image and start the container
4. Add `flyx.local` to your hosts file (requires sudo/admin)
5. Wait for startup and print access URLs

Once running, open `http://localhost` or `http://flyx.local`.

### Architecture

```
 Devices on LAN
      │
      ▼
┌──────────┐
│  Browser  │──── http://localhost ──────┐
└──────────┘                            │
                                        ▼
              ┌──────────┐        ┌──────────┐
              │  Flyx    │        │  Proxy   │
              │  :3000   │        │  :8787   │
              │ (Node.js)│        │  (Bun)   │
              └────┬─────┘        └────┬─────┘
                   │                   │
              ┌────▼─────┐        Direct fetch
              │  SQLite  │        to upstream
              └──────────┘        CDNs & APIs
```

### Ports

| Port | Service | Description |
|------|---------|-------------|
| 80 | Next.js | Main entry — `http://localhost` (mapped to 3000 internally) |
| 8787 | Proxy | Stream proxy, TMDB proxy, extractors |

### Commands

| Command | Description |
|---------|-------------|
| `./flyx.sh` | First-time setup + start |
| `./flyx.sh start` | Start all services |
| `./flyx.sh stop` | Stop all services |
| `./flyx.sh restart` | Restart everything |
| `./flyx.sh status` | Show service status |
| `./flyx.sh logs` | Tail all logs |
| `./flyx.sh clean` | Stop + remove volumes |

On Windows, replace `./flyx.sh` with `.\flyx.ps1`.

### Environment Variables

See [`docker/.env.example`](docker/.env.example) for the full list.

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_TMDB_API_KEY` | ✅ | TMDB API key (free at themoviedb.org) |
| `TMDB_API_KEY` | ✅ | Same key, used server-side |
| `JWT_SECRET` | Auto | Auth token signing (auto-generated) |
| `SIGNING_SECRET` | Auto | Request signing (auto-generated) |
| `WATERMARK_SECRET` | Auto | Watermark generation (auto-generated) |
| `ADMIN_SECRET` | Auto | Admin panel access (auto-generated) |
| `ENABLE_VIDSRC_PROVIDER` | No | Set `"false"` to disable VidSrc (default: enabled) |

### Linux Host Networking

On Linux, `flyx.sh` automatically uses `docker-compose.linux.yml` as an override, which enables host networking (`network_mode: host`) instead of port mapping. This avoids Docker's NAT overhead and lets the container bind directly to the host's network interfaces.

### Troubleshooting

```bash
# Check service status
docker compose ps

# View logs
docker compose logs flyx

# Proxy health check
curl http://localhost:8787/health

# Full rebuild from scratch
./flyx.sh clean
./flyx.sh start
```

## Cloudflare Deployment (Advanced)

For production deployment, Flyx runs on Cloudflare's edge network using Pages, Workers, and D1.

### Components

| Service | Platform | Purpose |
|---------|----------|---------|
| Frontend (`flyx-main-v2`) | Cloudflare Pages/Workers | Next.js app via OpenNext |
| Stream Proxy (`media-proxy`) | Cloudflare Worker | HLS proxying, CORS, provider routing, **CDN-Live**, PPV, VIPRow |
| DLHD Extractor (`dlhd`) | Cloudflare Worker | Live TV extraction + PoW auth (optional — a shared default is used if not deployed) |
| Sync Worker (`flyx-sync`) | Cloudflare Worker + D1 | Cross-device sync, analytics, admin data |
| RPI Proxy | Raspberry Pi | Residential IP for CDN bypass (optional, not a CF Worker) |

> CDN-Live is **not** a separate worker — it is served by the `media-proxy` worker at `/cdn-live`.

### Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed
- Cloudflare account with Workers and Pages enabled
- Node.js 20+

### 1. Environment Variables

Create a `.env` file in the project root (see `.env.example`):

```bash
NEXT_PUBLIC_TMDB_API_KEY=your_tmdb_key
NEXT_PUBLIC_CF_STREAM_PROXY_URL=https://your-proxy.workers.dev/stream
NEXT_PUBLIC_CF_TV_PROXY_URL=https://your-proxy.workers.dev
NEXT_PUBLIC_CF_ANALYTICS_WORKER_URL=https://your-sync.workers.dev/analytics
NEXT_PUBLIC_CF_SYNC_URL=https://your-sync.workers.dev/sync
NEXT_PUBLIC_DLHD_WORKER_URL=https://your-dlhd.workers.dev
NEXT_PUBLIC_PROXY_URL=https://your-proxy.workers.dev
NEXT_PUBLIC_CDN_LIVE_WORKER_URL=https://your-proxy.workers.dev/cdn-live
```

### 2. D1 Database Setup

```bash
# Create the D1 database
wrangler d1 create flyx-sync

# Apply migrations
wrangler d1 execute flyx-sync --file=cf-sync-worker/schema.sql
```

Update `cf-sync-worker/wrangler.toml` with your D1 database ID.

### 3. Deploy Workers

Use the npm scripts (recommended):

```bash
npm run deploy:media-proxy   # cloudflare-proxy  -> media-proxy (required; also serves CDN-Live)
npm run deploy:sync-worker   # cf-sync-worker    -> flyx-sync   (required for sync/analytics/admin; needs D1)
npm run deploy:dlhd          # dlhd-extractor-worker -> dlhd     (optional; only if self-hosting DLHD)
npm run deploy:workers       # the two required workers (media-proxy + flyx-sync)
```

Or deploy individually with wrangler:

```bash
cd cloudflare-proxy && wrangler deploy        # media-proxy (includes CDN-Live at /cdn-live)
cd cf-sync-worker && wrangler deploy           # flyx-sync (needs D1 binding)
cd dlhd-extractor-worker && wrangler deploy     # dlhd (optional — defaults to a shared worker)
```

### 4. Deploy Frontend

```bash
# Build with OpenNext for Cloudflare Pages
npm run build

# Deploy to Pages
wrangler pages deploy .open-next/assets --project-name=flyx
```

### Cloudflare Environment Variables

Set these as secrets on your Workers:

```bash
# Stream proxy worker
wrangler secret put RPI_PROXY_URL      # Residential proxy URL
wrangler secret put RPI_PROXY_KEY      # Residential proxy API key
wrangler secret put SIGNING_SECRET     # Request signing secret

# DLHD extractor worker
wrangler secret put DLHD_API_KEY       # DLHD API authentication key

# Sync worker
wrangler secret put JWT_SECRET         # JWT signing secret
wrangler secret put ADMIN_SECRET       # Admin panel secret
```

## Project Structure

```
flyx/
├── app/                          # Next.js 16 app directory
│   ├── (routes)/                 # Page routes (movies, TV, anime, live, etc.)
│   ├── api/                      # API routes
│   ├── components/               # React components
│   ├── hooks/                    # Custom React hooks
│   ├── lib/
│   │   ├── providers/            # Provider Registry (11 providers)
│   │   ├── services/             # Extraction logic per provider
│   │   └── proxy-config.ts       # Proxy routing configuration
│   ├── styles/                   # CSS modules
│   └── utils/                    # Shared utilities
├── cloudflare-proxy/             # Cloudflare Worker — stream proxy
├── dlhd-extractor-worker/        # Cloudflare Worker — DLHD live TV
├── cdn-live-extractor/           # Cloudflare Worker — CDN-Live streams
├── cf-sync-worker/               # Cloudflare Worker + D1 — sync & analytics
├── rpi-proxy/                    # Raspberry Pi residential proxy server
├── docker/                       # Docker setup (Dockerfile, proxy, entrypoint)
├── scripts/                      # Dev/debug scripts
├── flyx.sh                       # Linux/Mac launcher
├── flyx.ps1                      # Windows launcher
├── docker-compose.yml            # Docker Compose config
└── docker-compose.linux.yml      # Linux host networking override
```

## Admin Dashboard

Flyx includes a built-in admin panel at `/admin` with:

- Real-time user activity and stream monitoring
- Provider health status and extraction success rates
- User management and analytics
- Feedback system with response tracking

Access requires the `ADMIN_SECRET` configured in your environment.

## Testing

```bash
# Run unit tests
npm test

# Test a specific provider extraction
node scripts/quick-test.js

# Test deployed DLHD worker
node scripts/dlhd-deployed-e2e.js

# Test anime extraction chain
node scripts/test-anime-full-chain.js
```

## Tech Stack

- **Frontend**: Next.js 16, React 19, TypeScript 5.9
- **Styling**: Tailwind CSS + CSS Modules
- **Video**: hls.js with custom loader, Chromecast/AirPlay integration
- **Database**: SQLite (Docker) / Cloudflare D1 (production)
- **Proxy**: Bun (Docker) / Cloudflare Workers (production)
- **Build**: OpenNext for Cloudflare Pages deployment
- **Residential Proxy**: Raspberry Pi with curl-impersonate for TLS fingerprinting

## License

MIT
