#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export ZMQ_ENDPOINT="${ZMQ_ENDPOINT:-tcp://127.0.0.1:5555}"
export FILTER_ENDPOINT="${FILTER_ENDPOINT:-tcp://127.0.0.1:5556}"

if [[ -n "${ENGINE_ARGS:-}" ]]; then
  read -r -a engine_args <<< "$ENGINE_ARGS"
else
  engine_args=(--simulate "$ZMQ_ENDPOINT")
fi

shutdown() {
  echo "Stopping macro alert services..."
  if [[ -n "${agent_pid:-}" ]]; then
    kill "$agent_pid" 2>/dev/null || true
  fi
  if [[ -n "${engine_pid:-}" ]]; then
    kill "$engine_pid" 2>/dev/null || true
  fi
  wait "$agent_pid" "$engine_pid" 2>/dev/null || true
}

trap shutdown TERM INT

echo "Starting cpp_engine with args: ${engine_args[*]}"
./cpp_engine/build/cpp_engine "${engine_args[@]}" &
engine_pid=$!

echo "Starting ts_agent"
(
  cd ts_agent
  npm start
) &
agent_pid=$!

set +e
wait -n "$engine_pid" "$agent_pid"
exit_code=$?
set -e
shutdown
exit "$exit_code"
