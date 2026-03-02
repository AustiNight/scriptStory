#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SERVER_PID=""
CLIENT_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi

  if [[ -n "$CLIENT_PID" ]]; then
    kill "$CLIENT_PID" 2>/dev/null || true
  fi

  wait "$SERVER_PID" 2>/dev/null || true
  wait "$CLIENT_PID" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

npm run dev:server &
SERVER_PID=$!

npm run dev:client &
CLIENT_PID=$!

wait -n "$SERVER_PID" "$CLIENT_PID"
