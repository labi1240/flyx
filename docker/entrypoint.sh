#!/bin/sh
###############################################################################
# Flyx 2.0 - Simplified Entrypoint
# Starts: Bun proxy server, Node.js Next.js app
###############################################################################

echo "============================================="
echo "  Flyx 2.0 - Starting..."
echo "============================================="

# ── 1. Start the Bun proxy server (optional) ────────────────────────────────
# Set DISABLE_LOCAL_PROXY=true when all proxying is handled by Cloudflare Workers
# (app-on-VPS mode) — the local Bun proxy is then unnecessary and skipped.
PROXY_PID=""
if [ "$DISABLE_LOCAL_PROXY" = "true" ]; then
    echo "[proxy] DISABLE_LOCAL_PROXY=true — skipping local Bun proxy (using Cloudflare Workers)"
else
    echo "[proxy] Starting Bun proxy on :8787"
    cd /proxy && bun run server.ts &
    PROXY_PID=$!

    RETRIES=0
    while [ $RETRIES -lt 10 ]; do
        if curl -sf http://localhost:8787/health >/dev/null 2>&1; then
            echo "[proxy] Proxy is healthy"
            break
        fi
        RETRIES=$((RETRIES + 1))
        sleep 1
    done

    if [ $RETRIES -eq 10 ]; then
        echo "[proxy] WARNING: Proxy health check did not pass after 10 attempts"
    fi
fi

# ── 2. Start the Next.js app ───────────────────────────────────────────────
echo "[app] Starting Next.js on :3000"
cd /app && node server.js &
APP_PID=$!

RETRIES=0
while [ $RETRIES -lt 20 ]; do
    if curl -sf http://localhost:3000/ >/dev/null 2>&1; then
        echo "[app] Next.js is healthy"
        break
    fi
    RETRIES=$((RETRIES + 1))
    sleep 1
done

if [ $RETRIES -eq 20 ]; then
    echo "[app] WARNING: Next.js health check did not pass after 20 attempts"
fi

# ── 3. Startup banner ──────────────────────────────────────────────────────
echo ""
echo "============================================="
echo "  Flyx is ready!"
echo ""
echo "  http://localhost       (this machine)"
echo "  http://localhost:3000  (Next.js direct)"
if [ -n "$PROXY_PID" ]; then
    echo "  http://localhost:8787  (Proxy direct)"
fi
echo "============================================="
echo ""

# ── Trap signals for clean shutdown ─────────────────────────────────────────
cleanup() {
    echo "[flyx] Shutting down..."
    kill $APP_PID $PROXY_PID 2>/dev/null
    wait
    exit 0
}
trap cleanup SIGTERM SIGINT

wait $APP_PID
