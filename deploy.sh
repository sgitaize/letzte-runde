#!/usr/bin/env bash
# Lädt die App aus app/ per FTPS nach httpdocs/ und stößt einen Neustart an.
# Nutzung: ./deploy.sh [datei ...]   (ohne Argumente: alle App-Dateien)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
set -a; . ./.env; set +a

FILES=("$@")
[[ ${#FILES[@]} -eq 0 ]] && FILES=(bots.js accounts.js moderation.js public/hand.js server.js package.json scripts/setup.js public/index.html public/admin.html
  public/logo.svg public/favicon.svg public/favicon-32.png public/icon-192.png public/icon-512.png
  public/maskable-512.png public/apple-touch-icon.png public/manifest.json public/qrcode.js public/sw.js public/impressum.html
  public/.well-known/apple-app-site-association public/.well-known/assetlinks.json)

for f in "${FILES[@]}"; do
  curl -sS --max-time 60 --ssl-reqd -k --ftp-create-dirs --user "$FTP_USER:$FTP_PASS" \
    -T "app/$f" "ftp://$FTP_HOST/httpdocs/$f"
  echo "hochgeladen: $f"
done

# Android-App: nicht mehr auf den Webspace – die APK kommt als GitHub-Release (siehe INTERN.md „Android-Release“),
# /app/letzte-runde.apk leitet dorthin weiter.

# Passenger-Neustart
EMPTY="$(mktemp)"; trap 'rm -f "$EMPTY"' EXIT
curl -sS --max-time 30 --ssl-reqd -k --ftp-create-dirs --user "$FTP_USER:$FTP_PASS" \
  -T "$EMPTY" "ftp://$FTP_HOST/httpdocs/tmp/restart.txt"
echo "Neustart angestoßen (tmp/restart.txt)"

sleep 3
for h in letzterunde.aize-it.de gang.aize.eu; do echo "API-Check $h: $(curl -sS -o /dev/null -w '%{http_code}' "https://$h/api?a=config")"; done
