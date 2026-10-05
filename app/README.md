# Letzte Runde – Node-Version (netcup Webhosting 4000)

Keine Abhängigkeiten, kein Build, keine Datenbank. Updates kommen per WebSocket, mit automatischem Rückfall auf Polling, falls der Proxy kein WebSocket durchlässt.

## Inhalt

```
server.js          Server: statische Auslieferung + /api + /ws (nur Node-Standardmodule)
package.json       Startbefehl, keine dependencies
accounts.js        Benutzerkonten (Name + Passwort, keine E-Mail)
public/index.html  das Spiel
public/admin.html  Adminbereich
data/              wird automatisch angelegt: je Raum eine JSON-Datei,
                   config.json (Einstellungen), admin-secret.txt,
                   accounts/ (je Konto <id>.json = Anmeldedaten, <id>.stats.json = Statistik)
```

## Installation über Plesk (netcup Webhosting)

1. Ordner anlegen, z. B. `/httpdocs/letzte-runde/`, und `server.js`, `package.json` sowie `public/` hochladen.
2. Plesk → **Node.js** → *Node.js aktivieren*:
   - **Application Root:** `httpdocs/letzte-runde`
   - **Document Root:** `httpdocs/letzte-runde/public`
   - **Application Startup File:** `server.js`
   - **Application Mode:** `production`
   - Node-Version: 18 oder neuer
