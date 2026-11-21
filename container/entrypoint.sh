#!/usr/bin/env bash
set -euo pipefail

CHROMIUM_PID=""
SUPERVISOR_PID=""
SIDECAR_PID=""
STOPPING=0

cleanup() {
  STOPPING=1
  echo "[entrypoint] Shutting down..."

  if [[ -n "${SIDECAR_PID}" ]] && kill -0 "${SIDECAR_PID}" 2>/dev/null; then
    kill -TERM "${SIDECAR_PID}" 2>/dev/null || true
    wait "${SIDECAR_PID}" 2>/dev/null || true
  fi

  if [[ -n "${SUPERVISOR_PID}" ]] && kill -0 "${SUPERVISOR_PID}" 2>/dev/null; then
    kill -TERM "${SUPERVISOR_PID}" 2>/dev/null || true
    wait "${SUPERVISOR_PID}" 2>/dev/null || true
  fi

  pkill -TERM -x chromium 2>/dev/null || true
  exit 0
}

trap cleanup SIGTERM SIGINT

run_chromium_supervisor() {
  trap 'STOPPING=1; if [[ -n "${CHROMIUM_PID}" ]] && kill -0 "${CHROMIUM_PID}" 2>/dev/null; then kill -TERM "${CHROMIUM_PID}" 2>/dev/null || true; wait "${CHROMIUM_PID}" 2>/dev/null || true; fi; exit 0' SIGTERM SIGINT

  while [[ "${STOPPING}" -eq 0 ]]; do
    echo "[entrypoint] Starting Chromium daemon..."
    chromium \
      --headless=new \
      --no-sandbox \
      --disable-dev-shm-usage \
      --disable-gpu-sandbox \
      --use-gl=angle \
      --use-angle=swiftshader \
      --enable-webgl \
      --ignore-gpu-blocklist \
      --remote-debugging-port=9222 \
      --remote-debugging-address=127.0.0.1 &
    CHROMIUM_PID=$!

    set +e
    wait "${CHROMIUM_PID}"
    EXIT_CODE=$?
    set -e

    if [[ "${STOPPING}" -eq 1 ]]; then
      break
    fi

    echo "[entrypoint] Chromium exited with code ${EXIT_CODE}, restarting in 1s..."
    sleep 1
  done
}

run_chromium_supervisor &
SUPERVISOR_PID=$!

echo "[entrypoint] Waiting for Chromium CDP at http://127.0.0.1:9222/json/version..."
for _ in $(seq 1 50); do
  if curl -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
    echo "[entrypoint] Chromium CDP is ready."
    break
  fi
  sleep 0.2
done

echo "[entrypoint] Starting Node.js sidecar on port ${PORT:-8080}..."
node --experimental-strip-types server.ts &
SIDECAR_PID=$!

set +e
wait "${SIDECAR_PID}"
SIDECAR_EXIT=$?
set -e

cleanup
exit "${SIDECAR_EXIT}"
