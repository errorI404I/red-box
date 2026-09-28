#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
umask 077
mkdir -p data
if [[ -f data/red-box.pid ]]; then
  pid=$(cat data/red-box.pid)
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then echo "Red Box ya está activo (PID $pid)"; exit 0; fi
fi
nohup node "$PWD/server.js" >> data/red-box.log 2>&1 &
pid=$!
echo "$pid" > data/red-box.pid
sleep 1
if ! kill -0 "$pid" 2>/dev/null; then rm -f data/red-box.pid; echo 'No inició. Revisá data/red-box.log'; exit 1; fi
echo "Red Box iniciado (PID $pid)"
