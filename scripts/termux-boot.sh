#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
termux-wake-lock
cd "$HOME/red-box" || exit 1
sleep 10
node scripts/update-worker.js --recover
bash start.sh
for ((i=0; i<60; i++)); do
  if curl --silent --fail --max-time 2 http://127.0.0.1:8080/api/state >/dev/null; then
    exec bash scripts/start-cloudflare.sh
  fi
  sleep 1
done
mkdir -p data
echo 'Termux:Boot: Red Box no respondió en localhost:8080; túnel no iniciado.' >> data/cloudflared.log
exit 1
