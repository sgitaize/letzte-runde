# Letzte Runde als App (iOS + Android)

Stand: 15.10.2026. Vorgaben von Simon:

- Das Spiel läuft vollständig lokal auf dem Gerät.
- gang.aize.eu ist nur für Online-Multiplayer (Web, PWA und App gemischt) und für Konten/Statistik da.
- Nur die App kann einen Server im WLAN hosten, für Orte ohne Internet. Mitspieler im Browser ohne App müssen dort mitspielen können.
- Statistik aus Offline- und LAN-Spielen wird später hochgeladen, nur mit Login und Opt-in.
- Oberfläche: „Variante B“. Die Spieloberfläche ist der vorhandene Web-Code, offline in der App. Alles drumherum ist nativ. Kein Kompromiss bei der App-Qualität.

## Bausteine

```
┌──────────────── App (Swift / Kotlin) ────────────────┐
│ WKWebView / WebView  ← index.html, hand.js … (Bundle) │
│        │ http://127.0.0.1:<port>  (Secure Context)    │
│        ▼                                              │
│ eingebettetes Node (nodejs-mobile 18.20.4)            │
│   server.js unverändert + app-host.js                 │
│     · Übungsraum / Bots lokal                         │
│     · LAN-Host: Räume für WLAN-Geräte (0.0.0.0)       │
│     · Online: /api, /ws → Proxy zu gang.aize.eu       │
│ Nativ: Bonjour (_letzterunde._tcp), QR, Teilen,       │
│   Haptik, Wake Lock, Hintergrund-Hinweis, Konto-Sync, │
│   Spendenknopf, Mitteilungen bei Raum-Start           │
└───────────────────────────────────────────────────────┘
```

**Warum Node eingebettet und nicht neu in Swift/Kotlin:**
- server.js, bots.js und accounts.js haben zusammen ~2.400 Zeilen. Sie enthalten die Rechteprüfung, das Krypto-Geben und die Bots.
- Ein zweiter oder dritter Nachbau würde auseinanderlaufen. Dann könnten Web, App und LAN-Host nicht mehr garantiert miteinander spielen.
- nodejs-mobile ist auf iOS (JIT-los) und Android erprobt (z. B. Manyverse im App Store) und vergrößert die App um ~25–35 MB.

**Warum 127.0.0.1:**
- localhost gilt als Secure Context, dadurch laufen `crypto.subtle` und WebSocket wie im Web.
- Der Client bleibt unverändert, denn API und WS laufen relativ zur Seite.

## Modi

| Modus | Wer spielt | Server |
|---|---|---|
| Übungsraum | allein + Bots | keiner (läuft im Client, wie offline-PWA) |
| Online | App, Web, PWA gemischt | gang.aize.eu; der lokale Node leitet `/api`, `/ws` und `/r/` weiter. Das Konto-Cookie liegt auf localhost, der Proxy setzt es serverseitig weiter. Einladungslinks zeigen auf gang.aize.eu |
| LAN-Host | App hostet, Gäste per QR (Browser oder App) | eingebettetes server.js auf `0.0.0.0:<port>`, Daten im App-Speicher |
| LAN-Gast (App) | App tritt einem LAN-Host bei | Bonjour-Suche oder QR, WebView lädt vom Host |

## LAN ohne Internet: HTTPS und Krypto

Im Browser laufen `crypto.subtle` und Service Worker nur in einem Secure Context. Ohne Internet gibt es aber kein öffentlich vertrauenswürdiges Zertifikat:

- Kein DNS.
- Eine Wildcard-Domain auf private IPs würde verlangen, den privaten Schlüssel mit der App auszuliefern. Das verbietet die CA, und das Zertifikat würde gesperrt.

Lösung, zweistufig:

1. **HTTPS mit eigenem Zertifikat:**
   - Die App erzeugt beim ersten Hosten ein eigenes Zertifikat (P-256, im Schlüsselbund bzw. Keystore).
   - Der Fingerabdruck steht neben dem QR-Code.
   - Gäste bestätigen die Browserwarnung einmal und haben dann einen Secure Context.
2. **Ohne Bestätigung:**
   - Für `http://` liefert der LAN-Host einen kleinen, geprüften JS-Fallback für ECDH P-256 und AES-GCM mit (z. B. @noble/curves und @noble/ciphers, gebündelt, ohne Netz).
   - `index.html` nutzt ihn nur, wenn `crypto.subtle` fehlt.
   - Der QR-Code zeigt standardmäßig auf diese Variante, damit Mitspieler sofort drin sind.
   - Das Geben bleibt gleich sicher, denn kein einzelner Teilnehmer kann fremde Karten lesen.

## Statistik-Sync (Opt-in)

- Hände aus dem Übungsraum und aus LAN-Räumen landen lokal in einer Warteschlange (`acct.queue`).
- Mit Anmeldung und eingeschaltetem „Statistik ins Konto übertragen“ lädt die App die Warteschlange beim nächsten Online-Kontakt über die bestehenden Endpunkte hoch: `acct.sphand`, für LAN-Räume ein neuer Endpunkt `acct.lanhand`.
- Dubletten werden über ts + Hand erkannt, wie im Web.
- LAN-Hände sind serverseitig nicht prüfbar. Sie werden als „lokal“ markiert und in der Bestenliste getrennt ausweisbar.

## Plattformen

- iOS 17+:
  - SwiftUI-Hülle, XcodeGen, Bundle `de.aize.letzterunde`.
  - Local-Network-Berechtigung (`NSLocalNetworkUsageDescription`, `NSBonjourServices`).
  - Kein ATS-Loch außer localhost und dem LAN.
- Android 8+:
  - Kotlin-Hülle, APK signiert mit eigenem Schlüssel (nicht im Repo).
  - Download über simongutjahr.de.
  - Prüfsumme und Update-Hinweis in der App (über eine Versionsdatei auf der Website).
- Gemeinsam:
  - `app/public` wird beim Build gebündelt.
  - `app-host.js` startet server.js mit `KR_MODE=app|lan` (Pfade, Grenzen, Proxy).

## Reihenfolge

1. `app-host.js` + Proxy-Modus + JS-Krypto-Fallback in kartenrunde (testbar auf dem VPS).
2. iOS-Hülle: WebView auf eingebettetem Node, Übungsraum offline, Online über Proxy.
3. LAN-Host + Bonjour + QR, Test mit Browser-Gast.
4. Statistik-Warteschlange + Opt-in.
5. Android-Hülle (Build auf dem VPS), APK-Download auf simongutjahr.de.
6. Store-Material, Datenschutz, Spendenknopf.
