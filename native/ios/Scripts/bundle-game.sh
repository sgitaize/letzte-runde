#!/usr/bin/env bash
# Kopiert Spiel (app/public) und Server (server.js, bots.js, accounts.js, moderation.js, app-host.js, selfsigned.js) ins App-Bundle
# nach game/. Läuft vor jedem Build, damit die App immer den aktuellen Stand aus app/ enthält.
set -euo pipefail
SRC="${SRCROOT}/../../app"
DST="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/game"
rm -rf "$DST"; mkdir -p "$DST/public"
for f in server.js bots.js accounts.js moderation.js app-host.js selfsigned.js package.json; do
  [ -f "$SRC/$f" ] && cp "$SRC/$f" "$DST/"
done
# Service Worker und PWA-Installationshilfe braucht die App nicht; admin.html bleibt draußen (Admin nur im Web)
rsync -a --exclude 'sw.js' --exclude 'admin.html' "$SRC/public/" "$DST/public/"
echo "game/ gebündelt: $(du -sh "$DST" | cut -f1)"
