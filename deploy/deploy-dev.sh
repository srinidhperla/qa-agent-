#!/usr/bin/env bash
# Deploy the QA Agent to the dev server (159.89.175.168).
#
# Runs ON the server. GitHub Actions pipes it over SSH after the backend tests and the frontend
# build have passed (.github/workflows/ci-deploy.yml); it can also be run by hand:
#   bash deploy/deploy-dev.sh
#
# It does what used to be done manually, in the same order, plus three guards that the manual
# steps relied on a person to remember:
#
#   1. Never restart in the middle of a QA run. A restart kills it — run 535529c0 and two others on
#      22 Oct died that way (exit 137) and came back as "Execution not found". So the script waits
#      until the backend reports no running executions, for up to MAX_WAIT_MIN minutes.
#   2. Fast-forward only. The server checkout carries a local docker-compose.yml edit (the v1
#      compatibility tweaks). `git merge --ff-only` keeps it, and stops with a clear message instead
#      of merging or overwriting if an upstream change ever touches the same file.
#   3. Health check after the restart. If the backend does not answer /api/health within
#      HEALTH_WAIT_SEC seconds, the deploy is reported as failed with the container logs attached.
#
# Uses Docker Compose v2 (`docker compose`). The legacy v1 binary (`docker-compose` 1.29.2) cannot
# replace a container on this Docker version — it crashes with KeyError: 'ContainerConfig' — which
# is why the v1-named containers are removed once, below, before v2 takes over.
set -euo pipefail

APP_DIR="${APP_DIR:-/root/project/qa-agent-}"
BRANCH="${BRANCH:-srinidh}"
REMOTE="${REMOTE:-origin}"
API="http://localhost:${BACKEND_PORT:-8081}/api"
MAX_WAIT_MIN="${MAX_WAIT_MIN:-120}"
HEALTH_WAIT_SEC="${HEALTH_WAIT_SEC:-240}"

log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }

cd "$APP_DIR"
docker compose version >/dev/null 2>&1 || {
  log "Docker Compose v2 is not installed. Run: apt-get update && apt-get install -y docker-compose-plugin"
  exit 1
}

# ── 1. Wait for running QA runs to finish ────────────────────────────────────────────────────
health() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$API/health" || true; }
if [ "$(health)" = "200" ]; then
  for minute in $(seq 1 "$MAX_WAIT_MIN"); do
    running=$(curl -s --max-time 30 "$API/agents/stats" | sed -n 's/.*"running":\([0-9][0-9]*\).*/\1/p')
    if [ -z "$running" ]; then
      # /stats needs a signed-in user when AUTH_ENABLED=true. Refuse rather than restart blind.
      log "Could not read the run count from $API/agents/stats. Not deploying — a restart could kill a run."
      exit 1
    fi
    [ "$running" = "0" ] && break
    log "$running QA run(s) in progress — waiting (minute $minute of $MAX_WAIT_MIN)"
    sleep 60
  done
  if [ "$running" != "0" ]; then
    log "Still $running run(s) after $MAX_WAIT_MIN minutes. Nothing was changed; re-run the deploy later."
    exit 1
  fi
  log "No runs in progress."
else
  log "Backend is not answering /api/health — nothing running to protect, deploying straight away."
fi

# ── 2. Update the code ───────────────────────────────────────────────────────────────────────
before=$(git rev-parse --short HEAD)
git fetch "$REMOTE" "$BRANCH"
if ! git merge --ff-only "$REMOTE/$BRANCH"; then
  log "Fast-forward failed — the server checkout has local changes that conflict with $REMOTE/$BRANCH."
  log "Nothing was rebuilt. Resolve by hand in $APP_DIR (git status), then re-run this script."
  exit 1
fi
after=$(git rev-parse --short HEAD)
log "Code: $before -> $after"

# ── 3. Build and restart ─────────────────────────────────────────────────────────────────────
log "Building images (several minutes on this server)…"
docker compose build

# One-time switch from Compose v1: its containers are named <project>_<service>_1 and hold the
# ports, so v2 could not start alongside them. Removing a container does not touch backend/data,
# backend/logs or backend/config — those are bind-mounted from this checkout.
for legacy in qa-agent-_backend_1 qa-agent-_frontend_1; do
  if docker ps -a --format '{{.Names}}' | grep -qx "$legacy"; then
    log "Removing legacy Compose v1 container $legacy"
    docker rm -f "$legacy" >/dev/null
  fi
done

docker compose up -d

# ── 4. Health check ──────────────────────────────────────────────────────────────────────────
for _ in $(seq 1 $((HEALTH_WAIT_SEC / 5))); do
  if [ "$(health)" = "200" ]; then
    log "Backend healthy. Deployed $after."
    docker compose ps
    # Each build leaves the previous image untagged; on an 85%-full disk they add up quickly.
    docker image prune -f >/dev/null && log "Removed untagged images."
    exit 0
  fi
  sleep 5
done

log "Backend did not become healthy within ${HEALTH_WAIT_SEC}s after deploying $after."
docker compose ps || true
docker compose logs --tail 60 backend || true
exit 1
