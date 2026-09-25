#!/usr/bin/env bash
# Alle Tests parallel (jeder mit eigenem Server/Port), knappe Ausgabe: eine Zeile je Test.
# Details stehen in $LOGDIR/<test>.log; bei Fehlern werden die letzten Zeilen des Logs gezeigt.
#   sim         Spielablauf, Rechte, Hausregeln, Statistik, geplante Räume, Vorschau (Server 3999)
#   ws          WebSocket-Anwesenheit (Server 3993)
#   stress      Absturzsicherheit (eigener Server 3998)
#   bots        Bots im Mehrspieler-Raum (eigener Server 3996)
#   voice       Voice-Chat in echtem Chromium (eigener Server 3994; übersprungen ohne chromium)
#   uebung      Übungsraum gegen Bots (ohne Server)
#   offline     Übungsraum ohne Netz über Service Worker, echtes Chromium (Server 3992)
# Nutzung: tests/run.sh      Ergebnis: letzte Zeile „exit 0“ = alles grün
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGDIR="${LOGDIR:-/tmp/kr-tests}"; rm -rf "$LOGDIR"; mkdir -p "$LOGDIR"
TMP="$(mktemp -d)"; cp -r "$DIR/app/." "$TMP/s1"; cp -r "$DIR/app/." "$TMP/s2"
START=$(date +%s)
(cd "$TMP/s1" && PORT=3999 KR_HOST_MOVE_MS=45000 KR_SCHEDULE_MIN_MS=1000 exec node server.js > "$LOGDIR/server-sim.log" 2>&1) & S1=$!
(cd "$TMP/s2" && PORT=3993 exec node server.js > "$LOGDIR/server-ws.log" 2>&1) & S2=$!
sleep 1
run() {  # run <name> <timeout> <befehl…>
  local n=$1 t=$2; shift 2
  ( local a=$(date +%s); timeout "$t" "$@" > "$LOGDIR/$n.log" 2>&1; local rc=$?
    echo "$rc $(( $(date +%s) - a ))" > "$LOGDIR/$n.rc" ) &
}
run sim    420 node "$DIR/tests/sim.js" "$TMP/s1/public/index.html"
run ws     150 env KR_PORT=3993 node "$DIR/tests/ws-presence.js"
run stress 300 node "$DIR/tests/stress.js" "$DIR/app"
run bots   900 node "$DIR/tests/mpbots.js" "$DIR/app"
run uebung 400 node "$DIR/tests/singleplayer.js" "$DIR/app/public/index.html"
if command -v chromium >/dev/null; then run voice 300 node --experimental-websocket "$DIR/tests/voice.js" "$DIR/app"
  run offline 300 node --experimental-websocket "$DIR/tests/offline.js" "$DIR/app"
else for n in voice offline; do echo "0 0" > "$LOGDIR/$n.rc"; echo "übersprungen (kein chromium)" > "$LOGDIR/$n.log"; done; fi
wait $(jobs -p | grep -v -e "^$S1$" -e "^$S2$") 2>/dev/null
for n in sim ws stress bots uebung voice offline; do while [ ! -f "$LOGDIR/$n.rc" ]; do sleep 1; done; done
kill $S1 $S2 2>/dev/null; rm -rf "$TMP"
RC=0
for n in sim ws stress bots uebung voice offline; do
  read -r c s < "$LOGDIR/$n.rc"
  if [ "$c" = 0 ]; then printf '✓ %-7s %3ss  %s\n' "$n" "$s" "$(grep -c '^  ok ' "$LOGDIR/$n.log") Prüfungen"
  else RC=1; printf '✗ %-7s %3ss  (exit %s) – %s\n' "$n" "$s" "$c" "$LOGDIR/$n.log"; tail -n 12 "$LOGDIR/$n.log" | sed 's/^/    /'; fi
done
echo "Dauer gesamt: $(( $(date +%s) - START ))s"
echo "exit $RC"; exit $RC
