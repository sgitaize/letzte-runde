#!/bin/bash
# Letzte Runde auf dem VPS ausrollen – nur gepushte Commits (Regel: Commit → Push → Deploy).
# Nutzung (als root): deploy-vps/deploy.sh <instanz> [commit]   z. B. deploy-vps/deploy.sh test
set -euo pipefail
INST=${1:?Instanz fehlt (z. B. test)}; REPO=$(cd "$(dirname "$0")/.." && pwd)
BASE=/srv/letzterunde-$INST; ENVF=/etc/letzterunde-$INST/env
[ "$(id -u)" = 0 ] || { echo "Bitte als root (sudo)"; exit 1; }
[ -f "$ENVF" ] || { echo "$ENVF fehlt – erst setup.sh"; exit 1; }
cd "$REPO"; git fetch -q origin main
REV=$(git rev-parse "${2:-origin/main}")
git merge-base --is-ancestor "$REV" origin/main || { echo "Commit $REV ist nicht auf origin/main gepusht"; exit 1; }
PORT=$(sed -n 's/^PORT=//p' "$ENVF")
NEW=$BASE/app.new; rm -rf "$NEW"; install -d -o root -g root -m 755 "$NEW"
git archive "$REV" app | tar -x -C "$NEW" --strip-components=1
rm -rf "$NEW/data" "$NEW/logs" "$NEW/tmp"
chown -R root:root "$NEW"; chmod -R u=rwX,go=rX "$NEW"
echo "$REV" > "$NEW/REVISION"
# Spiel-Bundle für die Apps signieren (vor dem Umschalten – ohne Schlüssel kein halber Stand). BUNDLE=0 überspringt.
KEY=${KR_BUNDLE_KEY:-/root/workspace/secrets/letzterunde-bundle-key.pem}
if [ "${BUNDLE:-1}" = 1 ]; then
  [ -r "$KEY" ] || { echo "Bundle-Schlüssel $KEY fehlt/unlesbar (BUNDLE=0 zum Überspringen)"; rm -rf "$NEW"; exit 1; }
  KR_BUNDLE_KEY=$KEY /usr/local/lib/node-srv/bin/node "$NEW/scripts/bundle.js" build >/dev/null
  [ -s "$NEW/bundle.json" ] || { echo "bundle.json nicht erzeugt"; rm -rf "$NEW"; exit 1; }
fi
[ -d "$BASE/app" ] && rm -rf "$BASE/app.old" && mv "$BASE/app" "$BASE/app.old"
mv "$NEW" "$BASE/app"
systemctl restart "letzterunde@$INST"
for i in $(seq 1 30); do sleep 0.5; curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api?a=config" && { echo "OK: $INST läuft mit $(git rev-parse --short "$REV")"; curl -fsS "http://127.0.0.1:$PORT/api?a=config" | grep -o '"bundle":{[^}]*}' | head -c 160; echo; exit 0; }; done
echo "Start fehlgeschlagen – zurück auf den alten Stand"; journalctl -u "letzterunde@$INST" -n 20 --no-pager
if [ -d "$BASE/app.old" ]; then rm -rf "$BASE/app"; mv "$BASE/app.old" "$BASE/app"; systemctl restart "letzterunde@$INST"; fi
exit 1
