###############################################################################
# Flyx 2.0 - Simplified Docker Container
#
# Two processes: Next.js app (Node.js) + Proxy server (Bun)
# No Caddy, Avahi, dnsmasq, or D-Bus.
#
# Build:  docker build -t flyx . -f docker/Dockerfile
# Run:    docker compose up -d
###############################################################################

# ── Stage 1: Build the Next.js app with Node.js ────────────────────────────
FROM node:20-alpine AS builder
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --legacy-peer-deps && npm rebuild better-sqlite3

COPY . .

# Remove Cloudflare-specific config
RUN rm -f open-next.config.ts

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV DOCKER_BUILD=true

# Build args — all proxy URLs point to localhost:8787
ARG NEXT_PUBLIC_TMDB_API_KEY=""
ARG NEXT_PUBLIC_CF_STREAM_PROXY_URL="http://localhost:8787/stream"
ARG NEXT_PUBLIC_CF_TV_PROXY_URL="http://localhost:8787"
ARG NEXT_PUBLIC_CF_ANALYTICS_WORKER_URL="http://localhost:8787/analytics"
ARG NEXT_PUBLIC_CF_SYNC_URL="http://localhost:8787/sync"
ARG NEXT_PUBLIC_DLHD_WORKER_URL="http://localhost:8787/dlhd"
ARG NEXT_PUBLIC_PROXY_URL="http://localhost:8787"
ARG NEXT_PUBLIC_CDN_LIVE_WORKER_URL="http://localhost:8787/cdn-live"
ARG NEXT_PUBLIC_CF_TMDB_URL="http://localhost:8787"

ENV NEXT_PUBLIC_TMDB_API_KEY=$NEXT_PUBLIC_TMDB_API_KEY
ENV NEXT_PUBLIC_CF_STREAM_PROXY_URL=$NEXT_PUBLIC_CF_STREAM_PROXY_URL
ENV NEXT_PUBLIC_CF_TV_PROXY_URL=$NEXT_PUBLIC_CF_TV_PROXY_URL
ENV NEXT_PUBLIC_CF_ANALYTICS_WORKER_URL=$NEXT_PUBLIC_CF_ANALYTICS_WORKER_URL
ENV NEXT_PUBLIC_CF_SYNC_URL=$NEXT_PUBLIC_CF_SYNC_URL
ENV NEXT_PUBLIC_DLHD_WORKER_URL=$NEXT_PUBLIC_DLHD_WORKER_URL
ENV NEXT_PUBLIC_PROXY_URL=$NEXT_PUBLIC_PROXY_URL
ENV NEXT_PUBLIC_CDN_LIVE_WORKER_URL=$NEXT_PUBLIC_CDN_LIVE_WORKER_URL
ENV NEXT_PUBLIC_CF_TMDB_URL=$NEXT_PUBLIC_CF_TMDB_URL

RUN npm run build


# ── Stage 2: Production runner with Bun ─────────────────────────────────────
FROM oven/bun:1-alpine AS runner

# Only install libc6-compat (for native modules) and curl (for healthcheck)
RUN apk add --no-cache libc6-compat curl nodejs

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# ── Copy built Next.js app ──────────────────────────────────────────────────
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public/flixer.wasm ./public/flixer.wasm
COPY --from=builder /app/pow_wasm.js ./pow_wasm.js
COPY --from=builder /app/pow_wasm_bg.wasm ./pow_wasm_bg.wasm

# ── Copy proxy TypeScript source (Bun runs it directly, no build step) ──────
COPY docker/proxy /proxy
RUN cd /proxy && bun install --production

# ── Admin seed script (run once after first boot to create your login) ──────
COPY docker/seed-admin.mjs /app/scripts/seed-admin.mjs

# ── Entrypoint ──────────────────────────────────────────────────────────────
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Data directory for SQLite
RUN mkdir -p /app/data

EXPOSE 3000 8787

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/ || exit 1

ENTRYPOINT ["/entrypoint.sh"]
