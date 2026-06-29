# Self-hosting Flyx on a Linode / VPS (Docker)

This runs the **Next.js app on your VPS** (full Node.js — no Cloudflare Workers
size limit, no $5/mo plan) with a **local SQLite database** for the admin panel,
IPTV accounts, feedback, and banners. The small proxy workers stay on Cloudflare
Workers' free tier.

## What works where

| Feature | Where it runs | Notes |
|---|---|---|
| Movies / TV / anime | VPS app + CF proxy workers | ✅ |
| **IPTV (Stalker portals)** | VPS app + **local SQLite** | ✅ after you add accounts in the admin panel |
| Admin panel | VPS app + local SQLite | ✅ after seeding an admin user (below) |
| **Live TV (DLHD etc.)** | VPS app | ⚠️ still needs the **browser extension** — a VPS is a datacenter IP, so IP-bound tokens 403 server-side regardless of host |

## 1. Provision the Linode
- A **Nanode/Shared 2 GB** is enough to start (4 GB if you expect traffic).
- Image: **Ubuntu 24.04 LTS**. Install Docker:
  ```bash
  curl -fsSL https://get.docker.com | sh
  ```

## 2. Get the code + configure env
```bash
git clone <your-repo> flyx && cd flyx
cp docker/.env.example docker/.env
```
Edit `docker/.env`:
- `NEXT_PUBLIC_TMDB_API_KEY` + `TMDB_API_KEY` — your TMDB v3 key
- `JWT_SECRET` — `openssl rand -hex 32`
- `DATABASE_BACKEND=sqlite` — **leave this on** (makes IPTV/admin use local SQLite)
- `DISABLE_LOCAL_PROXY=true` — use your Cloudflare workers for proxying
- Replace every `<you>` in the `NEXT_PUBLIC_*` worker URLs with **`lovepreetgill1238`**
  (your workers.dev subdomain), e.g.
  `NEXT_PUBLIC_CF_STREAM_PROXY_URL=https://media-proxy.lovepreetgill1238.workers.dev/stream`

> `NEXT_PUBLIC_*` values are baked in at **build time** — after changing any of
> them you must rebuild (`docker compose up -d --build`).

## 3. Build + run
```bash
docker compose up -d --build
```
The app comes up on port **3000** (compose maps it to **:80**). Put Caddy/nginx +
your domain in front for HTTPS when ready.

## 4. Create your admin login (one time)
The DB starts empty, so seed an admin user:
```bash
docker compose exec flyx node /app/scripts/seed-admin.mjs <username> <password>
```
Then log in at `/admin` and **add your IPTV accounts** (portal URL + MAC) under the
IPTV manager. Until you add live accounts, IPTV shows "no channels" even though the
DB works.

## 5. Data persistence
The SQLite files live in the `flyx-data` Docker volume (`/app/data` →
`flyx-analytics.db`, `flyx-admin.db`). Back it up with:
```bash
docker run --rm -v flyx_flyx-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/flyx-data-backup.tgz -C /data .
```

## Notes
- **Workers**: deploy your own copies so you don't depend on the original owner's:
  `npm run deploy:media-proxy`, `npm run deploy:sync-worker`, `npm run deploy:dlhd`
  (they're small and fit the Workers free tier). They land on
  `*.lovepreetgill1238.workers.dev`.
- **Live TV extension**: unchanged by self-hosting — users still install the
  Flyx Bypass extension, and it must be built to match the domain you serve on
  (its content scripts currently target `*.vynx.cc` + localhost).
