#!/bin/bash
# Erreichbarkeit Letzte Runde über die öffentlichen Adressen (nginx + TLS + Dienst) → healthchecks.io.
# Ping-URL kommt als systemd-Credential "hc" (aus /var/lib/backup/hc-urls, Zeile letzterunde=…).
set -uo pipefail
PING=$(sed -n 's/^letzterunde=//p' "$CREDENTIALS_DIRECTORY/hc")
[ -n "$PING" ] || { echo "Ping-URL fehlt"; exit 1; }
err=""
for h in letzterunde.aize-it.de gang.aize.eu; do
  b=$(curl -fsS -m 15 "https://$h/api?a=config" 2>&1) || { err+="$h: ${b:0:80}; "; continue; }
  grep -q '"bundle":{"build"' <<<"$b" || err+="$h: kein App-Bundle; "
done
end=$(echo | timeout 10 openssl s_client -connect letzterunde.aize-it.de:443 -servername letzterunde.aize-it.de 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
if [ -z "$end" ]; then err+="Zertifikat nicht lesbar; "
else d=$(( ($(date -d "$end" +%s) - $(date +%s)) / 86400 )); [ "$d" -lt 10 ] && err+="Zertifikat läuft in $d Tagen ab; "; fi
if [ -z "$err" ]; then curl -fsS -m 10 -o /dev/null "$PING"; echo ok
else curl -fsS -m 10 -o /dev/null --data-raw "$err" "$PING/fail"; echo "FEHLER: $err"; exit 1; fi
