#!/data/data/com.termux/files/usr/bin/bash
# Instalar en ~/.termux/boot/red-box.sh. Ajustar si el proyecto está en otra carpeta.
termux-wake-lock
cd "$HOME/red-box" || exit 1
bash start.sh
