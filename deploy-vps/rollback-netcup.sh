#!/bin/bash
# Notfall-Rückweg VPS → netcup (Plesk). Seit 2026-10-22 läuft Letzte Runde auf dem VPS; auf netcup ist die App
# deaktiviert (httpdocs/server.js → server.js.vps-umzug), Code und alte Daten liegen dort noch.
# Ablauf (als root):  rollback-netcup.sh          → VPS-Dienst stoppen, aktuelle Daten nach netcup, netcup-App an
#                     danach DNS (letzterunde.aize-it.de + gang.aize.eu, A/AAAA) zurück auf 91.204.46.91 / 2a03:4000:30:96a7::13:9074
# Zurück auf den VPS: Daten von netcup holen (wie beim Umzug), server.js auf netcup wieder umbenennen, DNS auf den VPS.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Bitte als root (sudo)"; exit 1; }
REPO=$(cd "$(dirname "$0")/.." && pwd); set -a; . "$REPO/.env"; set +a
V=/srv/letzterunde-prod/var/data; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
read -r -p "Letzte Runde wirklich auf netcup zurückschalten? (ja) " a; [ "$a" = ja ] || exit 1
systemctl stop letzterunde@prod
cp -a "$V/." "$T/"   # Geheimnisse liegen auf netcup noch in data/ (account-secret.txt, admin-secret.txt, admin-ntfy.txt) – gleiche Werte
lftp -u "$FTP_USER,$FTP_PASS" -e "set ftp:ssl-force true; set ssl:verify-certificate no; mirror -R --parallel=4 $T httpdocs/data; mv httpdocs/server.js.vps-umzug httpdocs/server.js; put /dev/null -o httpdocs/tmp/restart.txt; bye" "$FTP_HOST"
sleep 5
curl -fsS -m 20 --resolve letzterunde.aize-it.de:443:91.204.46.91 https://letzterunde.aize-it.de/api?a=config >/dev/null && echo "netcup läuft wieder – jetzt DNS zurückstellen" || echo "netcup antwortet nicht – Plesk prüfen"
