# Store-Material (App Store)

| Was | Wo |
|---|---|
| Texte, Kategorie, Review-Notizen (wie hochgeladen) | [metadata/](metadata/) |
| Screenshots iPhone 6,9″ (1320 × 2868) | [screenshots/iphone/](screenshots/iphone/) |
| Screenshots iPad 13″ (2064 × 2752) | [screenshots/ipad/](screenshots/ipad/) |
| Kopfzeile (Produktseite) 5244 × 2950 und 3840 × 1646 | [header/](header/) – Quelle [header.html](header.html), rendern: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --force-device-scale-factor=2 --window-size=2622,1475 --screenshot=$PWD/docs/store/header/kopfzeile-5244x2950.png file://$PWD/docs/store/header.html` (bzw. `--window-size=1920,823` für 3840 × 1646); Upload per Hand (Drag & Drop) |
| Screenshots neu erzeugen | `CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node --experimental-websocket docs/store/storeshots.js` |
| Hochladen (Texte, Kategorie, Review, Screenshots) | `python3 native/ios/Scripts/asc_metadata.py [--no-screenshots]` (pyjwt, cryptography, requests; Schlüssel in `~/.appstoreconnect/`) |
| Datenschutzerklärung | https://gang.aize.eu/impressum.html#datenschutz |
| Support | https://github.com/sgitaize/letzte-runde/issues |
| ASC-App | „Letzte Runde - Kartenspiel“, Apple-ID 6823285737, Bundle `de.sgitaize.letzterunde`, SKU `letzterunde` |

## Build hochladen
```bash
cd native/ios && xcodegen
xcodebuild -project LetzteRunde.xcodeproj -scheme LetzteRunde -configuration Release -destination 'generic/platform=iOS' \
  -archivePath /tmp/LetzteRunde.xcarchive -allowProvisioningUpdates archive
xcodebuild -exportArchive -archivePath /tmp/LetzteRunde.xcarchive -exportOptionsPlist ExportOptions.plist -exportPath /tmp/export -allowProvisioningUpdates
```
ExportOptions: `method app-store-connect`, `destination upload`, `teamID V7GQKCH73F`, automatische Signierung. Die Distribution-Signatur kommt aus der Cloud über die Apple-ID in Xcode – **nicht** mit `-authenticationKey…` (der API-Schlüssel darf das nicht). Vor jedem Upload `CURRENT_PROJECT_VERSION` in `project.yml` erhöhen.

## Per Hand in App Store Connect (API-Schlüssel darf das nicht)

**Preis und Verfügbarkeit:** Kostenlos, alle Länder.

**App-Datenschutz** („Datenerfassung: Ja“; kein Tracking):

| Datentyp | Erfasst wofür | Mit Identität verknüpft | Tracking |
|---|---|---|---|
| Kennungen → Benutzer-ID (Kontoname, Spieler-ID) | App-Funktionalität | Ja | Nein |
| Nutzerinhalte → Gameplay-Inhalte (Statistik der Hände, nur mit Konto) | App-Funktionalität | Ja | Nein |
| Nutzerinhalte → Andere Nutzerinhalte (Chat, Spieler-/Raumnamen, Meldungen) | App-Funktionalität | Nein | Nein |

Nicht erfasst: Kontaktdaten (keine E-Mail), Standort, Fotos/Kamera (QR-Code wird nur auf dem Gerät gelesen), Audio (Voice-Chat läuft direkt zwischen den Geräten, nichts auf dem Server), Diagnose, Kaufdaten, Werbe-Kennungen.

**Altersfreigabe** (per API gesetzt, nur prüfen): überall „Keine“, Chat/Nachrichten = Ja, nutzergenerierte Inhalte = Ja, kein (simuliertes) Glücksspiel – es gibt keine Einsätze, die Chips sind Rangmarken.

**Exportvorschriften:** `ITSAppUsesNonExemptEncryption = NO` steht in der Info.plist (nur Standard-Krypto: TLS, Web Crypto) – keine Frage beim Einreichen.

## Bekannte Review-Fragen (Antworten stehen in den Review-Notizen)
- **4.2 Mindestfunktion / Web-Wrapper:** Spiel, Bots und verschlüsseltes Geben laufen im Gerät (eingebettetes Node.js), Singleplayer offline, WLAN-Host ohne Internet, Bonjour, QR-Scanner, Haptik.
- **1.2 Nutzerinhalte:** Wortfilter (Server), Melden (⋯ → Melden, landet im Admin unter „Meldungen“), Stummschalten (dauerhaft auf dem Gerät), Host entfernt Spieler, Kontakt kontakt@simongutjahr.de. Zusage im Review-Text: Meldungen werden **innerhalb von 24 Stunden** bearbeitet → Admin-Seite regelmäßig ansehen.
- **5.1.1(v) Konto löschen:** Konto & Statistik → Konto verwalten → Konto löschen.
- **Glücksspiel:** keine Einsätze, kein Echtgeld, keine Käufe (steht in Beschreibung und Review-Notizen).
