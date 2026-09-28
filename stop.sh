#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
[[ -f data/red-box.pid ]] || { echo 'Sin PID de Red Box'; exit 0; }
pid=$(cat data/red-box.pid)
if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
  command_line=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  if [[ "$command_line" != *"$PWD/server.js"* ]]; then echo 'El PID no pertenece a Red Box; no se detuvo.'; exit 1; fi
  kill "$pid"
  for ((i=0; i<30; i++)); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  if kill -0 "$pid" 2>/dev/null; then echo 'El proceso sigue cerrándose; se conserva el PID.'; exit 1; fi
fi
rm -f data/red-box.pid
echo 'Red Box detenido'
