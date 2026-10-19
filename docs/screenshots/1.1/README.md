# Letzte Runde 1.1 – neue Funktionen im Bild

Erzeugt mit `node --experimental-websocket tests/shot-features.js docs/screenshots/1.1` (Chromium, iPhone-Größe 390 × 844 @2x, Tisch und Admin am Tablet bzw. PC). Echter Server mit signiertem Spiel-Bundle (Spiellogik 3) und echter App-Host wie in der iOS-/Android-App; die App selbst ist hier eine Browser-Seite auf dem App-Host.

## Spiellogik nachladen (App, #11)

| | |
|---|---|
| ![](01-app-update-dialog.png) | **01** Beim Start: „Neue Spiellogik“ mit Größe, „Jetzt laden“ / „Später“ |
| ![](02-app-update-banner.png) | **02** Weggeklickt: Hinweis bleibt oben auf der Startseite |
| ![](03-app-nach-update-fusszeile.png) | **03** Nach dem Laden (Seite startet neu): Fußzeile „Spiellogik 3 (nachgeladen · zurücksetzen) · Build …“ |
| ![](04-app-online-raum-mit-alter-logik.png) | **04** Admin verlangt eine Spiellogik, die es noch nicht als Bundle gibt: roter Hinweis, Singleplayer/WLAN gehen weiter (Android-Text) |
| ![](23-admin-spiellogik-spendenlink.png) | **23** Admin: Spendenlink, Mindest-Spiellogik, Bundle-Stand, „Update für Online-Räume erzwingen“ |

## Raum

| | |
|---|---|
| ![](05-start-privat-und-unterstuetzen.png) | **05** Startseite: Haken „🔒 Privat“ beim Erstellen (#10) |
| ![](06-raum-lobby-naechster-schritt.png) | **06** Lobby mit Leiste „Nächster Schritt“ (#6) |
| ![](07-raum-privat-einladen.png) | **07** Einladen: Raum ist privat, Host kann umschalten (#10) |
| ![](08-raum-naechster-schritt-chip.png) | **08** Runde 1: „Nimm einen Chip“ mit Sprungknopf |
| ![](09-raum-sprung-zu-den-chips.png) | **09** Nach dem Sprung: Chips hervorgehoben |
| ![](10-raum-naechster-schritt-bereit.png) | **10** Chip genommen: „Bereit“ direkt in der Leiste |
| ![](11-raum-tipp-vorschlaege-bots.png) | **11** Tipp: Vorschläge je Person, auch der Bots, „übernehmen“ (#4) |
| ![](12-raum-tipp-naechster-schritt.png) | **12** Tipp: Leiste „Tipp bestätigen“ |
| ![](13-tisch-tipp-vorschlaege.png) | **13** Tisch-Bildschirm: Vorschläge live (#4) |
| ![](14-raum-ergebnis-server.png) | **14** Ergebnis – vom Server verbindlich ausgewertet (#11) |
| ![](15-raum-tisch-knopf.png) | **15** Tisch ausgeblendet: Knopf zeigt jetzt „📺 Tisch aus“ (#9) |
| ![](16-start-du-bist-hier.png) | **16** Offene Räume: „📍 Du bist hier“ (#3), Unterstützen-Knopf |
| ![](17-unterstuetzen-web.png) | **17** Unterstützen im Browser/Android: drei Stufen (iOS: In-App-Trinkgeld) |

## Singleplayer und Konto

| | |
|---|---|
| ![](18-singleplayer-naechster-schritt.png) | **18** Singleplayer mit Leiste „Nächster Schritt“ |
| ![](19-singleplayer-bot-vorschlaege.png) | **19** Bots schlagen vor, was der höchste Chip hat („Mein Tipp: …“) |
| ![](20-konto-statistik.png) | **20** Konto-Seite neu: Kopf mit Überblick, Tabs (#5) |
| ![](21-konto-plaetze.png) | **21** Plätze aus allen Geräten |
| ![](22-konto-einstellungen.png) | **22** Konto: Passwort, Wiederherstellungscode, Löschen getrennt |

## Spielerliste (fester Aufbau)

Oben Chip · Name · Knöpfe, darunter immer die Karten mit Handname und Ergebnis – unabhängig von Namenslänge und Bildschirmbreite (vorher rutschten die Karten mal neben, mal unter den Namen).

| iPhone 18 Pro (402 pt), Runde 4 | iPhone 18 Pro Max (440 pt), aufgedeckt | Tablet quer |
|---|---|---|
| ![](spielerliste/play-402.png) | ![](spielerliste/done-440.png) | ![](spielerliste/done-1180.png) |