3. „NPM install" ist nicht nötig (keine Abhängigkeiten), schadet aber auch nicht.
4. *Restart App*, dann `https://deine-domain.de/letzte-runde/` aufrufen.
5. **HTTPS muss an sein** (Let's Encrypt in Plesk). Ohne `https://` gibt es keine Web-Crypto-API im Browser und das Spiel startet nicht. `http://localhost` geht zum Testen.

Falls Plesk die Document Root nicht separat setzen lässt: einfach Application Root und Document Root gleich auf `httpdocs/letzte-runde` legen — `server.js` liefert `public/index.html` selbst aus.

### Lokal testen

```
node server.js          # dann http://localhost:3000 öffnen
PORT=8080 node server.js
```

## WebSocket

Der Client verbindet sich auf `…/ws?room=CODE` und bekommt jede Änderung sofort gepusht. Kommt keine Verbindung zustande (Proxy blockt das Upgrade), pollt er stattdessen jede Sekunde `…/api?a=state` — das Spiel läuft dann genauso, nur mit bis zu einer Sekunde Verzögerung. Es gibt also nichts zu konfigurieren; wenn WebSockets gehen, werden sie genutzt.

Alle 25 s geht ein Ping an offene Verbindungen, damit Proxys sie nicht wegräumen.

## Adminbereich

`https://deine-domain.de/letzte-runde/admin.html`

Das Secret kommt aus der Umgebungsvariable `ADMIN_SECRET` (in Plesk unter Node.js → *Custom environment variables* setzen). Ist keine gesetzt, erzeugt der Server beim ersten Start eins, legt es in `data/admin-secret.txt` ab und schreibt es ins Log.

Einstellbar (gilt ab der nächsten Hand, laufende Hände behalten ihre Werte):

| Einstellung | Standard |
|---|---|
| Mindest-/Maximalspieler | 3 / 8 |
| Handkarten je Spieler | 2 (1–5 möglich) |
| Chips dürfen anderen weggenommen werden | an |
| Gemeinsamer Tipp vor dem Aufdecken | an |
| Höchster Chip deckt zuerst auf | an (sonst ab Chip 1 aufwärts) |
| Räume löschen nach … Stunden | 48 |

Unter „Konten“: Name, gespeicherte Hände, angemeldete Geräte, zuletzt aktiv. **Passwort zurücksetzen** erzeugt ein Einmal-Passwort (wird nur einmal angezeigt), meldet alle Geräte ab und hebt eine Sperre nach Fehlversuchen auf; die Person setzt danach im Spiel ein eigenes Passwort. Konten lassen sich samt Statistik löschen.

Dazu die Raumliste: Spielerzahl, wie viele gerade online sind, Phase, Hand, letzte Änderung — einzeln oder alle löschbar. Gelöschte Räume werfen offene Clients sofort mit einer Meldung raus.

Unter 3 Spielern geht das verteilte Geben nicht auf (dann kennt der Geber die Karten), deshalb lässt sich „Mindestspieler" zwar auf 2 stellen, der Hinweis bleibt aber bestehen.

## Betrieb

- Chipwechsel laufen über eine einzige atomare Server-Operation (`?a=chip`): alter Chip zurück, neuer Chip belegt, „Set" verworfen — ein Schritt, ein Zeitstempel, eine Push-Nachricht. Der Client zeigt den Zug sofort lokal an und der Server bestätigt ihn danach. Greifen zwei gleichzeitig nach demselben Chip, gewinnt schlicht der, dessen Anfrage zuerst ankommt; danach sehen alle dasselbe Bild.
- Ein Raum ist eine Datei `data/CODE.json` (ca. 30–60 KB), im Speicher gehalten und alle 2 s auf Platte geschrieben. Ein Neustart der App verliert also nichts.
- Räume, die 48 h nicht angefasst wurden, werden stündlich aufgeräumt.
- Aufräumen von Hand: Inhalt von `data/` löschen.

Stellschrauben oben in `server.js` (Abschnitt „Grenzen“): `MAX_BODY` (128 KB je Dokument), `MAX_ROOM` (512 KB je Raum, ein echter Raum hat ~20 KB), 200 Dokumente je Raum, Verschachtelung max. 16 Ebenen, 40 Anfragen/s je IP (Vorrat 240), 30 WebSockets je IP, 20 neue Räume je IP bzw. 120 insgesamt in 10 min, max. 300 Räume. Umgebungsvariable `KR_MEM_MB` (Standard 350): darüber entlädt der Server ruhende Räume und nimmt keine neuen Räume/Dokumente an (503).

### Absturzsicherheit
- Jede Anfrage, jeder Timer und jedes WebSocket-Ereignis ist gekapselt (`guard()`, `fail()`); ein Fehler wird geloggt, der Prozess läuft weiter.
- Beim Beenden (SIGTERM/SIGINT, auch bei unerwartetem Fehler) werden ungespeicherte Räume sofort auf Platte geschrieben.
- Räume ohne Zugriff werden nach 10 min aus dem Speicher genommen (bleiben auf Platte); die öffentliche Raumliste ist 3 s zwischengespeichert.
- Log `logs/app.log`: max. 120 Zeilen/min, ab 5 MB Rotation nach `app.log.1`.
- Client-IP = letzter öffentlicher `X-Forwarded-For`-Eintrag (der erste ist fälschbar). Beim Start steht im Log einmal die `IP-Quelle`.
- Test: `tests/stress.js` (läuft in `tests/run.sh` mit).

## Sicherheit

Die Karten liegen **verschlüsselt** auf dem Server. Das Geben ist auf drei Spieler verteilt: einer mischt und verschlüsselt jede Kartenposition mit zwei Schlüsselhälften, zwei andere verteilen je eine Hälfte an die Spieler. Weder der Server noch ein einzelner Mitspieler kann fremde Handkarten lesen; erst beide Hälften zusammen ergeben eine Karte. Beim Aufdecken werden die Karten gegen das verschlüsselte Deck nachgerechnet, niemand kann beim Zeigen also lügen. Deshalb braucht ihr mindestens 3 Spieler.

**Konten:** Passwörter werden nie gespeichert, nur als scrypt-Hash (N=2^16, r=8, p=2, eigenes Salz) über HMAC-SHA256 mit einem geheimen Server-Pepper – eine gestohlene Kontodatei allein reicht nicht einmal zum Raten. Zusätzlich liegt jede Kontodatei mit AES-256-GCM verschlüsselt in `data/accounts/` (Ordner 700, Dateien 600). Pepper und Dateischlüssel werden per HKDF aus `KR_ACCT_SECRET` abgeleitet (sonst `data/account-secret.txt`); **dieses Geheimnis sichern – ohne es sind alle Konten unlesbar.** Sitzung nur als HttpOnly-Cookie `kr_acct` (Secure, SameSite=Strict), Skripte kommen nicht heran; POSTs nur als JSON und vom eigenen Origin (CSRF); Content-Security-Policy auf der Seite. Wiederherstellungscode (80 Bit) und Sitzungen (256 Bit) nur als SHA-256. Unbekannte Namen rechnen einen Schein-Hash (gleiche Antwortzeit, keine Namensabfrage über die Anmeldung). Allerweltspasswörter und Passwörter mit dem eigenen Namen werden abgelehnt. Bremsen: 5 neue Konten je IP und Stunde (60 insgesamt), nach 10 Fehlversuchen je Name oder 30 je IP 15 Minuten Pause. Passwort ändern meldet andere Geräte ab, Wiederherstellung und Admin-Reset alle. Raum-Hände übernimmt der Server selbst aus der Raumstatistik (nur mit dem Geräteschlüssel eines Mitspielers), Übungsraum-Hände werden geprüft und doppelte verworfen.

Host-Rechte sind abgesichert: Jeder Browser hat einen zufälligen Geräteschlüssel (`kr.sk`), der Server kennt nur dessen Hash. Spieler entfernen und Raum schließen darf nur der Host mit seinem Schlüssel; fremde Spielerplätze lassen sich nur übernehmen, wenn der Spieler mindestens 60 s weg ist – der Host-Platz nie. Zuschauer sehen keine Karten außer den aufgedeckten Tischkarten und lesen den Chat nur mit.

**Tisch-Modus:** Ein großer Bildschirm tritt als „nur Tisch“ bei (Startseite „📺 Als Tisch“ oder `…/?tisch=CODE`, Link steht auch unter „Einladen“). Technisch ist das ein Zuschauer ohne Platz und ohne Chat; die Ansicht zeigt Tisch, freie Chips, Tipp, Aufdecken und Ergebnis groß, die Spieler*innen als Plätze rund um den Tisch (Hochformat: darunter), in der Lobby einen großen QR-Code zum Beitreten. Bildschirm bleibt an (Wake Lock), Vollbild per ⤢. Spieler*innen blenden am Handy mit „📺 Tisch aus“ den Tisch aus (`kr.notable`, nur dieses Gerät).

Nicht abgesichert ist der Rest: wer den Raumcode kennt, kann beitreten, es gibt keine Anmeldung. Für Runden unter Freunden reicht das. Wer mehr will, legt in Plesk einen Verzeichnisschutz auf den Ordner.

Die Spieler-ID liegt im `localStorage` des Browsers. Browser-Speicher gelöscht oder Gerät gewechselt = neuer Spieler, der neu beitreten muss (am besten zwischen zwei Händen).
