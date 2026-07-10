#!/usr/bin/env bash
# Boots a throwaway instance of the api-server, runs the gate-cascade
# verification against it, then shuts the server down. Self-contained so it can
# run as an automated validation step without depending on an already-running
# workflow. Exits non-zero if the server fails to boot or any cascade check fails.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Pick a free ephemeral port (override with GATE_CHECK_PORT) so this never
# collides with the running api-server workflow or a leftover instance.
PORT="${GATE_CHECK_PORT:-}"
if [[ -z "$PORT" ]]; then
  PORT="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{process.stdout.write(String(s.address().port));s.close()})')"
fi
if [[ -z "$PORT" ]]; then
  echo "ERROR: could not determine a free port" >&2
  exit 1
fi
BASE="http://localhost:${PORT}/api"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "==> Building api-server"
if ! pnpm --filter @workspace/api-server run build; then
  echo "ERROR: api-server build failed" >&2
  exit 1
fi

echo "==> Starting api-server on port ${PORT}"
PORT="$PORT" NODE_ENV=development node --enable-source-maps \
  artifacts/api-server/dist/index.mjs &
SERVER_PID=$!

echo "==> Waiting for ${BASE}/healthz"
READY=""
for _ in $(seq 1 60); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "ERROR: api-server exited before becoming ready" >&2
    exit 1
  fi
  if curl -fsS "${BASE}/healthz" >/dev/null 2>&1; then
    READY="1"
    break
  fi
  sleep 1
done

if [[ -z "$READY" ]]; then
  echo "ERROR: api-server did not become ready within 60s" >&2
  exit 1
fi

echo "==> Running gate-cascade verification"
API_BASE="$BASE" pnpm --filter @workspace/scripts run verify-gate-cascades
STATUS=$?

exit "$STATUS"
