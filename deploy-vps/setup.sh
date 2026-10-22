#!/bin/bash
# Einmalig je Instanz (als root): Nutzer, Ordner, Geheimnisse, systemd, nginx (erst HTTP; TLS nach DNS mit --tls).
# Nutzung: deploy-vps/setup.sh <instanz> <host[,host2…]> <port> [--tls]   (erster Host = Hauptadresse/Zertifikatsname)
# NET=internet: ausgehend ins Internet erlauben (ntfy-Push), interne Netze bleiben gesperrt; sonst gar kein Netz nach außen.
set -euo pipefail
INST=${1:?Instanz}; HOSTS=${2:?Host}; PORT=${3:?Port}; TLS=${4:-}; DIR=$(cd "$(dirname "$0")" && pwd)
HOST=${HOSTS%%,*}; NAMES=${HOSTS//,/ }; DOMS=$(printf -- '-d %s ' $NAMES)
[ "$(id -u)" = 0 ] || { echo "Bitte als root (sudo)"; exit 1; }
id letzterunde >/dev/null 2>&1 || { useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --user-group letzterunde; passwd -l letzterunde >/dev/null; }
install -d -o root -g root -m 755 /srv/letzterunde-$INST
install -d -o letzterunde -g letzterunde -m 700 /srv/letzterunde-$INST/var
install -d -o root -g root -m 700 /etc/letzterunde-$INST
ENVF=/etc/letzterunde-$INST/env
if [ ! -f "$ENVF" ]; then   # neue Geheimnisse (für den Umzug von Plesk hier die bisherigen Werte eintragen!)
  umask 077; printf 'PORT=%s\nADMIN_SECRET=%s\nKR_ACCT_SECRET=%s\nKR_CANONICAL=%s\n' "$PORT" "$(openssl rand -base64 24 | tr -d '/+=')" "$(openssl rand -hex 32)" "$HOST" > "$ENVF"
fi
install -m 644 "$DIR/letzterunde@.service" /etc/systemd/system/letzterunde@.service
DROP=/etc/systemd/system/letzterunde@$INST.service.d
if [ "${NET:-}" = internet ]; then install -d "$DROP"; install -m 644 "$DIR/net-internet.conf" "$DROP/net.conf"; else rm -f "$DROP/net.conf"; fi
systemctl daemon-reload; systemctl enable -q "letzterunde@$INST"
install -d -m 755 /var/www/letsencrypt
CONF=/etc/nginx/sites-available/letzterunde-$INST.conf
sed "s/__NAMES__/$NAMES/g; s/__HOST__/$HOST/g; s/__PORT__/$PORT/g" "$DIR/nginx-letzterunde.conf" > "$CONF"
if [ "$TLS" = --tls ]; then
  [ -f /etc/letsencrypt/live/$HOST/fullchain.pem ] || certbot certonly --webroot -w /var/www/letsencrypt --cert-name "$HOST" $DOMS --non-interactive --agree-tos --register-unsafely-without-email --deploy-hook "systemctl reload nginx"
  sed "s/__NAMES__/$NAMES/g; s/__HOST__/$HOST/g; s/__PORT__/$PORT/g" "$DIR/nginx-letzterunde-tls.conf" >> "$CONF"
fi
rm -f /etc/nginx/sites-enabled/default   # Willkommensseite weg; unbekannte Hosts → Verbindung schließen
[ -f /etc/nginx/sites-enabled/00-catchall.conf ] || printf 'server {\n  listen 80 default_server;\n  listen [::]:80 default_server;\n  listen 443 ssl default_server;\n  listen [::]:443 ssl default_server;\n  ssl_reject_handshake on;\n  server_name _;\n  server_tokens off;\n  return 444;\n}\n' > /etc/nginx/sites-enabled/00-catchall.conf
ln -sf "$CONF" /etc/nginx/sites-enabled/
nginx -t -q && systemctl reload nginx
echo "Setup $INST ($NAMES → 127.0.0.1:$PORT) fertig${TLS:+ mit TLS}"
