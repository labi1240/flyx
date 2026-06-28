#!/usr/bin/env bash
###############################################################################
# Flyx 2.0 - One-Command Setup (Linux/Mac)
#
# Usage (run with sudo for hosts file):
#   ./flyx.sh              - Build + start
#   ./flyx.sh stop         - Stop
#   ./flyx.sh restart      - Restart
#   ./flyx.sh logs         - Tail logs
#   ./flyx.sh status       - Show status
#   ./flyx.sh clean        - Stop + remove data
###############################################################################

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/docker/.env"
ENV_EXAMPLE="$SCRIPT_DIR/docker/.env.example"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
COMPOSE_LINUX="$SCRIPT_DIR/docker-compose.linux.yml"
DOMAIN="flyx.local"
MARKER="# flyx-self-hosted"

# Use docker/.env for BOTH build-arg interpolation (${NEXT_PUBLIC_*}) and runtime.
# Without --env-file, Compose ignores docker/.env for build args, so values set
# there (TMDB key, Cloudflare Worker URLs) would never reach the client bundle.
# On Linux, use host networking override.
COMPOSE_CMD="docker compose --env-file $ENV_FILE -f $COMPOSE_FILE"
if [ "$(uname -s)" = "Linux" ] && [ -f "$COMPOSE_LINUX" ]; then
    COMPOSE_CMD="$COMPOSE_CMD -f $COMPOSE_LINUX"
fi

log()  { echo -e "\033[32m[flyx]\033[0m $1"; }
warn() { echo -e "\033[33m[flyx]\033[0m $1"; }
err()  { echo -e "\033[31m[flyx]\033[0m $1"; }

get_lan_ip() {
    local ip=""
    if command -v ip &>/dev/null; then
        ip=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)
    fi
    if [ -z "$ip" ] && command -v ifconfig &>/dev/null; then
        ip=$(ifconfig | grep 'inet ' | grep -v '127.0.0.1' | awk '{print $2}' | head -1)
    fi
    echo "${ip:-127.0.0.1}"
}

ensure_env() {
    if [ ! -f "$ENV_FILE" ]; then
        log "Creating docker/.env from template..."
        cp "$ENV_EXAMPLE" "$ENV_FILE"

        echo ""
        err "A TMDB API key is REQUIRED for Flyx to work."
        warn "Get a free one at: https://www.themoviedb.org/settings/api"
        echo ""

        tmdb_key=""
        while [ -z "$tmdb_key" ]; do
            printf "Enter your TMDB API key (v3): "
            read -r tmdb_key
            if [ -z "$tmdb_key" ]; then
                err "TMDB key cannot be empty. Flyx needs it to fetch movie/show data."
            fi
        done

        sed -i.bak "s|NEXT_PUBLIC_TMDB_API_KEY=.*|NEXT_PUBLIC_TMDB_API_KEY=$tmdb_key|" "$ENV_FILE"
        sed -i.bak "s|TMDB_API_KEY=.*|TMDB_API_KEY=$tmdb_key|" "$ENV_FILE"
        rm -f "$ENV_FILE.bak"

        # Generate random secrets
        for secret in JWT_SECRET SIGNING_SECRET WATERMARK_SECRET ADMIN_SECRET; do
            rand=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)
            sed -i.bak "s|$secret=change-me.*|$secret=$rand|" "$ENV_FILE"
        done
        rm -f "$ENV_FILE.bak"
        log "Generated random security secrets."
    fi
}

set_hosts_entry() {
    local ip="$1"
    local entry="$ip  $DOMAIN $MARKER"
    local hosts_file="/etc/hosts"

    if [ ! -w "$hosts_file" ]; then
        warn "Cannot write to $hosts_file. Run with sudo, or add manually:"
        echo "  $entry"
        return
    fi

    if grep -q "$MARKER" "$hosts_file" 2>/dev/null; then
        sed -i.bak "s/.*${MARKER}.*/${entry}/" "$hosts_file"
        rm -f "${hosts_file}.bak"
    else
        echo "" >> "$hosts_file"
        echo "$entry" >> "$hosts_file"
    fi
    log "Added $DOMAIN -> $ip to hosts file"
}

cmd_start() {
    ensure_env
    local ip=$(get_lan_ip)

    set_hosts_entry "$ip"

    log "Building and starting Flyx..."
    $COMPOSE_CMD up -d --build

    log "Waiting for startup..."
    local retries=0
    while [ $retries -lt 30 ]; do
        if curl -sf http://localhost:3000/ >/dev/null 2>&1; then break; fi
        sleep 3
        retries=$((retries + 1))
    done

    echo ""
    echo "================================================"
    echo "  Flyx is running!"
    echo ""
    echo "  http://flyx.local    (via hosts file)"
    echo "  http://localhost     (direct on this machine)"
    echo "  http://$ip     (LAN access from other devices)"
    echo "================================================"
    echo ""
}

cmd_stop() {
    log "Stopping Flyx..."
    $COMPOSE_CMD down
    log "Stopped."
}

cmd_clean() {
    log "Stopping and cleaning up..."
    $COMPOSE_CMD down -v
    log "Cleaned. Volumes removed."
}

case "${1:-start}" in
    start)   cmd_start ;;
    stop)    cmd_stop ;;
    restart) cmd_stop; cmd_start ;;
    status)  $COMPOSE_CMD ps ;;
    logs)    $COMPOSE_CMD logs -f ;;
    clean)   cmd_clean ;;
    *)       echo "Usage: $0 {start|stop|restart|status|logs|clean}"; exit 1 ;;
esac
