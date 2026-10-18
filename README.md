# Letzte Runde

Kooperatives Pokerkarten-Spiel für den Browser – inspiriert von „The Gang“. Alle spielen **zusammen**: Jede Runde nimmt sich jeder einen Chip von 1 (schwächste Hand) bis n (stärkste Hand). Am Ende wird aufgedeckt – stimmt die Reihenfolge, hat die Gruppe gewonnen.

Live: **[letzterunde.aize-it.de](https://letzterunde.aize-it.de)** (früher gang.aize.eu, leitet weiter) · Spielen ohne Anmeldung, auf Handy, Tablet und PC, als App installierbar.

<p>
  <img src="docs/uebungsraum-ipad.png" alt="Singleplayer im Querformat auf dem iPad" width="620">
  <img src="docs/raum-handy.png" alt="Raum auf dem Handy" width="200">
</p>

## Funktionen

- **Räume mit Code und Link** – öffentlich unter „Offene Räume“ oder privat (nur mit Code/Link), der eigene Raum ist dort mit „📍 Du bist hier“ markiert; Einladung per Link/QR-Code mit Vorschau in WhatsApp & Co., Raumnamen, geplante Räume mit Startzeit (Zeitzone des Planenden), Zuschauen, Einspringen für Spieler, die offline gegangen sind
- **Tisch-Modus für den großen Bildschirm** – ein PC, Fernseher oder Monitor tritt mit „📺 Als Tisch“ (oder Link `…/?tisch=CODE`) bei und zeigt Tisch, Chips in der Mitte und alle Spieler*innen rund um den Tisch groß an; am Handy lässt sich der Tisch dann mit dem Knopf „🃏 Tisch an“ ausblenden (nur Hand, Chips, Insight)
- **Nächster Schritt** – eine Leiste unten sagt in jeder Phase, was gerade zu tun ist („Nimm einen Chip“, „Bereit klopfen“, „Tipp bestätigen“, „Aufdecken“), springt per Knopf zur Stelle oder erledigt einfache Schritte direkt
- **Ablauf wie am Tisch** – 4 Runden (Hand, Flop, Turn, River), Chips aus der Mitte oder von anderen nehmen, „👊 Bereit“ und 3-2-1-Countdown, gemeinsamer Tipp auf die Karten des höchsten Chips – mit Vorschlägen je Spieler*in (auch der Bots), live für alle und am Tisch-Bildschirm, mit einem Tipp übernehmbar –, Aufdecken mit 10-s-Countdown
- **Hausregeln** – eine Kombination zählt nur, wenn die eigenen Karten sie verbessern (ein Paar nur auf dem Tisch zählt nicht); liegt auf dem Tisch schon mehr (z. B. eine Straße), zählt die beste eigene Kombination; Flush und Straße nach der eigenen höchsten Karte benannt
- **Bots** – Singleplayer allein gegen 2–5 Bots (läuft komplett im Browser, auch **offline**) und Bots zum Auffüllen echter Räume. Bots schätzen ihre Hand per Monte-Carlo-Simulation, verhandeln um Chips und merken sich Absprachen über die Runden
- **Lernmodus** im Singleplayer – zeigt, was die eigene Hand wert ist, welcher Chip passt und nach der Hand, warum etwas anders gehört
- **Statistik** – Quote, Serien, „fast richtig“ (Reihenfolge stimmt, Tipp teilweise getroffen – zählt halb, ohne Feier-Animation), Tipp-Treffer, Treffsicherheit je Runde; ausklappbar „Nutzung & Erfolgsrate“: Spieltage, Hände nach Wochentag und Tageszeit, Anteil richtiger Reihenfolge und richtiger eigener Hand je Tag
- **Konten (freiwillig)** – nur Name + Passwort, keine E-Mail; Statistik aus Übungsraum und Räumen liegt im Konto und ist auf jedem Gerät da. Freunde per Freundescode/Link oder direkt im Raum (👥+ neben angemeldeten Mitspielenden, mit Bestätigung) und Bestenliste unter Freunden (7 Tage/insgesamt, Übung/Räume). Passwort vergessen: einmaliger Wiederherstellungscode (bei der Registrierung angezeigt) oder Zurücksetzen durch Admins
- **Spiellogik nachladen (Apps)** – Wertung, Bots und Oberfläche lassen sich ohne Store-Release aktualisieren: der Server bietet ein signiertes Bundle an, die App zeigt es beim Start, lädt nur geänderte Dateien und spielt danach damit – auch offline und im WLAN. Das mit dem Release eingebaute Spiel läuft immer ohne Server. Im Admin lässt sich für Online-Räume eine Mindestversion verlangen
- **Verbindliche Auswertung** – der Server rechnet jede fertige Hand selbst nach (aufgedeckte Karten entschlüsselt) und legt das Ergebnis für alle in den Raum; die Statistik hängt nicht mehr von der Version des meldenden Geräts ab
- **Unterstützen** – „💛 Unterstützen“ auf der Startseite: im Browser und in der Android-App drei Beträge über den Spendenlink aus dem Admin, in der iOS-App Trinkgeld per In-App-Kauf
- **Extras** – Chat mit Ton, schnelle Reaktionen (👍 😂 😬 🤔 🔥), optionaler Voice-Chat (WebRTC, direkt zwischen den Geräten, mit Einwilligung), Hell/Dunkel, Querformat-Layout für Tablets

## Fair und sicher

- **Kein Server kennt die Karten.** Das Geben ist auf drei Spieler verteilt (Mischen, Verteilen A, Verteilen B; ECDH P-256 + AES-GCM im Browser). Keine Rolle allein kann eine fremde Karte lesen; aufgedeckte Karten prüft jeder Browser selbst nach. Bots übernehmen nur Rollen, wenn weniger als drei Menschen spielen.
- **Rechte serverseitig geprüft** – Geräteschlüssel je Spieler, Host-Rechte, keine fremden Plätze oder Chips.
- **Absturzsicher** – Größen- und Tiefengrenzen für Eingaben, Anfragebremse je IP, WebSocket-Grenzen, Speicherbremse, Log-Rotation.
- **Datensparsam** – keine Cookies, kein Tracking; Räume werden nach 48 Stunden ohne Aktivität gelöscht.

## Starten

Voraussetzung: **Node.js ≥ 18**. Keine Abhängigkeiten, kein Build.

```bash
cd app
node server.js            # http://localhost:3000
```

| Umgebungsvariable | Bedeutung |
|---|---|
| `PORT` | Port (Standard 3000) |
| `ADMIN_SECRET` | Passwort für `/admin.html`; ohne Angabe wird eines erzeugt und in `app/data/admin-secret.txt` abgelegt |
| `KR_ACCT_SECRET` | Geheimnis (mind. 32 Zeichen) für Passwort-Pepper und Verschlüsselung der Konten; ohne Angabe wird eines in `app/data/account-secret.txt` erzeugt. **Sichern** – ohne dieses Geheimnis sind alle Konten unlesbar |
| `KR_MEM_MB` | Speichergrenze in MB, ab der keine neuen Räume angenommen werden (Standard 350) |

Einstellungen wie Spielerzahl, Handkarten, Tipp und Voice-Chat stehen im Admin-Bereich (`/admin.html`).

**Hosting:** Läuft z. B. unter Plesk/Phusion Passenger (Application Root `app/`, Document Root `app/public/`, Startdatei `server.js`). Für WebSockets den nginx-Proxy-Modus ausschalten; ohne WebSockets fällt das Spiel automatisch auf Abfragen im Sekundentakt zurück. `deploy.sh` ist ein Beispiel für ein Deployment per FTPS (Zugangsdaten aus einer lokalen `.env`, nicht im Repo).

## Aufbau

```
app/
  server.js        HTTP + WebSocket, Räume als JSON-Dateien, Rechteprüfung, Grenzen
  resolve.js       verbindliche Auswertung fertiger Hände (entschlüsselt die aufgedeckten Karten)
  bots.js          Bots im Mehrspieler-Raum (serverseitig)
  app-host.js      Host in der iOS-/Android-App (Proxy, WLAN-Host, Spiellogik nachladen)
  bundle-manifest.js  Dateiliste, Prüfsummen und Signatur des Spiel-Bundles
  scripts/bundle.js   Schlüssel erzeugen, Bundle bauen/signieren/prüfen (deploy.sh ruft „build“)
  accounts.js      Benutzerkonten (scrypt-Passwörter, Wiederherstellungscode, Statistik je Konto)
  public/
    index.html     das komplette Spiel (UI, Protokoll, Singleplayer, Lernmodus)
    hand.js        Handbewertung, Auswertung (resolve), LOGIC_VERSION, Monte-Carlo – gemeinsam für Browser und Server
    sw.js          Service Worker (Singleplayer offline)
    admin.html     Admin-Bereich
tests/             End-to-End-, Angriffs-, Bot-, Voice- und Offline-Tests
design/            Logo-Quellen (SVG)
```

## Tests

```bash
tests/run.sh
```

Startet alle Testreihen parallel (je eigener Server) und gibt je Reihe eine Zeile aus; Details landen in `/tmp/kr-tests/`. Enthalten sind komplette Hände mit simulierten Browsern, Angriffe auf den Server, Bots in echten Räumen, Singleplayer und Lernmodus, die Server-Auswertung, das Nachladen der Spiellogik in der App sowie Voice-Chat und Offline-Modus in echtem Chromium (übersprungen, wenn `chromium` fehlt). `tests/shot.js` erstellt Screenshots in mehreren Bildschirmgrößen, `tests/shot-features.js` Bilder der neuen Funktionen (liegen in [docs/screenshots/1.1/](docs/screenshots/1.1/)).

## Spiellogik für die Apps nachladen

Einmalig: `node app/scripts/bundle.js keygen` – der private Schlüssel landet in `~/.letzte-runde/bundle-key.pem` (sichern, nie ins Repo; auf dem Deploy-Rechner als `KR_BUNDLE_KEY` in `.env`), der öffentliche in `app/bundle-key.pub` (committen, **vor** dem App-Build – ohne ihn laden die Apps keine Updates, spielen aber normal).
Danach bei jedem `./deploy.sh`: Bundle bauen, signieren, hochladen; die Apps bieten es beim nächsten Start an. Bei einer Regeländerung `LOGIC_VERSION` in `hand.js` erhöhen; im Admin lässt sich dann „Update für Online-Räume erzwingen“.

## Lizenz

[MIT](LICENSE) © 2026 Simon Gutjahr. Enthält den [QR Code Generator](https://github.com/kazuhikoarase/qrcode-generator) von Kazuhiko Arase (MIT).

„The Gang“ ist ein Spiel von Kosmos; dieses Projekt ist eine unabhängige, nicht-kommerzielle Umsetzung und steht in keiner Verbindung dazu.
