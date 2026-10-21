#!/usr/bin/env bash
# Kopiert Spiel (app/public) und Server (server.js, bots.js, accounts.js, moderation.js, resolve.js, lang.js, app-host.js, selfsigned.js,
# bundle-manifest.js) samt öffentlichem Bundle-Schlüssel ins App-Bundle nach game/. Läuft vor jedem Build, damit die App immer
# den aktuellen Stand aus app/ enthält. game/bundle.json stempelt den Build (Unix-Sekunden): nachgeladene Spiel-Bundles vom
# Server zählen nur, wenn sie neuer sind (siehe app-host.js „Spiel-Bundle“).
set -euo pipefail
SRC="${SRCROOT}/../../app"
DST="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/game"
rm -rf "$DST"; mkdir -p "$DST/public"
for f in server.js bots.js accounts.js moderation.js resolve.js lang.js bundle-manifest.js app-host.js selfsigned.js package.json bundle-key.pub; do
  [ -f "$SRC/$f" ] && cp "$SRC/$f" "$DST/"
done
# Service Worker und PWA-Installationshilfe braucht die App nicht; admin.html bleibt draußen (Admin nur im Web)
rsync -a --exclude 'sw.js' --exclude 'admin.html' "$SRC/public/" "$DST/public/"
echo "{\"build\":$(date +%s)}" > "$DST/bundle.json"
[ -f "$SRC/bundle-key.pub" ] || echo "warning: app/bundle-key.pub fehlt – die App kann keine Spiel-Updates laden (node app/scripts/bundle.js keygen)"
echo "game/ gebündelt: $(du -sh "$DST" | cut -f1)"
