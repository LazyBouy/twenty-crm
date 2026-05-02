#!/bin/bash
# =============================================================================
# Twenty CRM — Development Environment Setup
# =============================================================================
# Brings up Twenty's docker-compose deploy stack for local dev / testing.
# Default services: db, redis, server, worker, mcp.
# Caddy is OPT-IN via --with-caddy (binds 80/443 on all interfaces; not
# needed for dev — server and mcp are bound to 127.0.0.1 directly).
#
# Why deploy.yml (not dev.yml): deploy.yml is the persistent-memory + MCP
# stack that mirrors VPS production. dev.yml has only db + redis and assumes
# you run twenty-server / twenty-front from source via `yarn start` —
# a different workflow.
#
# Usage (from repo root):
#   bash packages/twenty-utils/setup-dev-env.sh                # start (idempotent)
#   bash packages/twenty-utils/setup-dev-env.sh --down         # stop
#   bash packages/twenty-utils/setup-dev-env.sh --reset        # wipe data + restart
#   bash packages/twenty-utils/setup-dev-env.sh --with-caddy   # include caddy (binds 80/443)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/packages/twenty-docker/docker-compose.deploy.yml"
DOCKER_ENV_FILE="$REPO_ROOT/packages/twenty-docker/.env"
DOCKER_ENV_EXAMPLE="$REPO_ROOT/packages/twenty-docker/.env.example"
SERVER_HEALTHCHECK="http://localhost:4440/healthz"
DEFAULT_SERVICES=(db redis server worker mcp)

info()  { echo "=> $*"; }
ok()    { echo "   done: $*"; }
warn()  { echo "   warn: $*" >&2; }
fail()  { echo "   FAIL: $*" >&2; }

# --------------- parse flags ---------------
ACTION="up"
WITH_CADDY=false

while [ $# -gt 0 ]; do
  case "$1" in
    --down)        ACTION="down" ;;
    --reset)       ACTION="reset" ;;
    --with-caddy)  WITH_CADDY=true ;;
    -h|--help)
      sed -n '2,22p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) fail "Unknown flag: $1"; exit 1 ;;
  esac
  shift
done

SERVICES=("${DEFAULT_SERVICES[@]}")
if [ "$WITH_CADDY" = true ]; then
  SERVICES+=(caddy)
  warn "--with-caddy will expose ports 80/443 on all interfaces. Use only on a trusted network."
fi

# --------------- preflight ---------------
if ! docker compose version >/dev/null 2>&1; then
  fail "Docker Compose not found. Install Docker (with the compose plugin) before continuing."
  exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  fail "Compose file not found: $COMPOSE_FILE"
  exit 1
fi

# --------------- stop / reset ---------------
if [ "$ACTION" = "down" ]; then
  info "Stopping deploy stack..."
  docker compose -f "$COMPOSE_FILE" down
  ok "Stack stopped"
  exit 0
fi

if [ "$ACTION" = "reset" ]; then
  info "Resetting deploy stack (stopping containers + wiping volumes)..."
  docker compose -f "$COMPOSE_FILE" down -v
  ok "Stack stopped, volumes wiped"
fi

# --------------- ensure docker .env ---------------
if [ ! -f "$DOCKER_ENV_FILE" ]; then
  if [ -f "$DOCKER_ENV_EXAMPLE" ]; then
    cp "$DOCKER_ENV_EXAMPLE" "$DOCKER_ENV_FILE"
    info "Created $DOCKER_ENV_FILE from template."
    fail "REQUIRED: edit $DOCKER_ENV_FILE and set:"
    echo "         - PG_DATABASE_PASSWORD (any strong password)"
    echo "         - APP_SECRET            (use: openssl rand -base64 32)"
    echo "         Then re-run this script."
    exit 1
  else
    fail "Missing $DOCKER_ENV_FILE and no template at $DOCKER_ENV_EXAMPLE."
    exit 1
  fi
fi

# Sanity-check the two required secrets are non-empty (uncommented).
missing=()
grep -qE '^PG_DATABASE_PASSWORD=.+' "$DOCKER_ENV_FILE" || missing+=(PG_DATABASE_PASSWORD)
grep -qE '^APP_SECRET=.+' "$DOCKER_ENV_FILE" || missing+=(APP_SECRET)
if [ "${#missing[@]}" -gt 0 ]; then
  fail "$DOCKER_ENV_FILE is missing required values: ${missing[*]}"
  echo "         Edit the file and set each, then re-run."
  exit 1
fi

# --------------- bring up services ---------------
info "Starting services: ${SERVICES[*]}"
docker compose -f "$COMPOSE_FILE" up -d "${SERVICES[@]}"

info "Waiting for server health (max 120s)..."
retries=120
while ! curl -sf "$SERVER_HEALTHCHECK" >/dev/null 2>&1; do
  retries=$((retries - 1))
  if [ "$retries" -le 0 ]; then
    fail "Server did not become healthy at $SERVER_HEALTHCHECK within 120s."
    echo "         Check logs: docker compose -f $COMPOSE_FILE logs server"
    exit 1
  fi
  sleep 1
done
ok "Server healthy at http://localhost:4440"

# --------------- summary + next steps ---------------
echo ""
echo "Dev stack ready."
echo ""
echo "  Twenty UI:   http://localhost:4440"
echo "  MCP proxy:   http://localhost:4441   (localhost-only)"
if [ "$WITH_CADDY" = true ]; then
echo "  Caddy:       http://localhost:80, https://localhost:443  (ALL interfaces)"
fi
echo ""

if ! grep -qE '^TWENTY_API_KEY=.+' "$DOCKER_ENV_FILE" 2>/dev/null; then
  warn "TWENTY_API_KEY in $DOCKER_ENV_FILE is empty."
  echo "         The mcp container is running but cannot authenticate to Twenty."
  echo ""
  echo "         To wire it up:"
  echo "           1. Sign in at http://localhost:4440 and create a workspace."
  echo "           2. Settings -> Developers -> API Keys -> Create."
  echo "           3. Paste the key into BOTH:"
  echo "                packages/twenty-mcp/.env.local"
  echo "                packages/twenty-docker/.env"
  echo "           4. Restart the mcp container:"
  echo "                docker compose -f $COMPOSE_FILE restart mcp"
  echo ""
fi

echo "  Stop:        bash packages/twenty-utils/setup-dev-env.sh --down"
echo "  Reset:       bash packages/twenty-utils/setup-dev-env.sh --reset    # wipes volumes"
echo "  With caddy:  bash packages/twenty-utils/setup-dev-env.sh --with-caddy"
echo ""
